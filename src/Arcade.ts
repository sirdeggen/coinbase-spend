import { Transaction, 
    BroadcastResponse, BroadcastFailure, Broadcaster, HttpClient, Utils, Random, HttpClientRequestOptions, defaultHttpClient } from '@bsv/sdk'

const { toHex } = Utils

/** Configuration options for the ARC broadcaster. */
export interface ArcConfig {
  /** Authentication token for the ARC API */
  apiKey?: string
  /** The HTTP client used to make requests to the ARC API. */
  httpClient?: HttpClient
  /** Deployment id used annotating api calls in XDeployment-ID header - this value will be randomly generated if not set */
  deploymentId?: string
  /** notification callback endpoint for proofs and double spend notification */
  callbackUrl?: string
  /** default access token for notification callback endpoint. It will be used as a Authorization header for the http callback */
  callbackToken?: string
  /** additional headers to be attached to all tx submissions. */
  headers?: Record<string, string>
}

function defaultDeploymentId (): string {
  return `ts-sdk-${toHex(Random(16))}`
}

/**
 * Represents an ArcadeBroadcater transaction broadcaster.
 */
export default class ArcadeBroadcater implements Broadcaster {
  readonly URL: string
  readonly apiKey: string | undefined
  readonly deploymentId: string
  readonly callbackUrl: string | undefined
  readonly callbackToken: string | undefined
  readonly headers: Record<string, string> | undefined
  private readonly httpClient: HttpClient

  /**
   * Constructs an instance of the ARC broadcaster.
   *
   * @param {string} URL - The URL endpoint for the ARC API.
   * @param {ArcConfig} config - Configuration options for the ARC broadcaster.
   */
  constructor (URL: string, config?: ArcConfig)
  /**
   * Constructs an instance of the ARC broadcaster.
   *
   * @param {string} URL - The URL endpoint for the ARC API.
   * @param {string} apiKey - The API key used for authorization with the ARC API.
   */
  constructor (URL: string, apiKey?: string)

  constructor (URL: string, config?: string | ArcConfig) {
    this.URL = URL
    if (typeof config === 'string') {
      this.apiKey = config
      this.httpClient = defaultHttpClient()
      this.deploymentId = defaultDeploymentId()
      this.callbackToken = undefined
      this.callbackUrl = undefined
    } else {
      const configObj: ArcConfig = config ?? {}
      const {
        apiKey,
        deploymentId,
        httpClient,
        callbackToken,
        callbackUrl,
        headers
      } = configObj
      this.apiKey = apiKey
      this.httpClient = httpClient ?? defaultHttpClient()
      this.deploymentId = deploymentId ?? defaultDeploymentId()
      this.callbackToken = callbackToken
      this.callbackUrl = callbackUrl
      this.headers = headers
    }
  }

