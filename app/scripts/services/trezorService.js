/*global angular*/

angular.module('webwalletApp')
  .service('trezorService', function TrezorService(
    utils, config, storage, flash,
    trezor, trezorApi, trezorError, firmwareService, TrezorDevice,
    _, $modal, $q, $location, $rootScope) {

    'use strict';

    if (trezorError) {
      $rootScope.error = trezorError;
      return;
    }

    var self = this,
        STORAGE_DEVICES = 'trezorServiceDevices',
        STORAGE_VERSION = 'trezorStorageVersion';

    var enumeratePaused = false,
        connectFn = connect,
        disconnectFn = disconnect;

    self.devices = deserialize(restore()); // the list of available devices
    self.devices.forEach(function (dev) { dev.subscribe(); });

    self._forgetInProgress = false;
    self._forgetModal = false;

    storeWhenChanged();
    watchDevices(1000);

    if (trezor instanceof trezorApi.PluginTransport) {
      $rootScope.deprecatePlugin = config.deprecatePlugin;
      $rootScope.usingPluginTransport = true;
      $rootScope.installers = trezorApi.installers();
      $rootScope.installers.forEach(function (inst) {
        if (inst.preferred)
          $rootScope.selectedInstaller = inst;
      });
    }

    //
    // public
    //

    // find a device by id
    self.get = function (id) {
      return _.find(self.devices, { id: id });
    };

    /**
     * Get the default device
     *
     * That is currently the first device.
     */
    self.getDefaultDevice = function () {
      return self.devices[0];
    };

    // remove device from the dev list and storage
    self.forget = function (dev) {
      dev.disconnect();
      dev.unsubscribe();
      _.remove(self.devices, { id: dev.id });
    };

    self.isForgetInProgress = function () {
      return self._forgetInProgress === true;
    };

    self.setForgetInProgress = function (forgetInProgress) {
      self._forgetInProgress = forgetInProgress;
    };

    self.getForgetModal = function () {
      return self._forgetModal;
    };

    self.setForgetModal = function (forgetModal) {
      self._forgetModal = forgetModal;
    };

    //
    // private
    //

    // serialize a device list
    function serialize(devices) {
      return devices.map(function (dev) {
        return dev.serialize();
      });
    }

    // deserialize a device list
    function deserialize(data) {
      return data.map(function (item) {
        return TrezorDevice.deserialize(item);
      });
    }

    // takes serialized device list, puts it to storage
    function store(data) {
      storage[STORAGE_DEVICES] = JSON.stringify(data);
      storage[STORAGE_VERSION] = config.storageVersion;
    }

    // loads a serialized device list from storage
    function restore() {
      var devices = storage[STORAGE_DEVICES],
          version = storage[STORAGE_VERSION];

      if (devices && version === config.storageVersion)
        return JSON.parse(devices);
      else
        return [];
    }

    // watches the device list and persist it to storage on change
    function storeWhenChanged() {
      $rootScope.$watch(
        function () {
          return serialize(self.devices);
        },
        function (data) {
          store(data);
        },
        true // deep compare
      );
    }

    /**
     * Start auto-updating the device list.
     *
     * Broadcast event `device.connect(devId)` or `device.disconnect(devId)`
     * everytime a device is connected / disconnected.  We pass only ID of the
     * Device and not the whole Device object as a param to these events on
     * purpose, because if we pass the Device object it gets spoiled by
     * Angular.js and it needs to be retreived from `TrezorService#get()`
     * anyway.
     *
     * @param {Number} n  Polling period in miliseconds
     */
    function watchDevices(n) {
      var tick = utils.tick(n),
          desc = progressWithConnected(tick),
          delta = progressWithDescriptorDelta(desc);

      // handle added/removed devices
      delta.then(null, null, function (dd) {
        if (!dd || (!dd.added.length && !dd.removed.length))
          return;
        $rootScope.$apply(function () {
          dd.added.forEach(function (device) {
            $rootScope.$broadcast('device.connect', device.id);
            connectFn(device);
          });
          dd.removed.forEach(function (device) {
            $rootScope.$broadcast('device.disconnect', device.id);
            disconnectFn(device);
          });
        });
      });

      return tick;
    }

    // marks the device of the given descriptor as connected and starting the
    // correct workflow
    function connect(desc) {
      var dev,
          id;

      id = desc.id || desc.serialNumber;
      if (id) {
        dev = _.find(self.devices, { id: id });
        if (!dev) {
          dev = new TrezorDevice(id);
          self.devices.push(dev);
        }
      } else
        dev = new TrezorDevice(desc.path);

      dev.withLoading(function () {
        return trezor.acquire(desc)
          .then(function (res) {
            var sessionId = res.session,
                session = new trezorApi.Session(trezor, sessionId);
            dev.connect(session);
            setupCallbacks(dev);
            resetOutdatedFirmwareBar(dev);
            return dev.initializeDevice();
          })
          .then(
            function (features) {
              navigateTo(dev);
              return features.bootloader_mode
                ? bootloaderWorkflow(dev)
                : normalWorkflow(dev);
            },
            function (err) {
              dev.disconnect();
              throw err;
            }
          )
          .catch(function (err) {
            flash.error(err.message || 'Loading device failed');
          });
      });
    }

    // marks a device of the given descriptor as disconnected
    function disconnect(desc) {
      var dev,
          id;

      id = desc.serialNumber || desc.id;
      if (id) {
        dev = _.find(self.devices, { id: id });
        if (dev)
          dev.disconnect();
        resetOutdatedFirmwareBar(desc);
      }
    }

    //
    // normal workflow
    //

    function navigateTo(dev) {
      var path = '/device/' + dev.id;

      if ($location.path().indexOf(path) !== 0)
        $location.path(path);
    }

    function normalWorkflow(dev) {
      return firmwareService.check(dev.features)
        .then(function (firmware) {
          if (!firmware)
            return;
          return outdatedFirmware(
            firmware,
            firmwareService.get(dev.features),
            dev
          );
        })
        .then(function () { return dev.initializeAccounts(); })
        .then(function () {
          navigateTo(dev);
        });
    }

    function setupCallbacks(dev) {
      setupEnumerationPausing(dev);
      setupEventForwarding(dev);
    }

    function setupEnumerationPausing(dev) {
      dev.on('send', function () { enumeratePaused = true; });
      dev.on('error', function () { enumeratePaused = false; });
      dev.on('receive', function () { enumeratePaused = false; });
    }

    function setupEventForwarding(dev) {
      ['pin', 'passphrase', 'button', 'word', 'send', 'error', 'receive']
        .forEach(function (type) {
          forwardEventsOfType($rootScope, dev, type);
        });
    }

    function forwardEventsOfType(scope, dev, type) {
      dev.on(type, function () {
        var args = [].slice.call(arguments);
        args.unshift(dev);
        args.unshift('device.' + type);
        scope.$broadcast.apply(scope, args);
      });
    }

    function outdatedFirmware(firmware, version, dev) {
      if (firmware.required)
        return outdatedFirmwareModal(firmware, version);
      else
        return outdatedFirmwareBar(firmware, version, dev);
    }

    function outdatedFirmwareBar(firmware, version, dev) {
      $rootScope.optionalFirmware = {
        device: dev,
        firmware: firmware,
        version: version,
        update: function () {
          outdatedFirmwareModal(firmware, version);
        }
      };
    }

    function resetOutdatedFirmwareBar(dev) {
      if ($rootScope.optionalFirmware &&
          $rootScope.optionalFirmware.device.id === dev.id) {
        delete $rootScope.optionalFirmware;
      }
    }

    function outdatedFirmwareModal(firmware, version) {
      var scope, modal;

      scope = angular.extend($rootScope.$new(), {
        state: 'initial',
        firmware: firmware,
        version: version,
        device: null,
        update: function () {
          updateFirmware(scope, firmware);
        }
      });

      modal = $modal.open({
        templateUrl: 'views/modal/firmware.html',
        backdrop: 'static',
        keyboard: false,
        scope: scope
      });

      modal.opened.then(function () {
        connectFn = myConnect;
        disconnectFn = myDisconnect;
      });
      modal.result.finally(function () {
        connectFn = connect;
        disconnectFn = disconnect;
      });

      return modal.result;

      function myConnect(desc) {
        var dev = new TrezorDevice(desc.path);

        dev.connect(desc);
        setupCallbacks(dev);
        dev.initializeDevice().then(
          function (features) {
            scope.state = features.bootloader_mode ?
              'device-bootloader' :
              'device-normal';
            scope.device = dev;
          },
          function () { dev.disconnect(); }
        );
      }

      function myDisconnect(desc) {
        if (!scope.device || scope.device.id !== desc.path) {
          disconnect(desc);
          return;
        }
        scope.device.disconnect();
        scope.device = null;

        if (scope.state === 'update-success' || scope.state === 'update-error') {
          modal.close();
          return;
        }
        scope.state = 'initial';
      }
    }

    //
    // booloader workflow
    //

    function bootloaderWorkflow(dev) {
      return firmwareService.latest().then(function (firmware) {
        return candidateFirmware(firmware, dev);
      });
    }

    function candidateFirmware(firmware, dev) {
      var scope, modal;

      scope = angular.extend($rootScope.$new(), {
        state: 'device-bootloader',
        firmware: firmware,
        device: dev,
        update: function () {
          updateFirmware(scope, firmware);
        }
      });

      modal = $modal.open({
        templateUrl: 'views/modal/firmware.html',
        backdrop: 'static',
        keyboard: false,
        scope: scope
      });

      modal.opened.then(function () { disconnectFn = myDisconnect; });
      modal.result.finally(function () { disconnectFn = disconnect; });

      return modal.result;

      function myDisconnect(desc) {
        if (desc && desc.path !== dev.id) {
          disconnect(desc);
          return;
        }
        dev.disconnect();
        modal.close();
      }
    }

    //
    // utils
    //

    function updateFirmware(scope, firmware) {
      var deregister;

      scope.firmware = firmware;
      scope.state = 'update-downloading';

      firmwareService.download(firmware)
        .then(function (data) {
          deregister = $rootScope.$on('device.button', promptButton);
          scope.state = 'update-flashing';
          return scope.device.flash(data);
        })
        .then(
          function () {
            scope.state = 'update-success';
            deregister();
          },
          function (err) {
            scope.state = 'update-error';
            scope.error = err.message;
            deregister();
          }
        );

      function promptButton(event, dev, code) {
        if (code === 'ButtonRequest_FirmwareCheck')
          scope.state = 'update-check';
      }
    }

    // maps a promise notifications with connected device descriptors
    function progressWithConnected(pr) {
      var res = $q.defer(),
          inProgress = false;

      pr.then(null, null, function () {
        if (enumeratePaused || inProgress)
          return;

        inProgress = true;
        trezor.enumerate()
          .then(function (devices) { res.notify(devices); })
          .then(
            function () { inProgress = false; },
            function () { inProgress = false; }
          );
      });

      return res.promise;
    }

    // maps a promise notifications with a delta between the current and
    // previous device descriptors
    function progressWithDescriptorDelta(pr) {
      var prev = [],
          tmp;

      return pr.then(null, null, function (curr) {
        if (!curr)
          return;
        tmp = prev;
        prev = curr;
        return descriptorDelta(tmp, curr);
      });
    }

    // computes added and removed device descriptors in current tick
    function descriptorDelta(xs, ys) {
      return {
        added: _.filter(ys, function (y) { return !_.find(xs, { id: y.id }); }),
        removed: _.filter(xs, function (x) { return !_.find(ys, { id: x.id }); })
      };
    }

  });
