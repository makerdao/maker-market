import { Meteor } from 'meteor/meteor';
import { Mongo } from 'meteor/mongo';
import { Session } from 'meteor/session';
import { Dapple, web3 } from 'meteor/makerotc:dapple';
import { _ } from 'meteor/underscore';
import Transactions from './transactions';
import prettyError from '/imports/utils/prettyError';

class TokenEventCollection extends Mongo.Collection {
  fromLabel() {
    return this.from;
  }
  toLabel() {
    return super.to;
  }
  syncEvent(tokenId, event) {
    if (typeof (event.event) === 'undefined') {
      return;
    }
    let row = {
      blockNumber: event.blockNumber,
      transactionHash: event.transactionHash,
      timestamp: null,
      token: tokenId,
      type: event.event.toLowerCase(),
    };
    // Handle different kinds of contract events
    switch (row.type) {
      case 'transfer':
        row.from = event.args.from;
        row.to = event.args.to;
        row.amount = event.args.value;
        break;
      case 'deposit':
        row.from = event.args.who;
        row.to = event.address;
        row.amount = event.args.amount;
        break;
      case 'withdrawal':
        row.from = event.address;
        row.to = event.args.who;
        row.amount = event.args.amount;
        break;
      default:
        break;
    }
    // Convert amount to string for storage
    if (typeof (row.amount) !== 'undefined') {
      row.amount = row.amount.toString(10);
    }
    super.insert(row);
  }

  syncTimestamps() {
    const open = super.find({ timestamp: null }).fetch();
    // Sync all open transactions non-blocking and asynchronously
    const syncTs = (index) => {
      // console.log('syncing ts', index);
      if (index >= 0 && index < open.length) {
        web3.eth.getBlock(open[index].blockNumber, (error, result) => {
          if (!error) {
            // console.log('update', open[index].blockNumber, result.timestamp);
            super.update({ blockNumber: open[index].blockNumber },
              { $set: { timestamp: result.timestamp } }, { multi: true });
          }
          syncTs(index + 1);
        });
      }
    };
    syncTs(0);
  }

  watchTokenEvents() {
    if (Session.get('startBlock') !== 0) {
      console.log('filtering token events from ', Session.get('startBlock'));
      const ALL_TOKENS = _.uniq([Session.get('quoteCurrency'), Session.get('baseCurrency')]);
      ALL_TOKENS.forEach((tokenId) => {
        Dapple.getToken(tokenId, (error, token) => {
          if (!error) {
            const events = token.allEvents({
              fromBlock: Session.get('startBlock'),
              toBlock: 'latest',
            });
            const self = this;
            events.watch((err, event) => {
              if (!err) {
                self.syncEvent(tokenId, event);
              }
            });
          }
        });
      });
    }
  }

  watchBrokerCreation() {
    Transactions.observeRemoved('gnttokens_create_broker', (document) => {
      if (document.receipt.logs.length === 0) {
        Session.set('GNTDepositProgress', 0);
        Session.set('GNTDepositProgressMessage', '');
        Session.set('GNTDepositErrorMessage', 'Creating Broker went wrong. Please execute the desposit again.');
      } else {
        const broker = document.receipt.logs[0].topics[1];
        console.log('Broker: ', broker);
        Session.set('GNTDepositProgress', 40);
        Session.set('GNTDepositProgressMessage', 'Transfering to Broker... (Waiting for your approval)');
        // We get the broker, we transfer GNT to it
        Dapple.getToken('GNT', (err, gntToken) => {
          gntToken.transfer(broker, web3.toWei(document.object.amount), (txError, tx) => {
            if (!txError) {
              console.log('TX Transfer to Broker:', tx);
              Session.set('GNTDepositProgress', 50);
              Session.set('GNTDepositProgressMessage', 'Transfering to Broker... (waiting for transaction confirmation)');
              Transactions.add('gnttokens_transfer', tx, { type: 'deposit', broker });
            } else {
              Session.set('GNTDepositProgress', 0);
              Session.set('GNTDepositProgressMessage', '');
              Session.set('GNTDepositErrorMessage', prettyError(txError));
            }
          });
        });
      }
    });
  }

  watchBrokerTransfer() {
    Transactions.observeRemoved('gnttokens_transfer', (document) => {
      if (document.receipt.logs.length === 0) {
        Session.set('GNTDepositProgress', 0);
        Session.set('GNTDepositProgressMessage', '');
        Session.set('GNTDepositErrorMessage', 'Transfering to Broker went wrong. Please execute the desposit again.');
      } else {
        console.log('Transfer to Broker done');
        Session.set('GNTDepositProgress', 75);
        Session.set('GNTDepositProgressMessage', 'Clearing Broker... (Waiting for your approval)');
        console.log('Acá va el broker:');
        console.log(document.object.broker);
        console.log(document.object.broker.slice(-40));
        Dapple['token-wrapper'].classes.DepositBroker.at(document.object.broker.slice(-40)).clear((txError, tx) => {
          if (!txError) {
            console.log('TX Clear Broker:', tx);
            Session.set('GNTDepositProgress', 90);
            Session.set('GNTDepositProgressMessage', 'Clearing Broker... (waiting for transaction confirmation)');
            Transactions.add('gnttokens_clear', tx, { type: 'deposit' });
          } else {
            Session.set('GNTDepositProgress', 0);
            Session.set('GNTDepositProgressMessage', '');
            Session.set('GNTDepositErrorMessage', prettyError(txError));
          }
        });
      }
    });
  }

  watchBrokerClear() {
    Transactions.observeRemoved('gnttokens_clear', (document) => {
      if (document.receipt.logs.length === 0) {
        Session.set('GNTDepositProgress', 0);
        Session.set('GNTDepositProgressMessage', '');
        Session.set('GNTDepositErrorMessage', 'Clearing Broker went wrong. Please execute the clearing manually again to get the deposit.');
      } else {
        Session.set('GNTDepositProgress', 100);
        Session.set('GNTDepositProgressMessage', 'Deposit Done!');
        Meteor.setTimeout(() => {
          Session.set('GNTDepositProgress', 0);
          Session.set('GNTDepositProgressMessage', '');
        }, 10000);
      }
    });
  }

}

export default new TokenEventCollection(null);
