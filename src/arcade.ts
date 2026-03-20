import { type Broadcaster, type BroadcastResponse, type BroadcastFailure, Transaction } from '@bsv/sdk'

export class ArcadeBroadcaster implements Broadcaster {
  private readonly baseURL: string

  constructor(baseURL: string) {
    this.baseURL = baseURL.replace(/\/$/, '')
  }

  async broadcast(tx: Transaction): Promise<BroadcastResponse | BroadcastFailure> {
    let response: Response
    try {
      response = await fetch(`${this.baseURL}/tx`, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: tx.toHex(),
      })
    } catch (err: unknown) {
      return {
        status: 'error',
        code: 'NETWORK_ERROR',
        description: err instanceof Error ? err.message : String(err),
      }
    }

    let body: string
    try {
      body = await response.text()
    } catch {
      body = ''
    }

    if (!response.ok) {
      return {
        status: 'error',
        code: `HTTP_${response.status}`,
        description: body || `HTTP ${response.status}`,
      }
    }

    let parsed: { txid?: string; txStatus?: string; extraInfo?: string; competingTxs?: string[] }
    try {
      parsed = JSON.parse(body)
    } catch {
      return {
        status: 'error',
        code: 'INVALID_RESPONSE',
        description: 'Arcade returned non-JSON response',
        more: { body },
      }
    }

    const txStatus = parsed.txStatus ?? ''
    if (txStatus === 'REJECTED' || txStatus === 'DOUBLE_SPEND_ATTEMPTED') {
      return {
        status: 'error',
        code: txStatus,
        txid: parsed.txid,
        description: parsed.extraInfo ? `${txStatus}: ${parsed.extraInfo}` : txStatus,
        more: parsed,
      }
    }

    return {
      status: 'success',
      txid: parsed.txid ?? '',
      message: txStatus,
      competingTxs: parsed.competingTxs,
    }
  }
}
