'use strict';

// jshint curly:false, camelcase:false, latedef:nofunc

// External modules

angular.module('webwalletApp')
  .value('BigInteger', window.BigInteger)
  .value('Crypto', window.Crypto)
  .value('Bitcoin', window.Bitcoin);

// Filters

angular.module('webwalletApp')
  .filter('sign', function () {
    return function (sign) {
      if (sign > 0) return '+';
      if (sign < 0) return '-';
      return '';
    };
  })
  .filter('passwordify', function () {
    return function (val) {
      return val.split('').map(function () { return '*'; }).join('');
    };
  })
  .filter('amount', function (Bitcoin) {
    return function (val) {
      if (val)
        return Bitcoin.Util.formatValue(val);
    };
  })
  .filter('bytesToHex', function (Bitcoin) {
    return function (val) {
      if (val)
        return Bitcoin.Util.bytesToHex(val);
    };
  });

// Utils module

angular.module('webwalletApp')
  .service('utils', function Utils(Crypto, Bitcoin, $q, $interval, $timeout) {

    //
    // codecs
    //

    var stringToBytes = Crypto.charenc.Binary.stringToBytes,
        bytesToString = Crypto.charenc.Binary.bytesToString,
        base64ToBytes = Crypto.util.base64ToBytes,
        bytesToBase64 = Crypto.util.bytesToBase64,
        hexToBytes = Bitcoin.Util.hexToBytes,
        bytesToHex = Bitcoin.Util.bytesToHex;

    function utf8ToHex(utf8) {
      var str = unescape(encodeURIComponent(utf8));
      return bytesToHex(stringToBytes(str));
    }

    function hexToUtf8(hex) {
      var str = bytesToString(hexToBytes(hex));
      return decodeURIComponent(escape(str));
    }

    this.stringToBytes = stringToBytes;
    this.bytesToString = bytesToString;

    this.base64ToBytes = base64ToBytes;
    this.bytesToBase64 = bytesToBase64;

    this.hexToBytes = hexToBytes;
    this.bytesToHex = bytesToHex;

    this.utf8ToHex = utf8ToHex;
    this.hexToUtf8 = hexToUtf8;

    //
    // hdnode
    //

    // decode private key from xprv base58 string to hdnode structure
    function xprv2node(xprv) {
      var bytes = Bitcoin.Base58.decode(xprv),
          hex = bytesToHex(bytes),
          node = {};

      if (hex.substring(90, 92) !== '00')
        throw new Error('Contains invalid private key');

      node.version = parseInt(hex.substring(0, 8), 16);
      node.depth = parseInt(hex.substring(8, 10), 16);
      node.fingerprint = parseInt(hex.substring(10, 18), 16);
      node.child_num = parseInt(hex.substring(18, 26), 16);
      node.chain_code = hex.substring(26, 90);
      node.private_key = hex.substring(92, 156); // skip 0x00 indicating privkey
      // TODO: verify checksum

      return node;
    }

    // encode public key hdnode to xpub base58 string
    function node2xpub(node) {
      var hex, bytes, chck, xpub;

      hex = hexpad(node.version, 8)
        + hexpad(node.depth, 2)
        + hexpad(node.fingerprint, 8)
        + hexpad(node.child_num, 8)
        + node.chain_code
        + node.public_key;

      bytes = hexToBytes(hex);
      chck = Crypto.SHA256(Crypto.SHA256(bytes, {asBytes: true}), {asBytes: true});
      xpub = Bitcoin.Base58.encode(bytes.concat(chck.slice(0, 4)));

      return xpub;

      function hexpad(n, l) {
        var s = parseInt(n).toString(16);
        while (s.length < l) s = '0' + s;
        return s;
      }
    }

    function node2address(node, type) {
      var pubkey = node.public_key,
          bytes = hexToBytes(pubkey),
          hash = Bitcoin.Util.sha256ripe160(bytes);

      return address2str(hash, type);
    }

    function address2str(hash, version) {
      var csum, bytes;

      hash.unshift(version);
      csum = Crypto.SHA256(Crypto.SHA256(hash, {asBytes: true}), {asBytes: true});
      bytes = hash.concat(csum.slice(0, 4));

      return Bitcoin.Base58.encode(bytes);
    }

    this.xprv2node = xprv2node;
    this.node2xpub = node2xpub;
    this.node2address = node2address;

    //
    // promise utils
    //

    // returns a promise that gets notified every n msec
    function tick(n) {
      return $interval(null, n);
    }

    // keeps calling fn while the returned promise is being rejected
    // fn can cancel by returning falsey
    // if given delay, waits for delay msec before calling again
    // if given max, gives up after max attempts and rejects with
    // the latest error
    function endure(fn, delay, max) {
      var pr = fn();

      if (!pr)
        return $q.reject('Cancelled');

      return pr.then(null, function (err) {

        if (max !== undefined && max < 1) // we have no attempt left
          throw err;

        var retry = function () {
          return endure(fn, delay, max ? max - 1 : max);
        };

        return $timeout(retry, delay); // retry after delay
      });
    }

    this.tick = tick;
    this.endure = endure;

    //
    // collection utils
    //

    // finds index of item in an array using a comparator fn
    // returns -1 if not found
    function findIndex(xs, x, fn) {
      var i;

      for (i = 0; i < xs.length; i++)
        if (fn(xs[i], x))
          return i;

      return -1;
    }

    // like findIndex, but returns the array item
    // returns undefined if not found
    function find(xs, x, fn) {
      var idx = findIndex(xs, x, fn);
      if (idx < 0) return;
      return xs[idx];
    }

    // filters an array using a predicate fn
    function filter(xs, fn) {
      var ys = [],
          i;

      for (i = 0; i < xs.length; i++)
        if (fn(xs[i]))
          ys.push(xs[i]);

      return ys;
    }

    // returns items from xs that are missing in ys using a comparator fn
    function difference(xs, ys, fn) {
      return filter(xs, function (x) {
        return find(ys, x, fn) === undefined;
      });
    }

    this.findIndex = findIndex;
    this.find = find;
    this.filter = filter;
    this.difference = difference;

  });

