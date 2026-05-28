#!/usr/bin/env node
import { program, Option } from 'commander'
import chalk from 'chalk'
import { spendCoinbase } from './spend.js'
import { blast } from './blast.js'

const banner = `
${chalk.bold.cyan('╔══════════════════════════════════════╗')}
${chalk.bold.cyan('║')}  ${chalk.bold.white('⛏️  Coinbase Spend')}${chalk.dim.white(' — Teranode CLI')}  ${chalk.bold.cyan('║')}
${chalk.bold.cyan('╚══════════════════════════════════════╝')}
`

program
  .name('coinbase-spend')
  .description('Spend coinbase transactions via Teranode')
  .version('1.0.0')
  .addOption(new Option('-e, --endpoint <url>', 'Teranode broadcast endpoint').env('COINBASE_ENDPOINT').makeOptionMandatory(true))
  .addOption(new Option('-t, --tx <hex>', 'Coinbase transaction hex').env('COINBASE_TX').makeOptionMandatory(true))
  .addOption(new Option('-w, --wif <key>', 'Private key in WIF format').env('COINBASE_WIF').makeOptionMandatory(true))
  .addOption(new Option('-i, --index <number>', 'Source output index').env('COINBASE_INDEX').default('0'))
  .addOption(new Option('-f, --fee <sats>', 'Transaction fee in satoshis').env('COINBASE_FEE').default('100'))
  .addOption(new Option('-r, --rate <number>', 'Transactions per second (enables blast mode)').env('COINBASE_RATE'))
  .addOption(new Option('-n, --lanes <number>', 'Number of UTXO lanes for blast mode').env('COINBASE_LANES').default('500'))
  .addOption(new Option('-m, --message <text>', 'OP_RETURN message for blast mode').env('COINBASE_MESSAGE'))
  .addOption(new Option('-l, --log <path>', 'Log file path for transaction IDs').env('COINBASE_LOG'))
  .action(async (opts) => {
    console.log(banner)

    console.log(chalk.dim('  Endpoint:'), chalk.yellow(opts.endpoint))
    console.log(chalk.dim('  Tx hex:  '), chalk.yellow(opts.tx.slice(0, 16) + '...'))
    console.log(chalk.dim('  Output:  '), chalk.yellow(opts.index))
    console.log(chalk.dim('  Fee:     '), chalk.yellow(`${opts.fee} sats`))

    if (opts.rate) {
      const rate = parseInt(opts.rate)
      const lanes = parseInt(opts.lanes)
      const logPath = opts.log ?? `broadcast-${Date.now()}.log`
      console.log(chalk.dim('  Rate:    '), chalk.yellow(`${rate} tx/sec`))
      console.log(chalk.dim('  Lanes:   '), chalk.yellow(`${lanes}`))
      console.log(chalk.dim('  Fee:     '), chalk.yellow('zero-fee (with 1-sat fallback)'))
      if (opts.message) {
        console.log(chalk.dim('  Message: '), chalk.yellow(opts.message))
      }
      console.log(chalk.dim('  Log:     '), chalk.yellow(logPath))
      console.log()

      try {
        await blast({
          wif: opts.wif,
          coinbaseTxHex: opts.tx,
          broadcastEndpoint: opts.endpoint,
          outputIndex: parseInt(opts.index),
          rate,
          lanes,
          message: opts.message,
          logPath,
        })
      } catch (err: any) {
        console.log(`  ${chalk.red('✖')} ${chalk.bold.red('Rate broadcast failed')}`)
        console.log()
        console.log(chalk.dim('  Error:'), chalk.red(err.message ?? err))
        console.log()
        process.exit(1)
      }
    } else {
      console.log()

      const spinner = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
      let i = 0
      const interval = setInterval(() => {
        process.stdout.write(`\r  ${chalk.cyan(spinner[i++ % spinner.length])} ${chalk.dim('Broadcasting transaction...')}`)
      }, 80)

      try {
        const { result } = await spendCoinbase({
          wif: opts.wif,
          coinbaseTxHex: opts.tx,
          broadcastEndpoint: opts.endpoint,
          outputIndex: parseInt(opts.index),
          fee: parseInt(opts.fee),
        })

        clearInterval(interval)
        process.stdout.write('\r')
        console.log(`  ${chalk.green('✔')} ${chalk.bold.green('Transaction broadcast successfully!')}`)
        console.log()
        console.log(chalk.dim('  Result:'), chalk.white(JSON.stringify(result, null, 2)))
        console.log()
      } catch (err: any) {
        clearInterval(interval)
        process.stdout.write('\r')
        console.log(`  ${chalk.red('✖')} ${chalk.bold.red('Broadcast failed')}`)
        console.log()
        console.log(chalk.dim('  Error:'), chalk.red(err.message ?? err))
        console.log()
        process.exit(1)
      }
    }
  })

program.parse()
