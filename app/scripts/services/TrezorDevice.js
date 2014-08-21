'use strict';

angular.module('webwalletApp')
  .factory('TrezorDevice', function (
      config, trezor, utils, firmwareService, TrezorAccount,
      BigInteger, _, $q) {

    function TrezorDevice(id) {
      this.id = ''+id;
      this.accounts = [];
      this.features = null;
      this.error = null;

      this._passphrase = null;
      this._session = null;
      this._desc = null;
      this._statusLabel = null;
      this._loadingLevel = 0;

      this._DEFAULT_LABEL = 'My TREZOR';
    }

    /**
     * Initialize the device -- subscribe to account updates from the
     * server backend.
     */
    TrezorDevice.prototype.init = TrezorDevice.prototype.subscribe;

    /**
     * Disconnect the device and unsubscribe from account updates from the
     * server backend.
     */
    TrezorDevice.prototype.destroy = function () {
        this.disconnect();
        this.unsubscribe();
    };

    TrezorDevice.deserialize = function (data) {
      var dev = new TrezorDevice(data.id);

      dev._passphrase = data.passphrase;
      dev.features = data.features;
      dev.accounts = data.accounts.map(function (item) {
        return TrezorAccount.deserialize(item);
      });

      return dev;
    };

    TrezorDevice.prototype.serialize = function () {
      return {
        id: this.id,
        passphrase: this._passphrase,
        features: this.features,
        accounts: this.accounts.map(function (acc) {
          return acc.serialize();
        })
      };
    };

    //
    // Status & features
    //

    TrezorDevice.prototype.isLoading = function () {
      return !!this._loadingLevel;
    };

    TrezorDevice.prototype.withLoading = function (fn) {
      var self = this;

      self._loadingLevel++;
      return $q.when(fn()).finally(function () {
        self._loadingLevel--;
      });
    };

    TrezorDevice.prototype.withStatusLabel = function (label, fn) {
      var self = this,
          label0 = this._statusLabel;

      self._statusLabel = label;
      return $q.when(fn()).finally(function () {
        self._statusLabel = label0;
      });
    };

    TrezorDevice.prototype.status = function () {
      if (this.isLoading()) return 'loading';
      if (this.isConnected()) return 'connected';
      return 'disconnected';
    };

    TrezorDevice.prototype.label = function () {
      if (this.features && this.features.label)
        return this.features.label;
      else
        return this.getDefaultLabel();
    };

    TrezorDevice.prototype.getDefaultLabel = function () {
      return this._DEFAULT_LABEL;
    };

    TrezorDevice.prototype.statusLabel = function () {
      return this._statusLabel;
    };

    TrezorDevice.prototype.balance = function () {
      return this.accounts.reduce(function (bal, acc) {
        return bal.add(acc.balance || BigInteger.ZERO);
      }, BigInteger.ZERO);
    };

    TrezorDevice.prototype.defaultCoin = function () {
      return _.find(this.features.coins, { coin_name: config.coin });
    };

    //
    // Passphrase
    //

    TrezorDevice.prototype.hasSavedPassphrase = function () {
      return !!this._passphrase;
    };

    TrezorDevice.prototype.checkPassphraseAndSave = function (passphrase) {
      var hash = this._hashPassphrase(passphrase);

      if (this._passphrase)
        return this._passphrase === hash;
      else {
        this._passphrase = hash;
        return true;
      }
    };

    TrezorDevice.prototype._hashPassphrase = function (passphrase) {
      var secret = 'TREZOR#' + this.id + '#' + passphrase;
      return utils.sha256x2(secret);
    };

    //
    // HW connections
    //

    TrezorDevice.prototype.isConnected = function () {
      return this._desc && this._session;
    };

    TrezorDevice.prototype.connect = function (desc) {
      this._desc = desc;
      this._session = trezor.open(this._desc);
      this.on = this._session.on.bind(this._session);
      this.once = this._session.once.bind(this._session);
      this.removeListener = this._session.removeListener.bind(this._session);
    };

    TrezorDevice.prototype.disconnect = function () {
      if (this._session)
        this._session.close();
      this._session = null;
      this._desc = null;
    };

    //
    // HW initialization
    //

    TrezorDevice.prototype.isEmpty = function () {
      return !this.features || !this.features.initialized;
    };

    TrezorDevice.prototype.initializeDevice = function () {
      var self = this,
          delay = 3000, // delay between attempts
          max = 60; // give up after n attempts

      // keep trying to initialize
      return utils.endure(callInitialize, delay, max)
        .then(
          function (res) {
            return (self.features = res.message);
          },
          function (err) {
            self.features = null;
            throw err;
          }
        );

      function callInitialize() {
        if (!self.isConnected()) // return falsey to cancel endure()
          return false;

        return self._session.initialize().then(
          function (features) {
            self.error = null;
            return features;
          },
          function (err) {
            self.error = err.message || 'Failed to initialize the device.';
            throw err;
          }
        );
      }
    };

    TrezorDevice.prototype.initializeAccounts = function () {
      var self = this;

      // reset accounts if the device is empty, make sure to deregister
      // existing accounts first
      if (this.isEmpty())
        return this.unsubscribe().then(function () {
          return (self.accounts = []);
        });

      // if the device is not empty and no accounts are present, add the first
      // account and start the account discovery
      if (!this.accounts.length)
        return this.addAccount().then(function () {
          return self.discoverAccounts();
        });

      return $q.when(this.accounts);
    };

    //
    // Account management
    //

    TrezorDevice.prototype.subscribe = function () {
      return $q.all(this.accounts.map(function (acc) {
        return acc.subscribe();
      }));
    };

    TrezorDevice.prototype.unsubscribe = function () {
      return $q.all(this.accounts.map(function (acc) {
        return acc.unsubscribe();
      }));
    };

    TrezorDevice.prototype.account = function (id) {
      return _.find(this.accounts, { id: id });
    };

    /**
     * Get the default account
     *
     * That is currently the first device.
     */
    TrezorDevice.prototype.getDefaultAccount = function () {
      return this.accounts[0];
    };

    TrezorDevice.prototype.accountPath = function (id, coin) {
      if (config.useBip44) {
        return [
          (44 | 0x80000000) >>> 0, // purpose 44' (BIP-0044)
          (config.indices[coin.coin_name] | 0x80000000) >>> 0, // coin_type
          (id | 0x80000000) >>> 0 // account'
        ];
      } else {
        return [
          config.indices[coin.coin_name], // cointype
          (0 | 0x80000000) >>> 0, // reserved'
          (id | 0x80000000) >>> 0 // account'
        ];
       }
    };

    // Account adding

    TrezorDevice.prototype.canAddAccount = function () {
      var lastAcc = this.accounts[this.accounts.length-1];

      return this.isConnected() // hw is available
        && !this.isEmpty() // hw is not empty
        && (!lastAcc || !lastAcc.isEmpty()); // last account is not empty
    };

    TrezorDevice.prototype.addAccount = function () {
      var self = this;

      if (!this.canAddAccount())
        return $q.reject(new Error('Cannot add any more accounts'));

      return this._createAccount(this.accounts.length).then(function (acc) {
        self.accounts.push(acc);
        acc.subscribe();
        return acc;
      });
    };

    // Account hiding

    TrezorDevice.prototype.canHideAccount = function (acc) {
      var lastAcc = this.accounts[this.accounts.length-1];

      return acc.isEmpty() // is empty
        && acc.id === lastAcc.id // is the last
        && this.accounts.length > 1; // is not the only one
    };

    TrezorDevice.prototype.hideAccount = function (acc) {
      if (!this.canHideAccount(acc))
        throw new Error('Cannot hide this account');

      return _.remove(this.accounts, { id: acc.id });
    };

    // Account discovery

    TrezorDevice.prototype.discoverAccounts = function () {
      var self = this,
          start = this.accounts.length;

      return discoverAccount(start).then(function () {
        return self.accounts;
      });

      function discoverAccount(n) {
        return self._createAccount(n).then(function (acc) {
          return acc.subscribe().then(function () {
            // stop the discovery if empty
            if (acc.isEmpty())
              return acc.unsubscribe();

            // add to list and continue
            self.accounts.push(acc);
            return discoverAccount(n + 1);
          });
        });
      }
    };

    TrezorDevice.prototype._createAccount = function (id) {
      var self = this,
          coin = this.defaultCoin(),
          accPath = this.accountPath(id, coin),
          vfSuffix = [0],
          vfPath = accPath.concat(vfSuffix),
          // device always responds with Bitcoin version
          version = config.versions.Bitcoin;

      return this._session.getPublicKey(accPath).then(function (res) {
        var accNode = res.message.node,
            compAccXpub = utils.node2xpub(accNode, version),
            accXpub = accNode.xpub || compAccXpub;

        if (accXpub !== compAccXpub)
          throw new Error('Invalid public key transmission detected - ' +
                          'invalid xpub check. ' +
                          'Key: ' + accXpub + ', ' +
                          'Received: ' + accNode.xpub);

        return self._session.getPublicKey(vfPath).then(function (res) {
          var vfNode = res.message.node,
              compVfNode = derivePath(accNode, vfSuffix),
              vfXpub = utils.node2xpub(vfNode, version),
              compVfXpub = utils.node2xpub(compVfNode, version);

          if (vfXpub !== compVfXpub)
            throw new Error('Invalid public key transmission detected - ' +
                            'invalid child cross-check. ' +
                            'Key: ' + accXpub + ', ' +
                            'Computed: ' + compVfXpub + ', ' +
                            'Received: ' + vfXpub);

          return new TrezorAccount(id, coin, accNode);
        });
      });

      function derivePath(node, path) {
        return path.reduce(function (n, i) {
          return trezor.deriveChildNode(n, i);
        }, node);
      }
    };

    //
    // Device calls
    //

    TrezorDevice.prototype.measureTx = function (tx, coin) {
      return this._session.measureTx(tx.inputs, tx.outputs, coin);
    };

    TrezorDevice.prototype.signTx = function (tx, refTxs, coin) {
      return this._session.signTx(tx.inputs, tx.outputs, refTxs, coin);
      // return this._session.simpleSignTx(tx.inputs, tx.outputs, refTxs, coin);
    };

    TrezorDevice.prototype.flash = function (firmware) {
      var self = this;

      return self._session.eraseFirmware().then(function () {
        return self._session.uploadFirmware(firmware);
      });
    };

    TrezorDevice.prototype.wipe = function () {
      var self = this;

      return self.withLoading(function () {
        return self._session.initialize()
          .then(function () { return self._session.wipeDevice(); })
          .then(function () { return self.unsubscribe(); });
      });
    };

    TrezorDevice.prototype.reset = function (settings) {
      var self = this,
          sett = angular.copy(settings);

      return self.withLoading(function () {
        return self._session.initialize()
          .then(function () { return self._session.resetDevice(sett); })
          .then(function () { return self.initializeDevice(); })
          .then(function () { return self.initializeAccounts(); });
      });
    };

    TrezorDevice.prototype.load = function (settings) {
      var self = this,
          sett = angular.copy(settings);

      try { // try to decode as xprv
        sett.node = utils.xprv2node(sett.payload);
      } catch (e) { // use as mnemonic on fail
        sett.mnemonic = sett.payload;
      }
      delete sett.payload;

      return self.withLoading(function () {
        return self._session.initialize()
          .then(function () { return self._session.loadDevice(sett); })
          .then(function () { return self.initializeDevice(); })
          .then(function () { return self.initializeAccounts(); });
      });
    };

    TrezorDevice.prototype.recover = function (settings) {
      var self = this,
          sett = angular.copy(settings);

      sett.enforce_wordlist = true;

      return self.withLoading(function () {
        return self._session.initialize()
          .then(function () { return self._session.recoverDevice(sett); })
          .then(function () { return self.initializeDevice(); })
          .then(function () { return self.initializeAccounts(); });
      });
    };

    TrezorDevice.prototype.changeLabel = function (label) {
      var self = this;

      return self.withLoading(function () {
        return self._session.initialize()
          .then(function () {
            return self._session.applySettings({ label: label });
          })
          .then(function () { return self.initializeDevice(); });
      });
    };

    TrezorDevice.prototype.changePin = function () {
      var self = this;

      return self.withLoading(function () {
        return self._session.initialize()
          .then(function () { return self._session.changePin(); })
          .then(function () { return self.initializeDevice(); });
      });
    };

    TrezorDevice.prototype.ratePin = function (pin) {
      var digits, strength;

      if (pin.length > 9)
        return 0;

      digits = _.uniq(pin.split('')).length;
      strength  = fac(9) / fac(9 - digits);

      return strength;

      function fac(n) {
        var i, nf = 1;
        for (i = 2; i <= n; i++) nf *= i;
        return nf;
      }
    };

    return TrezorDevice;

  });
