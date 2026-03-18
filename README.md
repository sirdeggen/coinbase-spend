# coinbase-spend

CLI tool and library to spend coinbase transactions via Teranode using the [BSV SDK](https://github.com/bitcoin-sv/ts-sdk).

## Install

```bash
npm install coinbase-spend
```

## CLI Usage

```bash
npx coinbase-spend \
  -e https://your-teranode-endpoint \
  -t <coinbase-tx-hex> \
  -w <your-wif>
```

### Options

| Flag | Description | Default |
|------|-------------|---------|
| `-e, --endpoint <url>` | Teranode broadcast endpoint | **required** |
| `-t, --tx <hex>` | Coinbase transaction hex | **required** |
| `-w, --wif <key>` | Private key in WIF format | **required** |
| `-i, --index <number>` | Source output index | `0` |
| `-f, --fee <sats>` | Transaction fee in satoshis | `100` |

## Library Usage

```ts
import { spendCoinbase } from 'coinbase-spend'

const { tx, result } = await spendCoinbase({
  wif: 'your-wif',
  coinbaseTxHex: 'deadbeef...',
  broadcastEndpoint: 'https://your-teranode-endpoint',
  outputIndex: 0, // optional
  fee: 100,       // optional
})
```

## Build from Source

```bash
git clone https://github.com/sirdeggen/coinbase-spend.git
cd coinbase-spend
npm install
npm run build
```

## License

MIT
