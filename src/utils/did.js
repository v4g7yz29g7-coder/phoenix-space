const { ethers } = require('ethers');

function createDID() {
  const wallet = ethers.Wallet.createRandom();
  return {
    mnemonic: wallet.mnemonic.phrase,
    address: wallet.address,
    did: `did:phoenix:${wallet.address}`,
    privateKey: wallet.privateKey
  };
}

function getAddressFromMnemonic(mnemonic) {
  const wallet = ethers.Wallet.fromPhrase(mnemonic);
  return wallet.address;
}

module.exports = { createDID, getAddressFromMnemonic };
