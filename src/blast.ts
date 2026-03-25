import { PrivateKey, Transaction, P2PKH, Script, NodejsHttpClient } from '@bsv/sdk'
import https from 'node:https'
import fs from 'node:fs'
import readline from 'node:readline'
import chalk from 'chalk'
import ArcadeBroadcater from './Arcade.js'

const LANE_COUNT = 2000
const FEE_SATS = 1
const BATCH_INTERVAL_MS = 100
const MAX_FAIL_COUNT = 3

interface LaneTip {
  tx: Transaction
  vout: number
  satoshis: number
  failCount: number
  dead: boolean
}

export interface BlastOptions {
  wif: string
  coinbaseTxHex: string
  broadcastEndpoint: string
  outputIndex?: number
  rate: number
  message?: string
  logPath: string
}

function buildOpReturnScript(message?: string): Script {
  const msg = message ?? 'Who is John Galt?'
  const data = Buffer.from(msg, 'utf8')
  return new Script()
    .writeOpCode(0)        // OP_FALSE
    .writeOpCode(106)      // OP_RETURN
    .writeBin([...data])
}

export async function blast(opts: BlastOptions) {
  const key = PrivateKey.fromWif(opts.wif)
  const hash = key.toPublicKey().toHash() as number[]
  const p2pkh = new P2PKH()
  const rate = opts.rate
  const sourceTransaction = Transaction.fromHex(opts.coinbaseTxHex)
  const sourceOutputIndex = opts.outputIndex ?? 0
  const sourceValue = sourceTransaction.outputs[sourceOutputIndex].satoshis!

  const arcade = new ArcadeBroadcater(opts.broadcastEndpoint, {
    httpClient: new NodejsHttpClient(https)
  })

  const logStream = fs.createWriteStream(opts.logPath, { flags: 'a' })
  const opReturnScript = buildOpReturnScript(opts.message)

  // Stage 1: Fan-out transaction
  console.log(chalk.dim(`  Building fan-out transaction (${LANE_COUNT} lanes)...`))

  const fanoutFee = FEE_SATS * LANE_COUNT
  const perLaneSats = Math.floor((sourceValue - fanoutFee) / LANE_COUNT)

  if (perLaneSats <= FEE_SATS) {
    throw new Error(`Insufficient funds: ${sourceValue} sats cannot support ${LANE_COUNT} lanes after fees`)
  }

  const fanoutTx = new Transaction()
  fanoutTx.addInput({
    unlockingScriptTemplate: p2pkh.unlock(key),
    sourceTransaction,
    sourceOutputIndex,
  })

  for (let i = 0; i < LANE_COUNT; i++) {
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
  console.log(`  ${chalk.dim(`  ${LANE_COUNT} lanes × ${perLaneSats} sats each`)}`)
  console.log()

  logStream.write(`# fan-out: ${fanoutTxid}\n`)

  console.log(chalk.dim('  Waiting 2 seconds for fan-out to propagate...'))
  await new Promise(resolve => setTimeout(resolve, 2000))

  // Initialize lanes
  const lanes: LaneTip[] = []
  for (let i = 0; i < LANE_COUNT; i++) {
    lanes.push({
      tx: fanoutTx,
      vout: i,
      satoshis: perLaneSats,
      failCount: 0,
      dead: false,
    })
  }

  // Stage 2: Blast loop
  let running = true
  let paused = false
  let currentLane = 0
  let txCount = 0
  let lastSecondCount = 0
  let lastSecondTime = Date.now()

  const cleanupStdin = () => {
    process.stdin.removeListener('data', onKey)
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false)
    }
    process.stdin.pause()
  }

  let ratePromptActive = false

  const promptRate = () => {
    ratePromptActive = true
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false)
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    rl.question(chalk.cyan('  Enter new rate (tx/sec): '), (answer) => {
      rl.close()
      const newRate = parseInt(answer)
      if (!isNaN(newRate) && newRate > 0) {
        targetRate = newRate
        console.log(chalk.cyan(`  Rate set to ${targetRate} tx/sec`))
      } else {
        console.log(chalk.red('  Invalid rate, keeping current'))
      }
      console.log(chalk.cyan('  Press p to resume, r to change rate'))
      ratePromptActive = false
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(true)
      }
      process.stdin.resume()
    })
  }

  const onKey = (data: Buffer) => {
    if (ratePromptActive) return
    const ch = data.toString()
    if (ch === 'p') {
      paused = !paused
      if (paused) {
        console.log(chalk.cyan('  ⏸ Paused (press p to resume, r to change rate)'))
      } else {
        console.log(chalk.cyan(`  ▶ Resumed at ${targetRate} tx/sec`))
      }
    } else if (ch === 'r' && paused) {
      promptRate()
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
    let alive = 0
    for (let i = 0; i < lanes.length; i++) {
      const lane = lanes[i]
      if (!lane.dead) alive++
    }
    console.log(chalk.dim(`  ${alive}/${LANE_COUNT} lanes alive, ${txCount} total transactions`))
    console.log()

    for (let i = 0; i < lanes.length; i++) {
      const lane = lanes[i]
      const status = lane.dead ? chalk.red('dead') : chalk.green('live')
      const txid = lane.tx.id('hex')
      console.log(chalk.dim(`  Lane ${i} [${status}${chalk.dim(']:')} ${txid}:${lane.vout} (${lane.satoshis} sats)`))
    }
    console.log()

    logStream.end()
  }

  process.on('SIGINT', shutdown)

  let targetRate = rate

  while (running) {
    const tickStart = Date.now()

    if (paused) {
      await new Promise(resolve => setTimeout(resolve, 100))
      continue
    }

    // Compute batch size from current target rate (10 ticks/sec)
    const batchSize = Math.ceil(targetRate / 10)

    // Find batchSize transactions to build
    const batch: { tx: Transaction; laneIdx: number; prevTx: Transaction; prevVout: number; prevSats: number }[] = []
    let allExhausted = false

    for (let b = 0; b < batchSize; b++) {
      // Find next alive lane
      let attempts = 0
      while (attempts < LANE_COUNT) {
        const lane = lanes[currentLane]
        if (!lane.dead && lane.satoshis > FEE_SATS) break
        currentLane = (currentLane + 1) % LANE_COUNT
        attempts++
      }

      if (attempts >= LANE_COUNT) {
        allExhausted = true
        break
      }

      const lane = lanes[currentLane]
      const laneIdx = currentLane
      const prevTx = lane.tx
      const prevVout = lane.vout
      const prevSats = lane.satoshis

      const chainTx = new Transaction()
      chainTx.addInput({
        unlockingScriptTemplate: p2pkh.unlock(key),
        sourceTransaction: lane.tx,
        sourceOutputIndex: lane.vout,
      })

      const outputSats = lane.satoshis - FEE_SATS
      chainTx.addOutput({
        lockingScript: p2pkh.lock(hash),
        satoshis: outputSats,
      })

      chainTx.addOutput({
        lockingScript: opReturnScript,
        satoshis: 0,
      })

      // Optimistic update — advance lane tip before broadcast
      lane.tx = chainTx
      lane.vout = 0
      lane.satoshis = outputSats

      batch.push({ tx: chainTx, laneIdx, prevTx, prevVout, prevSats })

      currentLane = (currentLane + 1) % LANE_COUNT
    }

    if (allExhausted && batch.length === 0) {
      console.log()
      console.log(chalk.red('  All lanes exhausted or dead.'))
      logStream.end()
      cleanupStdin()
      process.removeListener('SIGINT', shutdown)
      return
    }

    // Sign all transactions in parallel
    await Promise.all(batch.map(b => b.tx.sign()))

    // Batch broadcast
    try {
      const results = await arcade.broadcastMany(batch.map(b => b.tx))

      for (let i = 0; i < results.length; i++) {
        const result = results[i] as { status?: string; txid?: string; description?: string }
        const b = batch[i]
        const lane = lanes[b.laneIdx]

        if (result.status === 'success') {
          txCount++
          lane.failCount = 0
          // Null out sourceTransaction on the prev tx to free memory
          const input = b.tx.inputs[0]
          if (input) {
            input.sourceTransaction = undefined
          }
          if (result.txid) {
            logStream.write(result.txid + '\n')
          }
        } else {
          // Rollback lane tip
          lane.tx = b.prevTx
          lane.vout = b.prevVout
          lane.satoshis = b.prevSats
          lane.failCount++

          if (lane.failCount >= MAX_FAIL_COUNT) {
            lane.dead = true
          }
        }
      }
    } catch (err: any) {
      // Rollback all lanes in batch
      for (const b of batch) {
        const lane = lanes[b.laneIdx]
        lane.tx = b.prevTx
        lane.vout = b.prevVout
        lane.satoshis = b.prevSats
        lane.failCount++
        if (lane.failCount >= MAX_FAIL_COUNT) {
          lane.dead = true
        }
      }
    }

    // Metrics every second
    const now = Date.now()
    if (now - lastSecondTime >= 1000) {
      const elapsed = (now - lastSecondTime) / 1000
      const tps = Math.round((txCount - lastSecondCount) / elapsed)
      const alive = lanes.filter(l => !l.dead && l.satoshis > FEE_SATS).length
      console.log(
        chalk.dim(`  ${tps} tx/sec`) +
        chalk.dim(' | ') +
        chalk.dim(`total: ${txCount}`) +
        chalk.dim(' | ') +
        chalk.dim(`lanes alive: ${alive}/${LANE_COUNT}`)
      )
      lastSecondCount = txCount
      lastSecondTime = now
    }

    // Sleep for remainder of tick interval
    const elapsed = Date.now() - tickStart
    const sleepMs = Math.max(0, BATCH_INTERVAL_MS - elapsed)
    if (sleepMs > 0) {
      await new Promise(resolve => setTimeout(resolve, sleepMs))
    }
  }

  process.removeListener('SIGINT', shutdown)
}