angular.module('webwalletApp')
  .factory('flash', function($rootScope, $timeout) {
    var messages = [];

    var reset;
    var cleanup = function() {
      $timeout.cancel(reset);
      reset = $timeout(function() { messages = []; });
    };

    var emit = function() {
      $rootScope.$emit('flash:message', messages, cleanup);
    };

    $rootScope.$on('$locationChangeSuccess', emit);

    var asMessage = function(level, text) {
      if (!text) {
        text = level;
        level = 'success';
      }
      return { level: level, text: text };
    };

    var asArrayOfMessages = function(level, text) {
      if (level instanceof Array) return level.map(function(message) {
        return message.text ? message : asMessage(message);
      });
      return text ? [{ level: level, text: text }] : [asMessage(level)];
    };

    var flash = function(level, text) {
      emit(messages = asArrayOfMessages(level, text));
    };

    ['error', 'warning', 'info', 'success'].forEach(function (level) {
      flash[level] = function (text) { flash(level, text); };
    });

    return flash;
  })

  .directive('flashMessages', function() {
    return {
      controller: function ($scope, $rootScope) {
        $rootScope.$on('flash:message', function (_, messages, done) {
          $scope.messages = messages;
          done();
        });
      },
      restrict: 'EA',
      replace: true,
      template:
        '<div ng-repeat="m in messages"' +
        '     ng-switch="m.level">' +
        '  <div class="alert alert-flash alert-danger"' +
        '       ng-switch-when="error"><h4 class="text-capitals">{{m.level}}!</h4> {{m.text}}</div>' +
        '  <div class="alert alert-flash alert-{{m.level}}"' +
        '       ng-switch-default><h4 class="text-capitals">{{m.level}}</h4> {{m.text}}</div>' +
        '</div>'
    };
  });