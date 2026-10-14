/** Configuration from the environment. Read tools need only ANTELOPE_URL. */
import { readFileSync } from 'node:fs'
import { parseAllowed, type SignerConfig } from './signer.js'

export interface Config {
  url: string
  chainId?: string
  chainName?: string
  hyperionUrl?: string
  /** validity of unsigned transactions from prepare_transaction */
  txExpireSeconds: number
  /** validity of transactions the server signs itself (short: the API node's answer is advisory) */
  pushExpireSeconds: number
  /** requests per second to the chain API at most */
  maxRps: number
  signer?: SignerConfig
}

function httpUrl(value: string | undefined, variable: string): string | undefined {
  if (!value) return undefined
  let u: URL
  try { u = new URL(value) } catch { throw new Error(`${variable} is not a URL`) }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error(`${variable} must be an http(s) URL`)
  return value.replace(/\/+$/, '')
}

function seconds(value: string | undefined, variable: string, dflt: number, min: number, max: number) {
  if (!value) return dflt
  const n = Number(value)
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${variable} must be an integer between ${min} and ${max}`)
  return n
}

/** A bare private key, or the file written by `cleos create key --file` ("Private key: …"). */
export function keyFromFile(text: string): string {
  const m = text.match(/^Private key:\s*(\S+)/m)
  if (m) return m[1]
  const key = text.trim()
  if (!key || /\s/.test(key)) throw new Error('the key file must hold one private key, or the output of `cleos create key --file`')
  return key
}

export function loadConfig(env: Record<string, string | undefined> = process.env, readFile = (p: string) => readFileSync(p, 'utf8')): Config {
  const url = httpUrl(env.ANTELOPE_URL, 'ANTELOPE_URL')
  if (!url) throw new Error('ANTELOPE_URL is required (the chain API endpoint, e.g. https://jungle4.greymass.com)')
  const chainId = env.ANTELOPE_CHAIN_ID?.toLowerCase()
  if (chainId && !/^[0-9a-f]{64}$/.test(chainId)) throw new Error('ANTELOPE_CHAIN_ID must be 64 hex characters')

  let signer: SignerConfig | undefined
  const who = env.ANTELOPE_SIGNER
  if (who) {
    const m = who.match(/^([a-z1-5.]{1,13})@([a-z1-5.]{1,13})$/)
    if (!m) throw new Error('ANTELOPE_SIGNER must be actor@permission')
    let privateKey = env.ANTELOPE_PRIVATE_KEY
    if (!privateKey && env.ANTELOPE_PRIVATE_KEY_FILE) privateKey = keyFromFile(readFile(env.ANTELOPE_PRIVATE_KEY_FILE))
    if (!privateKey) throw new Error('ANTELOPE_SIGNER is set but neither ANTELOPE_PRIVATE_KEY nor ANTELOPE_PRIVATE_KEY_FILE is')
    signer = { actor: m[1], permission: m[2], privateKey, allowedActions: parseAllowed(env.ANTELOPE_ALLOWED_ACTIONS) }
  } else if (env.ANTELOPE_PRIVATE_KEY || env.ANTELOPE_PRIVATE_KEY_FILE) {
    throw new Error('a private key is configured but ANTELOPE_SIGNER (actor@permission) is not')
  }

  return {
    url,
    chainId,
    chainName: env.ANTELOPE_CHAIN_NAME,
    hyperionUrl: httpUrl(env.ANTELOPE_HYPERION_URL, 'ANTELOPE_HYPERION_URL'),
    txExpireSeconds: seconds(env.ANTELOPE_TX_EXPIRE_SECONDS, 'ANTELOPE_TX_EXPIRE_SECONDS', 300, 30, 3600),
    pushExpireSeconds: seconds(env.ANTELOPE_PUSH_EXPIRE_SECONDS, 'ANTELOPE_PUSH_EXPIRE_SECONDS', 30, 10, 300),
    maxRps: seconds(env.ANTELOPE_MAX_RPS, 'ANTELOPE_MAX_RPS', 15, 1, 100),
    signer,
  }
}
