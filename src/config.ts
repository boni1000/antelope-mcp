/** Configuration from the environment. Read tools need only ANTELOPE_URL. */
export interface Config {
  url: string
  chainId?: string
  chainName?: string
  hyperionUrl?: string
}

function httpUrl(value: string | undefined, variable: string): string | undefined {
  if (!value) return undefined
  const u = new URL(value) // throws on garbage
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error(`${variable} must be an http(s) URL`)
  return value.replace(/\/+$/, '')
}

export function loadConfig(env = process.env): Config {
  const url = httpUrl(env.ANTELOPE_URL, 'ANTELOPE_URL')
  if (!url) throw new Error('ANTELOPE_URL is required (the chain API endpoint, e.g. https://jungle4.greymass.com)')
  const chainId = env.ANTELOPE_CHAIN_ID?.toLowerCase()
  if (chainId && !/^[0-9a-f]{64}$/.test(chainId)) throw new Error('ANTELOPE_CHAIN_ID must be 64 hex characters')
  return { url, chainId, chainName: env.ANTELOPE_CHAIN_NAME, hyperionUrl: httpUrl(env.ANTELOPE_HYPERION_URL, 'ANTELOPE_HYPERION_URL') }
}
