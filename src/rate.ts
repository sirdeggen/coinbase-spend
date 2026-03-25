import { PrivateKey, Transaction, P2PKH, NodejsHttpClient } from '@bsv/sdk'
import https from 'node:https'
import fs from 'node:fs'
import chalk from 'chalk'
import ArcadeBroadcater from './Arcade.js'

interface LaneTip {
  tx: Transaction
  vout: number
  satoshis: number
  failCount: number
  dead: boolean
}

export interface RateSpendOptions {
  wif: string
  coinbaseTxHex: string
  broadcastEndpoint: string
  outputIndex?: number
  fee?: number
  rate: number
  logPath: string
}

export async function rateSpend(opts: RateSpendOptions) {
  const key = PrivateKey.fromWif(opts.wif)
  const hash = key.toPublicKey().toHash() as number[]
  const p2pkh = new P2PKH()
  const fee = opts.fee ?? 100
  const rate = opts.rate
  const sourceTransaction = Transaction.fromHex(opts.coinbaseTxHex)
  const sourceOutputIndex = opts.outputIndex ?? 0
  const sourceValue = sourceTransaction.outputs[sourceOutputIndex].satoshis!

  const arcade = new ArcadeBroadcater(opts.broadcastEndpoint, {
    httpClient: new NodejsHttpClient(https)
  })

  const logStream = fs.createWriteStream(opts.logPath, { flags: 'a' })

  // Step 1: Fan-out transaction
  console.log(chalk.dim('  Building fan-out transaction...'))

  const fanoutFee = fee * rate
  const perLaneSats = Math.floor((sourceValue - fanoutFee) / rate)

  if (perLaneSats <= fee) {
    throw new Error(`Insufficient funds: ${sourceValue} sats cannot support ${rate} lanes after fees`)
  }

  const fanoutTx = new Transaction()
  fanoutTx.addInput({
    unlockingScriptTemplate: p2pkh.unlock(key),
    sourceTransaction,
    sourceOutputIndex,
  })

  for (let i = 0; i < rate; i++) {
    fanoutTx.addOutput({
      lockingScript: p2pkh.lock(hash),
      satoshis: perLaneSats,
    })
  }

  await fanoutTx.fee(fanoutFee)
  await fanoutTx.sign()

  console.log(chalk.dim('  Broadcasting fan-out transaction...'))
  const fanoutResult = await arcade.broadcast(fanoutTx)

  if (fanoutResult.status !== 'success') {
    const fail = fanoutResult as { description?: string }
    throw new Error(`Fan-out broadcast failed: ${fail.description ?? 'unknown error'}`)
  }

  const fanoutTxid = fanoutResult.txid
  console.log(`  ${chalk.green('✔')} Fan-out tx: ${chalk.yellow(fanoutTxid)}`)
  console.log(`  ${chalk.dim(`  ${rate} lanes × ${perLaneSats} sats each`)}`)
  console.log()

  logStream.write(`# fan-out: ${fanoutTxid}\n`)

  // Initialize lanes
  const lanes: LaneTip[] = []
  for (let i = 0; i < rate; i++) {
    lanes.push({
      tx: fanoutTx,
      vout: i,
      satoshis: perLaneSats,
      failCount: 0,
      dead: false,
    })
  }

  // Step 2: Broadcast loop
  let running = true
  let paused = false
  let currentLane = 0
  let txCount = 0
  const intervalMs = 1000 / rate

  const cleanupStdin = () => {
    process.stdin.removeListener('data', onKey)
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false)
    }
    process.stdin.pause()
  }

  const onKey = (data: Buffer) => {
    const ch = data.toString()
    if (ch === 'p') {
      paused = !paused
      if (paused) {
        console.log(chalk.cyan('  ⏸ Paused (press p to resume)'))
      } else {
        console.log(chalk.cyan('  ▶ Resumed'))
      }
    } else if (ch === '\x03') {
      shutdown()
    }
  }

  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true)
  }
  process.stdin.resume()
  process.stdin.on('data', onKey)

  const shutdown = () => {
    if (!running) return
    running = false
    cleanupStdin()
    console.log()
    console.log(chalk.yellow('  Shutting down...'))
    console.log()

    // Print lane tips for resumability
    for (let i = 0; i < lanes.length; i++) {
      const lane = lanes[i]
      const status = lane.dead ? chalk.red('dead') : chalk.green('live')
      const txid = lane.tx.id('hex')
      console.log(chalk.dim(`  Lane ${i} [${status}${chalk.dim(']:')} ${txid}:${lane.vout} (${lane.satoshis} sats)`))
    }

    // Print current UTXO being spent
    const current = lanes[currentLane]
    console.log()
    console.log(chalk.bold('  Last UTXO:'), `${current.tx.id('hex')}:${current.vout}`)
    console.log()

    logStream.end()
  }

  process.on('SIGINT', shutdown)

  while (running) {
    if (paused) {
      await new Promise(resolve => setTimeout(resolve, 100))
      continue
    }

    const loopStart = Date.now()

    // Find next non-dead, non-exhausted lane
    let attempts = 0
    while (attempts < rate) {
      const lane = lanes[currentLane]
      if (!lane.dead && lane.satoshis > fee) break
      currentLane = (currentLane + 1) % rate
      attempts++
    }

    // All lanes dead or exhausted
    if (attempts >= rate) {
      console.log()
      console.log(chalk.red('  All lanes exhausted or dead.'))
      console.log()
      for (let i = 0; i < lanes.length; i++) {
        const lane = lanes[i]
        const txid = lane.tx.id('hex')
        console.log(chalk.dim(`  Lane ${i}: ${txid}:${lane.vout} (${lane.satoshis} sats)`))
      }
      logStream.end()
      cleanupStdin()
      process.removeListener('SIGINT', shutdown)
      return
    }

    const lane = lanes[currentLane]

    try {
      const chainTx = new Transaction()
      chainTx.addInput({
        unlockingScriptTemplate: p2pkh.unlock(key),
        sourceTransaction: lane.tx,
        sourceOutputIndex: lane.vout,
      })

      const outputSats = lane.satoshis - fee
      chainTx.addOutput({
        lockingScript: p2pkh.lock(hash),
        satoshis: outputSats,
      })

      await chainTx.fee(fee)
      await chainTx.sign()

      const result = await arcade.broadcast(chainTx)

      if (result.status === 'success') {
        txCount++
        lane.tx = chainTx
        lane.vout = 0
        lane.satoshis = outputSats
        lane.failCount = 0

        const txid = result.txid
        logStream.write(txid + '\n')
        console.log(
          chalk.dim(`  [${txCount}]`) +
          ` lane:${currentLane}  ` +
          chalk.dim('txid:') + chalk.yellow(txid) +
          chalk.dim(`  (${outputSats} sats remaining)`)
        )
      } else {
        lane.failCount++
        const fail = result as { description?: string }
        console.log(
          chalk.red(`  [!] lane:${currentLane} broadcast failed: ${fail.description ?? 'unknown'}`) +
          chalk.dim(` (${lane.failCount}/3)`)
        )
        if (lane.failCount >= 3) {
          lane.dead = true
          console.log(chalk.red(`  [x] lane:${currentLane} marked dead after 3 consecutive failures`))
        }
      }
    } catch (err: any) {
      lane.failCount++
      console.log(
        chalk.red(`  [!] lane:${currentLane} error: ${err.message ?? err}`) +
        chalk.dim(` (${lane.failCount}/3)`)
      )
      if (lane.failCount >= 3) {
        lane.dead = true
        console.log(chalk.red(`  [x] lane:${currentLane} marked dead after 3 consecutive failures`))
      }
    }

    currentLane = (currentLane + 1) % rate

    // Sleep for remainder of interval
    const elapsed = Date.now() - loopStart
    const sleepMs = Math.max(0, intervalMs - elapsed)
    if (sleepMs > 0) {
      await new Promise(resolve => setTimeout(resolve, sleepMs))
    }
  }

  process.removeListener('SIGINT', shutdown)
}
