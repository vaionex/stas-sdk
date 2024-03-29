const bsv = require('@vaionex/bsv')
const utility = require('./utility')
const stasUtils = require('./stasTemplates')
const errorHandler = require('./errors')
const feeEstimates = require('./stasFeeEstimates')

// STAS redeemSplit
/**
 *
 * @param {string} ownerPublicKey - public key string for the STAS UTXO
 * @param {object} stasUtxo - STAS token UTXO to be redeemed
 * @param {string} paymentPublicKey - payment public key string.
 * @param {object} paymentUtxo - utxo that is provided to pay the transaction fee.
 * @param {array} splitDestinations - desination addresses and amounts for each output in the transaction
 * @param {string} data - optional data field that can be used for certain STAS token templates
 * @param {boolean} isZeroChange - if true will not return a change UTXO in the transaction
 * @param {object} ownerPrivateKey - private key value for the STAS UTXO
 * @param {object} paymentPrivateKey - private key for the paymentUtxo
 * @param {number} txCost - total cost of the transaction in satoshis based on the fee rate from the BSV libary
 * @param {boolean} feeEstimateCall - if true will bypass the isZeroChange error handling as it would be called only to return the transaction fee estimate
 * @return {Promise<string|object>} - Will return one of two options.
 *  - If all private keys are supplied for all inputs, resolves with the signed transaction in hexadecimal format.
 *  - If not all private keys are supplied to sign the transaction, resolves with an object containing information about the unsigned input(s) along with the transaction.
 */
async function unSignedFunc(ownerPublicKey, stasUtxo, paymentPublicKey, paymentUtxo, splitDestinations, data, isZeroChange = false, ownerPrivateKey, paymentPrivateKey, txCost, feeEstimateCall = false) {
  errorHandler.validateRedeemSplitArgs(ownerPublicKey, stasUtxo, paymentPublicKey, paymentUtxo, splitDestinations);

  const unsignedData = [];

  const outputData = [];
  const isZeroFee = (!paymentUtxo);
  const paymentPublicKeyHash = utility.getPKHfromPublicKey(paymentPublicKey);
  const isStas20 = stasUtils.checkIfStas20(stasUtxo.script);
  const redeemPkh = stasUtils.getRedeemPublicKeyHash(stasUtxo.script);
  const redeemOutputScript = utility.buildP2pkhOutputScript(redeemPkh);
  const totalOutSats = splitDestinations.reduce((a, b) => a + b.satoshis, 0);
  const redeemSats = stasUtxo.satoshis - totalOutSats;


  const tx = new bsv.Transaction();

  tx.from(stasUtxo);
  if (!isZeroFee) {
    tx.from(paymentUtxo);
  }

  tx.addOutput(new bsv.Transaction.Output({
    script: redeemOutputScript,
    satoshis: redeemSats,
  }));

  outputData.push({
    publicKeyHash: redeemPkh,
    satoshis: redeemSats,
  });

  for (const destinationData of splitDestinations) {
    const destinationPublicKeyHash = utility.addressToPKH(destinationData.address);
    const destinationSatoshis = destinationData.satoshis;
    const stasScript = stasUtils.updateStasScript(destinationPublicKeyHash, stasUtxo.script);
    const redeemAddr = stasUtils.getRedeemPublicKeyHash(stasScript);
    errorHandler.checkDestinationAddressCondition(redeemAddr, destinationPublicKeyHash, isStas20);
    tx.addOutput(new bsv.Transaction.Output({script: stasScript, satoshis: destinationSatoshis}));
    outputData.push({publicKeyHash: destinationPublicKeyHash, satoshis: destinationSatoshis});
  }

  if (!isZeroFee && !isZeroChange) {
    tx.addOutput(new bsv.Transaction.Output({
      script: utility.buildP2pkhOutputScript(paymentPublicKeyHash),
      satoshis: paymentUtxo.satoshis - txCost,
    }));

    outputData.push({
      satoshis: tx.outputs[tx.outputs.length - 1].satoshis,
      publicKeyHash: paymentPublicKeyHash,
    });
  }

  if (isZeroChange && !feeEstimateCall) {
    errorHandler.checkZeroChangeThreshold(paymentUtxo.satoshis, txCost, 'RedeemSplit Function Zero Change');
  }

  if (isStas20 && data !== undefined) {
    data = stasUtils.formatDataToHexStringWithOpCodeConversion(data);
    const lockingScriptNote = '006a' + data;
    tx.addOutput(new bsv.Transaction.Output({
      script: lockingScriptNote,
      satoshis: 0,
    }));
  }


  const unSignedUnlockingScript = await stasUtils.buildUnlockingScriptUnsigned(tx, outputData, undefined, isStas20, data, isZeroFee, isZeroChange);
  if (ownerPrivateKey) {
    tx.inputs[0].setScript(bsv.Script.fromASM(`${unSignedUnlockingScript} ${bsv.Transaction.Sighash.sign(tx, ownerPrivateKey, utility.SIGHASH, 0, tx.inputs[0].output._script, tx.inputs[0].output._satoshisBN).toTxFormat().toString('hex')} ${ownerPublicKey}`));
  } else {
    tx.inputs[0].setScript(bsv.Script.fromASM(`${unSignedUnlockingScript}`));
    unsignedData.push({inputIndex: 0, satoshis: tx.inputs[0].output._satoshisBN, script: tx.inputs[0].output._script, sighash: utility.SIGHASH, publicKeyString: ownerPublicKey, stas: true});
  }

  if (!isZeroFee) {
    if (paymentPrivateKey) {
      tx.inputs[1].setScript(bsv.Script.fromASM(`${bsv.Transaction.Sighash.sign(tx, paymentPrivateKey, utility.SIGHASH, 1, tx.inputs[1].output._script, tx.inputs[1].output._satoshisBN).toTxFormat().toString('hex')} ${paymentPublicKey}`));
    } else {
      unsignedData.push({inputIndex: 1, satoshis: tx.inputs[1].output._satoshisBN, script: tx.inputs[1].output._script, sighash: utility.SIGHASH, publicKeyString: paymentPublicKey, stas: false});
    }
  }

  if (unsignedData.length) {
    return {
      unsignedData: unsignedData,
      tx: tx,
    };
  } else {
    return tx
  }
}

