#!/usr/bin/env node
import { program } from 'commander'
import chalk from 'chalk'
import { spendCoinbase } from './spend.js'

const banner = `
${chalk.bold.cyan('╔══════════════════════════════════════╗')}
${chalk.bold.cyan('║')}  ${chalk.bold.white('⛏️  Coinbase Spend')}${chalk.dim.white(' — Teranode CLI')}  ${chalk.bold.cyan('║')}
${chalk.bold.cyan('╚══════════════════════════════════════╝')}
`

program
  .name('coinbase-spend')
  .description('Spend coinbase transactions via Teranode')
  .version('1.0.0')
  .requiredOption('-e, --endpoint <url>', 'Teranode broadcast endpoint')
  .requiredOption('-t, --tx <hex>', 'Coinbase transaction hex')
  .requiredOption('-w, --wif <key>', 'Private key in WIF format')
  .option('-i, --index <number>', 'Source output index', '0')
  .option('-f, --fee <sats>', 'Transaction fee in satoshis', '100')
  .action(async (opts) => {
    console.log(banner)

    console.log(chalk.dim('  Endpoint:'), chalk.yellow(opts.endpoint))
    console.log(chalk.dim('  Tx hex:  '), chalk.yellow(opts.tx.slice(0, 16) + '...'))
    console.log(chalk.dim('  Output:  '), chalk.yellow(opts.index))
    console.log(chalk.dim('  Fee:     '), chalk.yellow(`${opts.fee} sats`))
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
  })

program.parse()