  /**
   * Constructs a dictionary of the default & supplied request headers.
   */
  private requestHeaders (): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'XDeployment-ID': this.deploymentId
    }

    if (this.apiKey != null && this.apiKey !== '') {
      headers.Authorization = `Bearer ${this.apiKey}`
    }

    if (this.callbackUrl != null && this.callbackUrl !== '') {
      headers['X-CallbackUrl'] = this.callbackUrl
    }

    if (this.callbackToken != null && this.callbackToken !== '') {
      headers['X-CallbackToken'] = this.callbackToken
    }

    if (this.headers != null) {
      for (const key in this.headers) {
        headers[key] = this.headers[key]
      }
    }

    return headers
  }

  /**
   * Broadcasts a transaction via ARC.
   *
   * @param {Transaction} tx - The transaction to be broadcasted.
   * @returns {Promise<BroadcastResponse | BroadcastFailure>} A promise that resolves to either a success or failure response.
   */
  async broadcast (
    tx: Transaction
  ): Promise<BroadcastResponse | BroadcastFailure> {
    let rawTx: string
    try {
      rawTx = tx.toHexEF()
    } catch (error: unknown) {
      if (
        typeof error === 'object' && error !== null && 'message' in error &&
        error.message ===
        'All inputs must have source transactions when serializing to EF format'
      ) {
        rawTx = tx.toHex()
      } else {
        throw error
      }
    }

    const requestOptions: HttpClientRequestOptions = {
      method: 'POST',
      headers: this.requestHeaders(),
      data: { rawTx }
    }

    try {
      const response = await this.httpClient.request<ArcResponse>(
        `${this.URL}/tx`,
        requestOptions
      )
      if (response.ok) {
        const data = response.data ?? {} as any
        // Server may return {"status": "submitted"} without a txid — compute locally
        const txid = data.txid ?? tx.id('hex')
        const status = data.status ?? data.txStatus ?? ''
        const extraInfo = data.extraInfo ?? ''

        const errorStatuses = [
          'DOUBLE_SPEND_ATTEMPTED',
          'REJECTED',
          'INVALID',
          'MALFORMED',
          'MINED_IN_STALE_BLOCK'
        ]

        const upperStatus = status.toUpperCase()
        const upperExtra = extraInfo.toUpperCase()
        const isOrphan = upperExtra.includes('ORPHAN') || upperStatus.includes('ORPHAN')

        if (errorStatuses.includes(upperStatus) || isOrphan) {
          const failure: BroadcastFailure = {
            status: 'error',
            code: status || 'UNKNOWN',
            txid,
            description: `${status} ${extraInfo}`.trim()
          }
          if (data.competingTxs != null) {
            failure.more = { competingTxs: data.competingTxs }
          }
          return failure
        }

        return {
          status: 'success',
          txid,
          message: `${status} ${extraInfo}`.trim() || 'submitted'
        }
      } else {
        const r: BroadcastFailure = {
          status: 'error',
          code: String(response.status ?? 'ERR_UNKNOWN'),
          description: 'Unknown error'
        }
        let d = response.data as any
        if (typeof d === 'string') {
          try { d = JSON.parse(d) } catch { /* ignore */ }
        }
        if (d != null && typeof d === 'object') {
          r.more = d
          if (typeof d.error === 'string') r.description = d.error
          else if (typeof d.detail === 'string') r.description = d.detail
        }
        return r
      }
    } catch (error: unknown) {
      return {
        status: 'error',
        code: '500',
        description:
          typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string'
            ? error.message
            : 'Internal Server Error'
      }
    }
  }

  /**
   * Broadcasts multiple transactions via ARC using concatenated raw bytes.
   * The server expects application/octet-stream and returns {"submitted": N}.
   * The first N transactions are treated as successful; the rest as failed.
   *
   * @param {Transaction[]} txs - Array of transactions to be broadcasted.
   * @returns {Promise<Array<object>>} Per-transaction result objects.
   */
  async broadcastMany (txs: Transaction[]): Promise<object[]> {
    // Serialize each tx to raw bytes and concatenate
    const chunks: number[][] = txs.map(tx => tx.toEF())
    let totalLen = 0
    for (const c of chunks) totalLen += c.length
    const body = Buffer.alloc(totalLen)
    let offset = 0
    for (const c of chunks) {
      for (let j = 0; j < c.length; j++) body[offset++] = c[j]
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/octet-stream',
      'XDeployment-ID': this.deploymentId
    }
    if (this.apiKey != null && this.apiKey !== '') {
      headers.Authorization = `Bearer ${this.apiKey}`
    }
    if (this.headers != null) {
      for (const key in this.headers) {
        headers[key] = this.headers[key]
      }
    }

    try {
      const response = await fetch(`${this.URL}/txs`, {
        method: 'POST',
        headers,
        body
      })

      const data = await response.json() as any

      if (!response.ok) {
        const desc = data.error ?? `HTTP ${response.status}`
        const submitted = typeof data.parsed === 'number' ? data.parsed : 0
        return txs.map((tx, i) =>
          i < submitted
            ? { status: 'success', txid: tx.id('hex') }
            : { status: 'error', code: String(response.status), description: desc }
        )
      }

      const submitted = typeof data.submitted === 'number' ? data.submitted : txs.length
      return txs.map((tx, i) =>
        i < submitted
          ? { status: 'success', txid: tx.id('hex') }
          : { status: 'error', code: 'NOT_SUBMITTED', description: 'transaction not submitted' }
      )
    } catch (error: unknown) {
      const desc = typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string'
        ? error.message
        : 'Internal Server Error'
      return txs.map(() => ({
        status: 'error',
        code: '500',
        description: desc
      }))
    }
  }
}

interface ArcResponse {
  status?: string
  txid?: string
  extraInfo?: string
  txStatus?: string
  competingTxs?: string[]
}
