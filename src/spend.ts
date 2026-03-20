import { PrivateKey, Transaction, P2PKH, NodejsHttpClient } from '@bsv/sdk'
import https from 'node:https'
import ArcadeBroadcater from './Arcade.js'

export interface SpendOptions {
  wif: string
  coinbaseTxHex: string
  broadcastEndpoint: string
  outputIndex?: number
  fee?: number
}

export async function spendCoinbase(opts: SpendOptions) {
  const key = PrivateKey.fromWif(opts.wif)
  const hash = key.toPublicKey().toHash() as number[]

  const sourceTransaction = Transaction.fromHex(opts.coinbaseTxHex)

  const p2pkh = new P2PKH()

  const tx = new Transaction()
  tx.addInput({
    unlockingScriptTemplate: p2pkh.unlock(key),
    sourceTransaction,
    sourceOutputIndex: opts.outputIndex ?? 0,
  })
  tx.addOutput({
    change: true,
    lockingScript: p2pkh.lock(hash),
  })
  await tx.fee(opts.fee ?? 100)
  await tx.sign()

  const arcade = new ArcadeBroadcater(opts.broadcastEndpoint, {
    httpClient: new NodejsHttpClient(https)
  })

  const result = await arcade.broadcast(tx)

  return { tx, result }
}
