'use strict';

// jshint curly:false, camelcase:false, latedef:nofunc

angular.module('webwalletApp')
    .controller('AccountCtrl', function (trezorService, utils, flash,
      $document, $scope, $location, $routeParams) {
    $scope.device = trezorService.get($routeParams.deviceId);
    if (!$scope.device)
      return $location.path('/');

    $scope.account = $scope.device.account($routeParams.accountId);
    if (!$scope.account)
      return $location.path('/');

    $scope.transaction = {};
    $scope.usedAddresses = [];
    $scope.addresses = [];
    $scope.activeAddress = null;
    $scope.lookAhead = 10;

    $scope.forget = function (account) {
      account.unsubscribe();
      account.deregister();
      $scope.device.removeAccount(account);
      $location.path('/device/' + $scope.device.id);
    };

    $scope.activate = function (address) {
      $scope.activeAddress = address;
    };

    $scope.more = function () {
      var index = $scope.addresses.length,
          address = $scope.account.address(index);
      $scope.addresses[index] = address;
      $scope.activate(address);
    };

    $scope.more();

    $scope.estimate = function (tx) {
      var address = tx.address,
          amount = Math.round(tx.amount * 100000000);
      if (!address || !amount) return;
      $scope.account.buildTx(address, amount, $scope.device).then(
        function (builtTx) {
          $scope.builtTx = builtTx;
          tx.fee = builtTx.fee / 100000000;
        },
        function (err) {
          flash.error(err.message || 'Failed to compose transaction.');
        }
      );
    };

    $scope.send = function () {
      var tx = $scope.builtTx;
      $scope.account.sendTx(tx, $scope.device).then(
        function () {
          var path = '/device/' + $scope.device.id + '/account/' + $scope.account.id;
          $location.path(path);
        },
        function (err) {
          flash.error(err.message || 'Failed to send transaction.');
        }
      );
    };

    $scope.suggestAddresses = function () {
      return suggestHistory().concat(suggestAccounts());
    };

    function suggestHistory() {
      return []; // TODO
    }

    function suggestAccounts() {
      var accounts = $scope.device.accounts;

      return accounts.map(function (acc) {
        var address = acc.address(0).address,
            label = acc.label();

        return {
          label: label + ': ' + address,
          address: address,
          source: 'Accounts'
        };
      });
    }
  });