/**
 * Will create a new signed transaction for a token redeem split.
 * @param {object} ownerPrivateKey - private key value for the STAS UTXO
 * @param {object} stasUtxo - STAS token UTXO to be redeemed
 * @param {array} splitDestinations - desination addresses and amounts for each output in the transaction
 * @param {object} paymentUtxo - utxo that is provided to pay the transaction fee.
 * @param {object} paymentPrivateKey - private key for the paymentUtxo
 * @param {string} data - optional data field that can be used for certain STAS token templates
 * @param {boolean} isZeroChange - if true will not return a change UTXO in the transaction
 * @param {number} txCost - total cost of the transaction in satoshis based on the fee rate from the BSV libary
 * @param {boolean} feeEstimateCall - if true will bypass the isZeroChange error handling as it would be called only to return the transaction fee estimate
 * @return {Promise<string>} - will return a promise that contains the signed transaction in hexadecimal format
 */
async function signedFunc(ownerPrivateKey, stasUtxo, splitDestinations, paymentUtxo, paymentPrivateKey, data, isZeroChange, txCost, feeEstimateCall) {
  return await unSignedFunc(ownerPrivateKey.publicKey.toString('hex'), stasUtxo, paymentPrivateKey.publicKey.toString('hex'), paymentUtxo, splitDestinations, data, isZeroChange, ownerPrivateKey, paymentPrivateKey, txCost, feeEstimateCall);
}

/**
 * Will return a fee estimate for the token redeem split transaction.
 * @param {object} stasUtxo - STAS token UTXO to be redeemed
 * @param {array} splitDestinations - desination addresses and amounts for each output in the transaction
 * @param {string} data - optional data field that can be used for certain STAS token templates
 * @param {boolean} isZeroChange - if true will not return a change UTXO in the transaction
 * @return {Promise<number>} - will return a number that will be the fee estimate for the transaction
 */
async function feeEstimate(stasUtxo, splitDestinations, data, isZeroChange) {
  const splitDest = await feeEstimates.buildSplitDestinations(splitDestinations.length, stasUtxo.satoshis);
  const redeemSplitHex = await signedFunc(feeEstimates.templatePrivateKey, stasUtxo, splitDest, feeEstimates.paymentUtxoTemplate, feeEstimates.templatePrivateKey, data, isZeroChange, feeEstimates.txCost, true);
  return new bsv.Transaction(redeemSplitHex).feePerKb(utility.SATS)._estimateFee();
}

/**
 * Will create a new signed transaction for a token redeem split.
 * @param {object} ownerPrivateKey - private key value for the STAS UTXO
 * @param {object} stasUtxo - STAS token UTXO to be redeemed
 * @param {array} splitDestinations - desination addresses and amounts for each output in the transaction
 * @param {object} paymentUtxo - utxo that is provided to pay the transaction fee.
 * @param {object} paymentPrivateKey - private key for the paymentUtxo
 * @param {string} data - optional data field that can be used for certain STAS token templates
 * @param {boolean} isZeroChange - if true will not return a change UTXO in the transaction
 * @return {Promise<string>} - will return a promise that contains the signed transaction in hexadecimal format
 */
async function signed(ownerPrivateKey, stasUtxo, splitDestinations, paymentUtxo, paymentPrivateKey, data, isZeroChange) {
  const txCost = await feeEstimate(stasUtxo, splitDestinations, data, isZeroChange);
  return await signedFunc(ownerPrivateKey, stasUtxo, splitDestinations, paymentUtxo, paymentPrivateKey, data, isZeroChange, txCost);
}

/**
 * Will create a new unSigned transaction for a token redeem split.
 * @param {string} ownerPublicKey - public key string for the STAS UTXO
 * @param {object} stasUtxo - STAS token UTXO to be redeemed
 * @param {string} paymentPublicKey - payment public key string.
 * @param {object} paymentUtxo - utxo that is provided to pay the transaction fee.
 * @param {array} splitDestinations - desination addresses and amounts for each output in the transaction
 * @param {string} data - optional data field that can be used for certain STAS token templates
 * @param {boolean} isZeroChange - if true will not return a change UTXO in the transaction
 * @return {Promise<object>} - will return a promise containing the information about the unsigned input(s) along with the transaction
 */
async function unSigned(ownerPublicKey, stasUtxo, paymentPublicKey, paymentUtxo, splitDestinations, data, isZeroChange) {
  const txCost = await feeEstimate(stasUtxo, splitDestinations, data, isZeroChange);
  return await unSignedFunc(ownerPublicKey, stasUtxo, paymentPublicKey, paymentUtxo, splitDestinations, data, isZeroChange, undefined, undefined, txCost);
}
  
module.exports =  {signed, unSigned, feeEstimate}