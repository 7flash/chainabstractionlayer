import LedgerProvider from '../LedgerProvider'
import Bitcoin from '@ledgerhq/hw-app-btc'

import { BigNumber } from 'bignumber.js'
import { base58, padHexStart } from '../../crypto'
import { pubKeyToAddress, addressToPubKeyHash } from './BitcoinUtil'
import Address from '../../Address'
import networks from '../../networks'

export default class BitcoinLedgerProvider extends LedgerProvider {
  /**
   * @param {boolean} testnet True if the testnet network is being used
   */
  constructor (chain = { network: networks.bitcoin, segwit: true }) {
    super(Bitcoin, `${chain.segwit ? '49' : '44'}'/${chain.network.coinType}'/0'/0/`)
    this._network = chain.network
    this._segwit = chain.segwit
    this._blockChainInfoBaseUrl = chain.network.explorerUrl
    this._coinType = chain.network.coinType
    this._basePath = `${this._segwit ? '49' : '44'}'/${this._coinType}'/0'/0/`
    this._unusedAddressCountdown = 10
  }

  async _getPubKey () {
    const app = await this.getApp()
    return app.getWalletPublicKey(this._derivationPath)
  }

  async getAddressFromDerivationPath (path) {
    const app = await this.getApp()
    const { bitcoinAddress } = await app.getWalletPublicKey(path, false, this._segwit)
    return new Address(bitcoinAddress, path)
  }

  async signMessage (message, from) {
    const app = await this.getApp()
    let derivationPath = from.derivationPath

    if (!derivationPath) {
      derivationPath = await this.getDerivationPathFromAddress(from)
    }

    const hex = Buffer.from(message).toString('hex')
    return app.signMessageNew(derivationPath, hex)
  }

  async getUnusedAddress (from = {}) {
    let addressIndex = from.index || 0
    let unusedAddress = false

    while (!unusedAddress) {
      const path = this.getDerivationPathFromIndex(addressIndex)
      const address = this.getAddressFromDerivationPath(path)
      const isUsed = this.getMethod('isUsedAddress')(address.address)
      if (!isUsed) {
        unusedAddress = address
      }
    }

    return unusedAddress
  }

  getAmountBuffer (amount) {
    let hexAmount = BigNumber(amount).toString(16)
    hexAmount = padHexStart(hexAmount, 16)
    const valueBuffer = Buffer.from(hexAmount, 'hex')
    return valueBuffer.reverse()
  }

  async _splitTransaction (transactionHex, isSegwitSupported) {
    const app = await this.getApp()

    return app.splitTransaction(transactionHex, isSegwitSupported)
  }

  async _serializeTransactionOutputs (transactionHex) {
    const app = await this.getApp()

    return app.serializeTransactionOutputs(transactionHex)
  }

  async _signP2SHTransaction (inputs, associatedKeysets, changePath, outputScriptHex) {
    const app = await this.getApp()

    return app.signP2SHTransaction(inputs, associatedKeysets, changePath, outputScriptHex)
  }

  generateScript (address) {
    const type = base58.decode(address).toString('hex').substring(0, 2).toUpperCase()
    const pubKeyHash = addressToPubKeyHash(address)

    if (type === this._network.pubKeyHash) {
      return [
        '76', // OP_DUP
        'a9', // OP_HASH160
        '14', // data size to be pushed
        pubKeyHash, // <PUB_KEY_HASH>
        '88', // OP_EQUALVERIFY
        'ac' // OP_CHECKSIG
      ].join('')
    } else if (type === this._network.scriptHash) {
      return [
        'a9', // OP_HASH160
        '14', // data size to be pushed
        pubKeyHash, // <PUB_KEY_HASH>
        '87' // OP_EQUAL
      ].join('')
    } else {
      throw new Error('Not a valid address:', address)
    }
  }

  calculateFee (numInputs, numOutputs, feePerByte) { // TODO: lazy fee estimation
    return ((numInputs * 148) + (numOutputs * 34) + 10) * feePerByte
  }

  async getUtxosForAmount (amount, feePerByte = 3) {
    let addressIndex = 0
    let currentAmount = 0
    let numOutputsOffset = 0
    const utxosToUse = []

    while (currentAmount < amount) {
      const path = this.getDerivationPathFromIndex(addressIndex)
      const address = await this.getAddressFromDerivationPath(path)
      const utxos = await this.getMethod('getUnspentTransactions')(address.address)
      const utxosValue = utxos.reduce((acc, utxo) => acc + utxo.value, 0)

      utxos.forEach((utxo) => {
        currentAmount += utxosValue
        utxo.derivationPath = address.derivationPath
        utxosToUse.push(utxo)

        const fees = this.calculateFee(utxosToUse.length, numOutputsOffset + 1)
        let totalCost = amount + fees

        if (numOutputsOffset === 0 && currentAmount > totalCost) {
          numOutputsOffset = 1
          totalCost -= fees
          totalCost += this.calculateFee(utxosToUse.length, 2, feePerByte)
        }
      })

      addressIndex++
    }

    return utxosToUse
  }

  async getLedgerInputs (unspentOutputs) {
    const app = await this.getApp()

    return Promise.all(unspentOutputs.map(async utxo => {
      const hex = await app.getMethod('getTransactionHex')(utxo.tx_hash_big_endian)
      const tx = app.splitTransaction(hex, true)

      return [ tx, utxo.tx_output_n ]
    }))
  }

  async createSignedTransaction (to, value, data, from) {
    const app = await this.getApp()

    if (data) {
      const scriptPubKey = padHexStart(data)
      to = pubKeyToAddress(scriptPubKey, this._network.name, 'scriptHash')
    }

    const unusedAddress = this.getUnusedAddress(from)
    const unspentOutputsToUse = this.getUtxosForAmount(value)

    const totalAmount = unspentOutputsToUse.reduce((acc, utxo) => acc + utxo.value, 0)
    const fee = this.calculateFee(unspentOutputsToUse.length, 1, 3)
    let totalCost = value + fee
    let hasChange = false

    if (totalAmount > totalCost) {
      hasChange = true

      totalCost -= fee
      totalCost += this.calculateFee(unspentOutputsToUse.length, 2, 3)
    }

    if (totalAmount < totalCost) {
      throw new Error('Not enough balance')
    }

    const ledgerInputs = await this.getLedgerInputs(unspentOutputsToUse)
    const paths = unspentOutputsToUse.map(utxo => utxo.derivationPath)

    const sendAmount = value
    const changeAmount = totalAmount - totalCost

    const sendScript = this.generateScript(to)

    let outputs = [{ amount: this.getAmountBuffer(sendAmount), script: Buffer.from(sendScript, 'hex') }]

    if (hasChange) {
      const changeScript = this.generateScript(unusedAddress.address)
      outputs.push({ amount: this.getAmountBuffer(changeAmount), script: Buffer.from(changeScript, 'hex') })
    }

    const serializedOutputs = app.serializeTransactionOutputs({ outputs }).toString('hex')
    const signedTransaction = await app.createPaymentTransactionNew(ledgerInputs, paths, unusedAddress.derivationPath, serializedOutputs)

    return signedTransaction
  }
}
