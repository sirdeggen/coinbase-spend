import { PrivateKey, Transaction, P2PKH, Teranode } from '@bsv/sdk'
import { ArcadeBroadcaster } from './arcade.js'

export interface SpendOptions {
  wif: string
  coinbaseTxHex: string
  broadcastEndpoint: string
  arcadeEndpoint?: string
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

  const broadcaster = opts.arcadeEndpoint
    ? new ArcadeBroadcaster(opts.arcadeEndpoint)
    : new Teranode(opts.broadcastEndpoint)
  const result = await tx.broadcast(broadcaster)

  return { tx, result }
}
