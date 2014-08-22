/*global angular*/

angular.module('webwalletApp')
    .controller('DeviceFirmwareCtrl', function ($location, $rootScope, $modal,
            deviceList, TrezorDevice, firmwareService) {

        'use strict';

        var _modalOpened = false;

        // On device connect
        deviceList.registerConnectHook(setupEnumerationPausing);
        deviceList.registerConnectHook(setupEventForwarding);
        deviceList.registerConnectHook(resetOutdatedFirmwareBar);

        // On device initialize
        deviceList.registerInitHook(navigateTo);
        deviceList.registerInitHook(function (dev, features) {
            if (features.bootloader_mode) {
                bootloaderWorkflow(dev);
            } else {
                normalWorkflow(dev);
            }
        });
        deviceList.registerInitHook(function (dev, features) {
            scope.state = features.bootloader_mode ?
                'device-bootloader' :
                'device-normal';
            scope.device = dev;
        });

        // On device disconnect
        deviceList.registerDisconnectHook(resetOutdatedFirmwareBar);
        deviceList.registerBeforeDisconnectHook(function (dev) {
            if (!scope.device || scope.device.id !== dev.path) {
                return;
            }
            scope.device.disconnect();
            scope.device = null;

            if (scope.state === 'update-success' || scope.state === 'update-error') {
                modal.close();
                return;
            }
            scope.state = 'initial';
        });

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

        function setupEnumerationPausing(dev) {
            dev.on('send', function () {
                deviceList.pauseWatch();
            });
            dev.on('error', function () {
                deviceList.resumeWatch();
            });
            dev.on('receive', function () {
                deviceList.resumeWatch();
            });
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
                _modalOpened = true;
            });
            modal.result.finally(function () {
                _modalOpened = false;
            });

            return modal.result;
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

  });
