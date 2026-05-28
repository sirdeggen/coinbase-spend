import { PrivateKey, Transaction, P2PKH, Script, NodejsHttpClient } from '@bsv/sdk'
import http from 'node:http'
import https from 'node:https'
import fs from 'node:fs'
import readline from 'node:readline'
import chalk from 'chalk'
import ArcadeBroadcater from './Arcade.js'

const DEFAULT_LANE_COUNT = 500
const MAX_BATCH_SIZE = 1000
const MAX_INFLIGHT = 3
const MAX_QUEUE_DEPTH = 3
const MAX_FAIL_COUNT = 3

interface LaneTip {
  tx: Transaction
  vout: number
  satoshis: number
  failCount: number
  dead: boolean
  generation: number
}

interface BatchEntry {
  tx: Transaction
  laneIdx: number
  prevTx: Transaction
  prevVout: number
  prevSats: number
  generation: number
}

export interface BlastOptions {
  wif: string
  coinbaseTxHex: string
  broadcastEndpoint: string
  outputIndex?: number
  rate: number
  lanes?: number
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

function isSuccessResult(result: any): boolean {
  if (result.status === 'success') return true

  const txStatus = (result.txStatus ?? '').toUpperCase()
  const extraInfo = (result.extraInfo ?? '').toUpperCase()

  const successStatuses = ['SEEN_ON_NETWORK', 'ACCEPTED_BY_NETWORK', 'MINED']
  if (successStatuses.some(s => txStatus.includes(s))) return true

  if (extraInfo.includes('BLOB_EXISTS') || extraInfo.includes('ALREADY_KNOWN')) return true
  if (txStatus.includes('BLOB_EXISTS') || txStatus.includes('ALREADY_KNOWN')) return true

  return false
}

export async function blast(opts: BlastOptions) {
  const key = PrivateKey.fromWif(opts.wif)
  const hash = key.toPublicKey().toHash() as number[]
  const p2pkh = new P2PKH()
  const laneCount = opts.lanes ?? DEFAULT_LANE_COUNT
  const sourceTransaction = Transaction.fromHex(opts.coinbaseTxHex)
  const sourceOutputIndex = opts.outputIndex ?? 0
  const sourceValue = sourceTransaction.outputs[sourceOutputIndex].satoshis!

  const arcade = new ArcadeBroadcater(opts.broadcastEndpoint, {
    httpClient: new NodejsHttpClient(opts.broadcastEndpoint.startsWith('http://') ? http : https)
  })

  const logStream = fs.createWriteStream(opts.logPath, { flags: 'a' })
  const opReturnScript = buildOpReturnScript(opts.message)

  // Detect zero-fee support
  let feeSats = 0
  let zeroFeeSupported = true

  // Stage 1: Fan-out transaction
  console.log(chalk.dim(`  Building fan-out transaction (${laneCount} lanes)...`))

  const perLaneSats = Math.floor(sourceValue / laneCount)

  if (perLaneSats <= 1) {
    throw new Error(`Insufficient funds: ${sourceValue} sats cannot support ${laneCount} lanes`)
  }

  const fanoutTx = new Transaction()
  fanoutTx.addInput({
    unlockingScriptTemplate: p2pkh.unlock(key),
    sourceTransaction,
    sourceOutputIndex,
  })

  for (let i = 0; i < laneCount; i++) {
    fanoutTx.addOutput({
      lockingScript: p2pkh.lock(hash),
      satoshis: perLaneSats,
    })
  }

  // Try zero fee first
  try {
    await fanoutTx.fee(0)
    zeroFeeSupported = true
    feeSats = 0
  } catch {
    await fanoutTx.fee(1)
    zeroFeeSupported = false
    feeSats = 1
    // Adjust last output to account for fee
    fanoutTx.outputs[laneCount - 1].satoshis = perLaneSats - 1
  }

  await fanoutTx.sign()

  console.log(chalk.dim('  Broadcasting fan-out transaction...'))
  const fanoutResult = await arcade.broadcast(fanoutTx)

  if (fanoutResult.status !== 'success') {
    // Dump the entire failure object — including the raw server response in
    // `more` — so opaque errors like "transaction failed validation" surface
    // their actual reason (mempool conflict, locking script, fee, etc.).
    console.error(chalk.red('  Fan-out failure detail:'))
    console.error(JSON.stringify(fanoutResult, null, 2))
    console.error(chalk.dim('  Fan-out tx hex:'), fanoutTx.toHex())
    try {
      console.error(chalk.dim('  Fan-out tx EF: '), fanoutTx.toHexEF())
    } catch { /* EF unavailable */ }
    const fail = fanoutResult as { description?: string }
    throw new Error(`Fan-out broadcast failed: ${fail.description ?? 'unknown error'} | full: ${JSON.stringify(fanoutResult)}`)
  }

  const fanoutTxid = fanoutResult.txid
  console.log(`  ${chalk.green('✔')} Fan-out tx: ${chalk.yellow(fanoutTxid)}`)
  console.log(`  ${chalk.dim(`  ${laneCount} lanes x ${perLaneSats} sats each`)}`)
  console.log(`  ${chalk.dim(`  Fee mode: ${zeroFeeSupported ? 'zero-fee' : '1-sat fee'}`)}`)
  console.log()

  logStream.write(`# fan-out: ${fanoutTxid}\n`)

  console.log(chalk.dim('  Waiting 2 seconds for fan-out to propagate...'))
  await new Promise(resolve => setTimeout(resolve, 2000))

  // Initialize lanes
  const lanes: LaneTip[] = []
  for (let i = 0; i < laneCount; i++) {
    lanes.push({
      tx: fanoutTx,
      vout: i,
      satoshis: i === laneCount - 1 && !zeroFeeSupported ? perLaneSats - 1 : perLaneSats,
      failCount: 0,
      dead: false,
      generation: 0,
    })
  }

  // Stage 2: Producer-Consumer Pipeline
  let running = true
  let paused = false
  let currentLane = 0
  let txCount = 0
  let failCount = 0
  let networkErrorCount = 0
  let deadLaneCount = 0
  const startTime = Date.now()
  let lastSecondCount = 0
  let lastSecondTime = Date.now()
  let targetRate = opts.rate
  let inflightCount = 0

  const queue: BatchEntry[][] = []

  // --- Interactive controls ---
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
        console.log(chalk.cyan('  Paused (press p to resume, r to change rate)'))
      } else {
        console.log(chalk.cyan(`  Resumed at ${targetRate} tx/sec`))
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

    let alive = 0
    for (const lane of lanes) {
      if (!lane.dead) alive++
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
    console.log(chalk.dim(`  Summary:`))
    console.log(chalk.dim(`    Successful txs:  ${txCount}`))
    console.log(chalk.dim(`    Failed txs:      ${failCount}`))
    console.log(chalk.dim(`    Network errors:  ${networkErrorCount}`))
    console.log(chalk.dim(`    Dead lanes:      ${deadLaneCount}`))
    console.log(chalk.dim(`    Lanes alive:     ${alive}/${laneCount}`))
    console.log(chalk.dim(`    Elapsed:         ${elapsed}s`))
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

  // --- Metrics ticker ---
  const metricsInterval = setInterval(() => {
    if (!running || paused) return
    const now = Date.now()
    const elapsed = (now - lastSecondTime) / 1000
    if (elapsed < 0.5) return
    const tps = Math.round((txCount - lastSecondCount) / elapsed)
    const alive = lanes.filter(l => !l.dead).length
    console.log(
      chalk.dim(`  ${tps} tx/sec`) +
      chalk.dim(' | ') +
      chalk.dim(`total: ${txCount}`) +
      chalk.dim(' | ') +
      chalk.dim(`lanes: ${alive}/${laneCount}`) +
      chalk.dim(' | ') +
      chalk.dim(`queue: ${queue.length}`)
    )
    lastSecondCount = txCount
    lastSecondTime = now
  }, 1000)

  // --- Builder loop (producer) ---
  const builderLoop = async () => {
    while (running) {
      if (paused) {
        await sleep(100)
        continue
      }

      if (queue.length >= MAX_QUEUE_DEPTH) {
        await sleep(10)
        continue
      }

      const batchSize = Math.min(targetRate, MAX_BATCH_SIZE)
      const batchesPerSecond = Math.ceil(targetRate / batchSize)
      const batchIntervalMs = Math.floor(1000 / batchesPerSecond)
      const tickStart = Date.now()

      // Build a batch
      const batch: BatchEntry[] = []
      let scannedAll = false

      for (let b = 0; b < batchSize; b++) {
        // Find next alive lane
        let attempts = 0
        while (attempts < laneCount) {
          const lane = lanes[currentLane]
          if (!lane.dead && lane.satoshis > feeSats) break
          currentLane = (currentLane + 1) % laneCount
          attempts++
        }

        if (attempts >= laneCount) {
          scannedAll = true
          break
        }

        const lane = lanes[currentLane]
        const laneIdx = currentLane
        const prevTx = lane.tx
        const prevVout = lane.vout
        const prevSats = lane.satoshis
        const gen = lane.generation

        // Build transaction: OP_RETURN at output 0, P2PKH at output 1
        const chainTx = new Transaction()
        chainTx.addInput({
          unlockingScriptTemplate: p2pkh.unlock(key),
          sourceTransaction: lane.tx,
          sourceOutputIndex: lane.vout,
        })

        chainTx.addOutput({
          lockingScript: opReturnScript,
          satoshis: 0,
        })

        const outputSats = lane.satoshis - feeSats
        chainTx.addOutput({
          lockingScript: p2pkh.lock(hash),
          satoshis: outputSats,
        })

        // Optimistic lane tip update
        lane.tx = chainTx
        lane.vout = 1  // P2PKH is always at index 1
        lane.satoshis = outputSats

        batch.push({ tx: chainTx, laneIdx, prevTx, prevVout, prevSats, generation: gen })

        currentLane = (currentLane + 1) % laneCount
      }

      if (scannedAll && batch.length === 0) {
        console.log()
        console.log(chalk.red('  All lanes exhausted or dead.'))
        running = false
        break
      }

      if (batch.length > 0) {
        // Sign all transactions in parallel
        // Fee is implicit from output amounts (input sats - output sats = feeSats)
        await Promise.all(batch.map(b => b.tx.sign()))

        queue.push(batch)
      }

      // Sleep for remainder of batch interval
      const elapsed = Date.now() - tickStart
      const sleepMs = Math.max(0, batchIntervalMs - elapsed)
      if (sleepMs > 0) {
        await sleep(sleepMs)
      }
    }
  }

  // --- Broadcaster loop (consumer) ---
  const broadcasterLoop = async () => {
    while (running || queue.length > 0) {
      if (queue.length === 0 || inflightCount >= MAX_INFLIGHT) {
        await sleep(5)
        continue
      }

      const batch = queue.shift()!
      inflightCount++

      // Fire and process — don't await inline so we can have multiple in-flight
      broadcastBatch(batch).finally(() => {
        inflightCount--
      })
    }
  }

  const describeError = (result: any): string => {
    return result.description || result.txStatus || result.extraInfo || 'unknown error'
  }

  const broadcastBatch = async (batch: BatchEntry[]) => {
    try {
      const results = await arcade.broadcastMany(batch.map(b => b.tx))

      let batchOk = 0
      let batchFail = 0
      const errorDescs = new Set<string>()

      for (let i = 0; i < batch.length; i++) {
        const b = batch[i]
        const result = (results[i] ?? { status: 'error', description: 'missing result' }) as any
        const lane = lanes[b.laneIdx]

        // Skip stale entries (lane was rolled back since this batch was built)
        if (lane.generation !== b.generation) continue

        if (isSuccessResult(result)) {
          txCount++
          batchOk++
          lane.failCount = 0
          // Free memory: cache the txid so the SDK no longer needs the
          // full sourceTransaction object for serialization (hash()).
          const input = b.tx.inputs[0]
          if (input?.sourceTransaction) {
            input.sourceTXID = b.tx.inputs[0].sourceTransaction!.id('hex')
            input.sourceTransaction = undefined
          }
          if (result.txid) {
            logStream.write(result.txid + '\n')
          }
        } else {
          const errDesc = describeError(result)
          errorDescs.add(errDesc)
          failCount++
          batchFail++

          // Log failure to file
          logStream.write(`${new Date().toISOString()} FAIL lane=${b.laneIdx} ${errDesc}\n`)

          // Rollback lane tip
          lane.tx = b.prevTx
          lane.vout = b.prevVout
          lane.satoshis = b.prevSats
          lane.failCount++
          lane.generation++

          if (lane.failCount >= MAX_FAIL_COUNT) {
            lane.dead = true
            deadLaneCount++
            const lastTxid = b.prevTx.id('hex')
            console.log(chalk.red(`  Lane ${b.laneIdx} died: ${errDesc} (last UTXO: ${lastTxid}:${b.prevVout})`))
          }
        }
      }

      if (batchFail > 0) {
        const errors = [...errorDescs].join(', ')
        console.log(chalk.dim(`  Batch: ${batchOk} ok, ${batchFail} failed [${errors}]`))
      }
    } catch (err: any) {
      // Network error — rollback all lanes in batch
      let affectedCount = 0
      for (const b of batch) {
        const lane = lanes[b.laneIdx]
        if (lane.generation !== b.generation) continue

        affectedCount++
        lane.tx = b.prevTx
        lane.vout = b.prevVout
        lane.satoshis = b.prevSats
        lane.failCount++
        lane.generation++
        if (lane.failCount >= MAX_FAIL_COUNT) {
          lane.dead = true
          deadLaneCount++
        }
      }
      networkErrorCount++
      console.log(chalk.red(`  Network error: ${err.message ?? err} (${affectedCount} lanes affected)`))
    }
  }

  // Run both loops concurrently
  await Promise.all([builderLoop(), broadcasterLoop()])

  clearInterval(metricsInterval)
  process.removeListener('SIGINT', shutdown)

  // If we exited due to all lanes dead, clean up
  if (!running) {
    cleanupStdin()
    logStream.end()
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
