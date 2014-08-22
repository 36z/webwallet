/*global _, $q, config, utils, trezor, TrezorDevice, DeviceStorage, $rootScope*/

(function (_, $q, config, utils, trezor, TrezorDevice, DeviceStorage,
        $rootScope) {
    'use strict';

    /**
     * Device list
     */
    function DeviceList () {
        // Initialize the device storage
        this._storage = new DeviceStorage({
            type: TrezorDevice,
            version: config.storageVersion,
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

    DeviceList.prototype.EVENT_CONNECT = 'device.connect';
    DeviceList.prototype.EVENT_DISCONNECT = 'device.disconnect';

    DeviceList.prototype.STORAGE_DEVICES = 'trezorServiceDeviceList';
    DeviceList.prototype.STORAGE_VERSION = 'trezorStorageVersion';
    DeviceList.prototype.POLLING_PERIOD = 1000;

    DeviceList.prototype._devices = null;

    DeviceList.prototype._watchPaused = false;

    DeviceList.prototype._forgetInProgress = false;
    DeviceList.prototype._forgetModal = false;

    DeviceList.prototype._connectHook = false;
    DeviceList.prototype._initHook = false;
    DeviceList.prototype._disconnectHook = false;

    /**
     * Find a device by passed device ID or device descriptor
     *
     * @param {String|Object} id         Device ID or descriptor in format
     *                                   {id: String, path: String}
     * @return {TrezorDevice|undefined}  Device or undefined if not found
     */
    DeviceList.prototype.get = function (id) {
        id = id.id || id;
        if (!id) {
            return;
        }
        return _.find(this._devices, { id: id });
    };

    /**
     * Add a new device to the device list
     *
     * @param {TrezorDevice} dev  Device to add
     */
    DeviceList.prototype._add = function (dev) {
        this._devices.push(dev);
    };

    /**
     * Get the default device
     *
     * That is currently the first device.
     *
     * @return {TrezorDevice}  Default device
     */
    DeviceList.prototype.getDefault = function () {
        return this._devices[0];
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
    DeviceList.prototype.remove = function (dev) {
        dev.destroy();
        _.remove(this._devices, { id: dev.id });
    };

    /**
     * Alias to `DeviceList#remove()`
     *
     * @see DeviceList#remove()
     */
    DeviceList.prototype.forget = DeviceList.prototype.remove;

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
                $rootScope.$broadcast(this.EVENT_CONNECT, device.id);
                this._connect(device);
            }.bind(this));
            dd.removed.forEach(function (device) {
                $rootScope.$broadcast(this.EVENT_DISCONNECT, device.id);
                this._disconnect(device);
            }.bind(this));
        }.bind(this));

        return tick;
    };

    DeviceList.prototype.pauseWatch = function () {
        this._watchPaused = true;
    };

    DeviceList.prototype.resumeWatch = function () {
        this._watchPaused = false;
    };

    /**
     * Maps a promise notifications with connected device descriptors.
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
            if (!this._watchPaused) {
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
        }.bind(this));
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
     * @return {Object}   Difference in format {added: Array, removed: Array}
     */
    DeviceList.prototype._computeDescriptorDelta = function (xs, ys) {
        return {
            added: _.filter(ys, function (y) {
                return !_.find(xs, { id: y.id });
            }),
            removed: _.filter(xs, function (x) {
                return !_.find(ys, { id: x.id });
            })
        };
    };

    /**
     * Marks the device of the passed descriptor as connected and calls the
     * connect and initialize hooks.
     *
     * @param {Object} desc  Device descriptor in format
     *                       {id: String, path: String}
     */
    DeviceList.prototype._connect = function (desc) {
        var dev = this._get(desc) || this._create(desc);

        this._add(dev);

        dev.withLoading(function () {
            dev.connect(desc);

            $q.fcall(connectHook);

            return dev.initializeDevice()
                .then(
                    function (features) {
                        return {device: dev, features: features};
                    },
                    function () {
                        dev.disconnect();
                    }
                )
                .then(this._initHook);
        });
    };

    /**
     * Register connect hook
     *
     * Note that it is not possible to reference the hook once it was
     * registered, therefore there is no way to unregister the hook.
     *
     * @param {Function} fn  Hook function.  The function is passed 2 args.:
     *                       - {TrezorDevice} device  Device object
     *                       - {Object} features      Device features
     *                       If the hook throws Error, than subsequent
     *                       connect hooks will not be called.
     */
    DeviceList.prototype.registerConnectHook = function (fn) {
        this._connectHook.then(function (params) {
            fn(params.device, params.features);
            return params;
        });
    };

    /**
     * Register initialize hook
     *
     * Note that it is not possible to reference the hook once it was
     * registered, therefore there is no way to unregister the hook.
     *
     * @param {Function} fn  Hook function.  The function is passed a
     *                       single argument: the TrezorDevice object.
     *                       If the hook throws Error, than subsequent
     *                       initialize hooks will not be called.
     */
    DeviceList.prototype.registerInitHook = function (fn) {
        this._initHook.then(function (dev) {
            fn(dev);
            return dev;
        });
    };

    /**
     * Register disconnect hook
     *
     * Note that it is not possible to reference the hook once it was
     * registered, therefore there is no way to unregister the hook.
     *
     * @param {Function} fn  Hook function.  The function is passed a
     *                       single argument: the TrezorDevice object.
     *                       If the hook throws Error, than subsequent
     *                       disconnect hooks will not be called.
     */
    DeviceList.prototype.registerDisconnectHook = function (fn) {
        this._disconnectHook.then(function (dev) {
            fn(dev);
            return dev;
        });
    };

    /**
     * Create new device from passed descriptor.
     *
     * @param {Object} desc    Device descriptor in format
     *                         {id: String, path: String}
     * @return {TrezorDevice}  Created device
     */
    DeviceList.prototype._create = function (desc) {
        return new TrezorDevice(desc.id || desc.path);
    };

    /**
     * Marks a device of the passed descriptor as disconnected.
     *
     * @param {String} desc  Device descriptor
     */
    DeviceList.prototype._disconnect = function (desc) {
        var dev = this.get(desc.id);
        if (!dev) {
            return;
        }
        dev.disconnect();
        return $q.fcall(
                function () {
                    return dev;
                }
            )
            .then(this._disconnectHook);
    };

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

}(_, $q, config, utils, trezor, TrezorDevice, DeviceStorage, $rootScope));
