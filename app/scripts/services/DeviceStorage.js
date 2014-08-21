/*global $rootScope, storage*/

(function ($rootScope, storage) {
    'use strict';

    /**
     * Device storage
     */
    function DeviceStorage (options) {
        this._type = options.type;
        this._version = options.version;
        this._keyItems = options.keyItems;
        this._keyVersion = options.keyVersion;
    }

    DeviceStorage.prototype._version = null;
    DeviceStorage.prototype._keyItems = null;
    DeviceStorage.prototype._keyVersion = null;
    DeviceStorage.prototype._type = null;

    DeviceStorage.prototype.init = function () {
        return this._watch(
            this._load()
        );
    };

    DeviceStorage.prototype._load = function () {
        return this._deserialize(
            this._restore()
        );
    };

    // watches the device list and persist it to storage on change
    DeviceStorage.prototype._watch = function (items) {
        $rootScope.$watch(
            function () {
                return this._serialize(items);
            },
            function (data) {
                this._store(data);
            }.bind(this),
            true // deep compare
        );
        return items;
    };

    // serialize a device list
    DeviceStorage.prototype._serialize = function (items) {
        return items.map(function (item) {
            return item.serialize();
        });
    };

    // deserialize a device list
    DeviceStorage.prototype._deserialize = function (data) {
        return data.map(function (item) {
            return this._type.deserialize(item);
        });
    };

    // takes serialized device list, puts it to storage
    DeviceStorage.prototype._store = function (data) {
        var json = JSON.stringify(data);
        storage[this._keyItems] = json;
        storage[this._keyVersion] = this._version;
        return json;
    };

    // loads a serialized device list from storage
    DeviceStorage.prototype._restore = function () {
        var items = storage[this._keyItems],
            version = storage[this._keyVersion];

        if (items && version === this._version) {
            return JSON.parse(items);
        }
        return [];
    };

    return DeviceStorage;

}($rootScope, storage));
