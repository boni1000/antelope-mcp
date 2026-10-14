/**
 * Minimal Antelope chain client: JSON reads over the chain API, plus transaction building
 * (WharfKit) for read-only calls and dry runs. The endpoint is fixed by configuration —
 * tools never take a URL argument, so an agent cannot point the server elsewhere.
 */
import {
  ABI,
  Action,
  APIClient,
  PackedTransaction,
  SignedTransaction,
  Transaction,
  type ABIDef,
} from '@wharfkit/antelope'

export type ActionInput = {
  account: string
  name: string
  authorization: { actor: string; permission: string }[]
  data: Record<string, unknown>
}

export class ChainError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message)
  }
}

/** A value from an exception's data, readable: permission levels as actor@permission. */
function show(v: unknown): string {
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>
    if ('actor' in o && 'permission' in o) return `${o.actor}@${o.permission}`
    return JSON.stringify(v)
  }
  return String(v)
}

/** A chain exception as text: the first stack entry's format with its ${placeholders} filled in. */
export function exceptText(except: any): string {
  const entry = except?.stack?.[0]
  const text = entry?.format
    ? String(entry.format).replace(/\$\{(\w+)\}/g, (m: string, k: string) => (entry.data?.[k] !== undefined ? show(entry.data[k]) : m))
    : except?.message ?? except?.what ?? 'transaction failed'
  return text.replace(/^assertion failure with message: /, '')
}

/** The useful part of an Antelope API error: the first detail message, without the C++ file/line. */
export function errorText(body: unknown): string {
  const b = body as { error?: { what?: string; details?: { message?: string }[] }; message?: string }
  const detail = b?.error?.details?.[0]?.message
  if (detail && !/\$\{\w+\}/.test(detail)) return detail.replace(/^assertion failure with message: /, '')
  return b?.error?.what || b?.message || 'unknown chain API error'
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Statuses that mean "too many requests, try later" (nginx limit_req answers 503 by default). */
const THROTTLED = new Set([429, 503])
const MAX_RETRIES = 4

export class Chain {
  readonly client: APIClient
  private abiCache = new Map<string, ABI>()
  private readonly minIntervalMs: number
  private nextSlot = 0

  /** maxRps: requests per second this server sends to the node at most (public nodes rate-limit). */
  constructor(readonly url: string, readonly timeoutMs = 15000, maxRps = 15) {
    this.url = url.replace(/\/+$/, '')
    this.client = new APIClient({ url: this.url })
    this.minIntervalMs = 1000 / maxRps
  }

  /** Wait for this request's slot so that requests stay under maxRps. */
  private async pace() {
    const now = Date.now()
    const slot = Math.max(now, this.nextSlot)
    this.nextSlot = slot + this.minIntervalMs
    if (slot > now) await sleep(slot - now)
  }

  async rpc<T = any>(path: string, body: unknown = {}): Promise<T> {
    let res!: Response
    let text = ''
    for (let attempt = 0; ; attempt++) {
      await this.pace()
      try {
        res = await fetch(`${this.url}${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(this.timeoutMs),
        })
        text = await res.text()
      } catch (e) {
        // Connection refused, reset or cut mid-response ("terminated"): retry, then give up.
        if (attempt >= MAX_RETRIES) throw new ChainError(`chain API unreachable: ${(e as Error).message}`)
        await sleep(500 * 2 ** attempt)
        continue
      }
      if (!THROTTLED.has(res.status) || attempt >= MAX_RETRIES) break
      // Rate limited or briefly unavailable: back off (Retry-After if given) and try again.
      const retryAfter = Number(res.headers.get('retry-after'))
      await sleep(retryAfter > 0 ? Math.min(retryAfter, 30) * 1000 : 500 * 2 ** attempt)
    }
    let json: any
    try {
      json = text ? JSON.parse(text) : {}
    } catch {
      const hint = THROTTLED.has(res.status) ? ' — the node is rate-limiting this server; lower ANTELOPE_MAX_RPS' : ''
      throw new ChainError(`chain API returned non-JSON (HTTP ${res.status})${hint}`, res.status)
    }
    if (!res.ok) throw new ChainError(errorText(json), res.status)
    return json as T
  }

  info() {
    return this.rpc('/v1/chain/get_info')
  }

  async abi(account: string): Promise<ABI> {
    const cached = this.abiCache.get(account)
    if (cached) return cached
    const res = await this.rpc<{ abi?: ABIDef }>('/v1/chain/get_abi', { account_name: account })
    if (!res.abi) throw new ChainError(`account ${account} has no contract`)
    const abi = ABI.from(res.abi)
    this.abiCache.set(account, abi)
    return abi
  }

  /**
   * An unsigned transaction with the given actions, valid for `expireSeconds`, plus the head
   * block number when it was built: the transaction can only appear in a later block.
   */
  async transactionAt(actions: ActionInput[], expireSeconds = 60): Promise<{ tx: Transaction; headBlock: number }> {
    const built: Action[] = []
    for (const a of actions) built.push(Action.from(a, await this.abi(a.account)))
    const info = await this.client.v1.chain.get_info()
    const tx = Transaction.from({ ...info.getTransactionHeader(expireSeconds), actions: built })
    return { tx, headBlock: Number(info.head_block_num) }
  }

  async transaction(actions: ActionInput[], expireSeconds = 60): Promise<Transaction> {
    return (await this.transactionAt(actions, expireSeconds)).tx
  }

  private static packed(tx: Transaction) {
    return { transaction: PackedTransaction.fromSigned(SignedTransaction.from({ ...tx, signatures: [] })).toJSON() }
  }

  /** Run a read-only transaction (no authorization needed). Throws ReadOnlyUnavailable if the node has it disabled. */
  async readOnly(tx: Transaction): Promise<any> {
    try {
      return await this.rpc('/v1/chain/send_read_only_transaction', Chain.packed(tx))
    } catch (e) {
      if (/read-only transactions execution not enabled|unknown endpoint|not found/i.test((e as Error).message)) throw new ReadOnlyUnavailable()
      throw e
    }
  }

  /**
   * Execute a transaction without committing it (compute_transaction). Signatures are not checked,
   * but authorizations are: an action authorized by a permission that is not linked to it fails.
   */
  compute(tx: Transaction): Promise<any> {
    return this.rpc('/v1/chain/compute_transaction', Chain.packed(tx))
  }
}

export class ReadOnlyUnavailable extends Error {
  constructor() {
    super('read-only transactions are disabled on this API node')
  }
}
