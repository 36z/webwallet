/*global angular, utils, _*/

(function (angular, utils, _) {
    'use strict';

    /**
     * Device list
     */
    function DeviceList () {
        // Initialize the device storage
        this._storage = new DeviceStorage({
            type: TrezorDevice,
            version: config.storageVersion
            keyItems: this.STORAGE_DEVICES,
            keyVersion: this.STORAGE_VERSION
        });

        // Load devices from the storage
        this._devices = this._storage.init();

        // Initialize all devices
        this._devices.forEach(function (dev) {
            dev.init();
        });

        // Watch for newly connected and disconnected devices
        this._watch(this.POLLING_PERIOD);
    }

    DeviceList.prototype.STORAGE_DEVICES = 'trezorServiceDeviceList',
    DeviceList.prototype.STORAGE_VERSION = 'trezorStorageVersion';
    DeviceList.prototype.POLLING_PERIOD = 1000;

    DeviceList.prototype._devices = null;

    DeviceList.prototype._enumeratePaused = false;
    DeviceList.prototype._connectFn = connect;
    DeviceList.prototype._disconnectFn = disconnect;

    DeviceList.prototype._forgetInProgress = false;
    DeviceList.prototype._forgetModal = false;

    /**
     * Find a device by its ID
     *
     * @param {String} id  Device ID
     * @return {TrezorDevice}  Device
     */
    DeviceList.prototype.get = function (id) {
        return _.find(self.devices, { id: id });
    };

    /**
     * Get the default device
     *
     * That is currently the first device.
     *
     * @return {TrezorDevice}  Default device
     */
    DeviceList.prototype.getDefault = function () {
        return self.devices[0];
    };

    /**
     * Alias for DeviceList#getDefault()
     *
     * @deprecated
     */
    DeviceList.prototype.getDefaultDevice = DeviceList.prototype.getDefault;

    /**
     * Remove a device from the device list (and subsequently from the storage)
     *
     * @param {TrezorDevice} dev  Device to remove
     */
    DeviceList.prototype.forget = function (dev) {
        dev.destroy();
        _.remove(self.devices, { id: dev.id });
    };

    /**
     * Start auto-updating the device list -- watch for newly connected
     * and disconnected devices.
     *
     * Broadcast event `device.connect(devId)` or `device.disconnect(devId)`
     * everytime a device is connected / disconnected.  We pass only ID of the
     * Device and not the whole Device object as a param to these events on
     * purpose, because if we pass the Device object it gets spoiled by
     * Angular.js and it needs to be retreived from `TrezorService#get()`
     * anyway.
     *
     * @param {Number} n  Polling period in miliseconds
     * @return {Promise}  Ticking Promise
     */
    DeviceList.prototype._watch = function (n) {
        var tick = utils.tick(n),
            delta = this._progressWithDescriptorDelta(
                this._progressWithConnected(tick)
            );

        delta.then(null, null, function (dd) {
            if (!dd) {
                return;
            }
            dd.added.forEach(function (device) {
                $rootScope.$broadcast('device.connect', device.id);
                connectFn(device);
            });
            dd.removed.forEach(function (device) {
                $rootScope.$broadcast('device.disconnect', device.id);
                disconnectFn(device);
            });
        });

        return tick;
    };

    /**
     * Maps a promise notifications with connected device descriptors
     *
     * Expects a Promise as an argument and returns a new Promise.  Each time
     * passed Promise is fulfilled, the returned Promise is fulfilled aswell
     * with a list of devices as a result.
     *
     * Passed Promise is expected to tick -- get periodically fulfilled over
     * and over again.
     *
     * @see DeviceList#_progressWithDescriptorDelta()
     *
     * @param {Promise} pr  Promise expected to tick
     * @return {Promise}  Promise fulfilled with a list of devices as a result
     */
    DeviceList.prototype._progressWithConnected = function (pr) {
        return pr.then(null, null, function () { // ignores the value
            if (!enumeratePaused) {
                return trezor.devices();
            }
        });
    };

    /**
     * Maps a promise notifications with a delta between the current and
     * previous device descriptors.
     *
     * Expects a Promise as an argument and returns a new Promise.  Passed
     * Promise is expected to return a current list of device as its result.
     * Each time passed Promise is fulfilled, the returned Promise is fulfilled
     * aswell with an Object describing the difference between the current list
     * of devices and the list of devices that was passed to this method when
     * it was previously called.
     *
     * @see DeviceList#_progressWithConnected()
     * @see DeviceList#_computeDescriptorDelta()
     *
     * @param {Promise} pr  Promise expected to have a list of device
     *                      descriptors as a result
     * @return {Promise}    Promise fulfilled with an Object describing the
     *                      added and removed devices as a result
     */
    DeviceList.prototype._progressWithDescriptorDelta = function (pr) {
        var prev = [],
            tmp;

        return pr.then(null, null, function (curr) {
            if (!curr) {
                return;
            }
            tmp = prev;
            prev = curr;
            return this._computeDescriptorDelta(tmp, curr);
        });
    };

    /**
     * Computes which devices were added and which were removed in current tick
     *
     * Returns an Object with two properties:
     * `added`: Array of added device descriptors
     * `removed`: Array of removed device descriptors
     *
     * @param {Array} xs  Old list of device descriptors
     * @param {Array} ys  New list of device descriptors
     * @return {Object}  Difference in format {added: Array, removed: Array}
     */
    DeviceList.prototype._computeDescriptorDelta(xs, ys) {
        return {
            added: _.filter(ys, function (y) {
                return !_.find(xs, { id: y.id });
            }),
            removed: _.filter(xs, function (x) {
                return !_.find(ys, { id: x.id });
            })
        };
    };

    // marks the device of the given descriptor as connected and starting the
    // correct workflow
    function _connect(desc) {
      var dev;

      if (desc.id) {
        dev = _.find(self.devices, { id: desc.id });
        if (!dev) {
          dev = new TrezorDevice(desc.id);
          self.devices.push(dev);
        }
      } else
        dev = new TrezorDevice(desc.path);

      dev.withLoading(function () {
        dev.connect(desc);
        setupCallbacks(dev);
        resetOutdatedFirmwareBar(dev);
        return dev.initializeDevice().then(
          function (features) {
            navigateTo(dev);
            return features.bootloader_mode ?
              bootloaderWorkflow(dev) :
              normalWorkflow(dev);
          },
          function () {
            dev.disconnect();
          }
        );
      });
    }

    // marks a device of the given descriptor as disconnected
    function _disconnect(desc) {
      var dev;

      if (desc.id) {
        dev = _.find(self.devices, { id: desc.id });
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

    DeviceList.prototype.isForgetInProgress = function () {
        return this._forgetInProgress === true;
    };

    DeviceList.prototype.setForgetInProgress = function (forgetInProgress) {
        this._forgetInProgress = forgetInProgress;
    };

    DeviceList.prototype.getForgetModal = function () {
        return this._forgetModal;
    };

    DeviceList.prototype.setForgetModal = function (forgetModal) {
        this._forgetModal = forgetModal;
    };

    return DeviceList;

}(angular, utils));
