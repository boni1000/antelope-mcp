/**
 * The optional signer: one private key, one actor@permission, and a fixed set of actions.
 *
 * Which actions are allowed is read from the chain. A permission created with `linkauth` is
 * linked to specific contract actions, and only those are allowed. An unlinked permission
 * (active, owner) can do anything, so for it writes stay off unless ANTELOPE_ALLOWED_ACTIONS
 * names the actions explicitly.
 */
import { PrivateKey, PublicKey } from '@wharfkit/antelope'
import type { Chain } from './chain.js'

export interface SignerConfig {
  actor: string
  permission: string
  privateKey: string
  allowedActions?: string[] // "contract::action" or "contract::*"
}

export class Signer {
  readonly key: PrivateKey
  readonly publicKey: PublicKey
  /** contract::action entries this signer may push. */
  allowed: string[] = []
  linked = false

  constructor(readonly cfg: SignerConfig) {
    this.key = PrivateKey.from(cfg.privateKey)
    this.publicKey = this.key.toPublic()
  }

  get authority() {
    return `${this.cfg.actor}@${this.cfg.permission}`
  }

  /** Verify the key belongs to the permission on chain, and read the linked actions. */
  async verify(chain: Chain) {
    const acc = await chain.rpc('/v1/chain/get_account', { account_name: this.cfg.actor })
    const perm = acc.permissions.find((p: any) => p.perm_name === this.cfg.permission)
    if (!perm) throw new Error(`account ${this.cfg.actor} has no permission '${this.cfg.permission}'`)
    const keys: string[] = perm.required_auth.keys.map((k: any) => PublicKey.from(k.key).toString())
    if (!keys.includes(this.publicKey.toString())) throw new Error(`the configured key is not in ${this.authority} (keys: ${keys.join(', ') || 'none'})`)
    const linked: string[] = (perm.linked_actions ?? []).map((l: any) => `${l.account}::${l.action || '*'}`)
    this.linked = linked.length > 0
    if (this.linked) {
      // The chain decides. An explicit list can only narrow it further.
      this.allowed = this.cfg.allowedActions ? linked.filter((l) => matches(l, this.cfg.allowedActions!)) : linked
    } else {
      this.allowed = this.cfg.allowedActions ?? []
    }
  }

  allows(contract: string, action: string) {
    return matches(`${contract}::${action}`, this.allowed)
  }
}

function matches(entry: string, patterns: string[]) {
  const [contract, action] = entry.split('::')
  return patterns.some((p) => {
    const [pc, pa] = p.split('::')
    return pc === contract && (pa === '*' || pa === action)
  })
}

export function parseAllowed(value: string | undefined): string[] | undefined {
  if (!value?.trim()) return undefined
  const entries = value.split(',').map((s) => s.trim()).filter(Boolean)
  for (const e of entries) {
    if (!/^[a-z1-5.]{1,13}::([a-z1-5.]{1,13}|\*)$/.test(e)) throw new Error(`ANTELOPE_ALLOWED_ACTIONS: '${e}' is not contract::action or contract::*`)
  }
  return entries
}
