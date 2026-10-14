/** Read tools: no keys involved. Every tool works on any Antelope chain. */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { describeAbi } from './abi.js'
import { exceptText, ReadOnlyUnavailable, type Chain } from './chain.js'
import type { Config } from './config.js'
import { authority, fail, ok, name } from './util.js'

const RO = { readOnlyHint: true, openWorldHint: true } as const

function account(a: any) {
  const perm = (p: any) => ({
    name: p.perm_name,
    parent: p.parent || undefined,
    threshold: p.required_auth.threshold,
    keys: p.required_auth.keys.map((k: any) => (k.weight === 1 ? k.key : `${k.key} (weight ${k.weight})`)),
    accounts: p.required_auth.accounts.map((x: any) => `${x.permission.actor}@${x.permission.permission}` + (x.weight === 1 ? '' : ` (weight ${x.weight})`)),
    ...(p.required_auth.waits?.length ? { waits: p.required_auth.waits } : {}),
    // Actions this permission is linked to (linkauth); empty for owner/active.
    linked_actions: (p.linked_actions ?? []).map((l: any) => `${l.account}::${l.action || '*'}`),
  })
  const res = (r: any) => (r ? { used: r.used, available: r.available, max: r.max } : undefined)
  return {
    account: a.account_name,
    created: a.created,
    ...(a.core_liquid_balance ? { core_liquid_balance: a.core_liquid_balance } : {}),
    ram: { used_bytes: a.ram_usage, quota_bytes: a.ram_quota },
    cpu_us: res(a.cpu_limit),
    net_bytes: res(a.net_limit),
    ...(a.privileged ? { privileged: true } : {}),
    permissions: a.permissions.map(perm),
    ...(a.voter_info?.producers?.length ? { votes_for: a.voter_info.producers } : {}),
  }
}

export function registerReadTools(server: McpServer, chain: Chain, cfg: Config) {
  server.registerTool('chain_info', {
    title: 'Chain information',
    description: `Identity and state of the connected Antelope chain${cfg.chainName ? ` (${cfg.chainName})` : ''}: chain id, node version, head and irreversible block, how far finality lags behind the head, and the consensus mode (Savanna or legacy) that explains that lag.`,
    annotations: RO,
  }, async () => {
    try {
      const [i, fin] = await Promise.all([
        chain.info(),
        chain.rpc('/v1/chain/get_finalizer_info').catch(() => null), // Spring 1.0+ only
      ])
      const policy = fin?.active_finalizer_policy
      const consensus = !fin
        ? 'unknown (node does not offer get_finalizer_info; it predates Spring)'
        : policy
          ? `Savanna: ${policy.finalizers?.length ?? 0} finalizers (policy generation ${policy.generation}), finality within seconds`
          : 'legacy DPoS (Savanna not activated): a block is final after confirmation by 2/3 of producers, typically tens of seconds'
      return ok({
        ...(cfg.chainName ? { name: cfg.chainName } : {}),
        chain_id: i.chain_id,
        server_version: i.server_version_string,
        head_block: i.head_block_num,
        head_block_time: i.head_block_time,
        head_block_producer: i.head_block_producer,
        irreversible_block: i.last_irreversible_block_num,
        finality_lag_seconds: (i.head_block_num - i.last_irreversible_block_num) / 2,
        consensus,
      })
    } catch (e) { return fail(e) }
  })

  server.registerTool('get_account', {
    title: 'Account',
    description: 'An account: creation date, core token balance, RAM/CPU/NET resources, and its permissions with keys, accounts and the contract actions each permission is linked to (linkauth).',
    inputSchema: { account: name },
    annotations: RO,
  }, async ({ account: a }) => {
    try { return ok(account(await chain.rpc('/v1/chain/get_account', { account_name: a }))) } catch (e) { return fail(e) }
  })

  server.registerTool('get_balances', {
    title: 'Token balances',
    description: 'Token balances of an account at a token contract (default eosio.token). Optionally one symbol only.',
    inputSchema: {
      account: name,
      contract: name.default('eosio.token').describe('token contract'),
      symbol: z.string().regex(/^[A-Z]{1,7}$/).optional().describe('e.g. EOS, A, TLOS, WAX'),
    },
    annotations: RO,
  }, async ({ account: a, contract, symbol }) => {
    try {
      const balances = await chain.rpc<string[]>('/v1/chain/get_currency_balance', { code: contract, account: a, ...(symbol ? { symbol } : {}) })
      return ok({ account: a, contract, balances })
    } catch (e) { return fail(e) }
  })

  server.registerTool('describe_contract', {
    title: 'Describe a contract',
    description: 'What a smart contract can do, read from its on-chain ABI: each action with its fields, return type and Ricardian title/summary, and each table with its row fields. Use before reading tables or calling actions.',
    inputSchema: { contract: name },
    annotations: RO,
  }, async ({ contract }) => {
    try {
      const [abiRes, hash] = await Promise.all([
        chain.rpc('/v1/chain/get_abi', { account_name: contract }),
        chain.rpc('/v1/chain/get_code_hash', { account_name: contract }).catch(() => null),
      ])
      if (!abiRes.abi) return fail(new Error(`account ${contract} has no contract`))
      return ok({ contract, ...(hash ? { code_hash: hash.code_hash } : {}), ...describeAbi(abiRes.abi) })
    } catch (e) { return fail(e) }
  })

  server.registerTool('get_table_rows', {
    title: 'Table rows',
    description: 'Rows of a contract table, decoded with the contract ABI. Use describe_contract first to learn table names and row fields. For a secondary index give index_position (2, 3, …) and key_type.',
    inputSchema: {
      contract: name,
      table: name,
      scope: z.string().max(64).optional().describe('defaults to the contract account'),
      lower_bound: z.string().max(128).optional(),
      upper_bound: z.string().max(128).optional(),
      limit: z.number().int().min(1).max(100).default(20),
      index_position: z.number().int().min(1).max(10).optional(),
      key_type: z.enum(['name', 'i64', 'i128', 'sha256', 'i256', 'float64', 'float128', 'ripemd160']).optional(),
      reverse: z.boolean().optional(),
    },
    annotations: RO,
  }, async (p) => {
    try {
      const res = await chain.rpc('/v1/chain/get_table_rows', {
        json: true, code: p.contract, table: p.table, scope: p.scope ?? p.contract, limit: p.limit,
        ...(p.lower_bound ? { lower_bound: p.lower_bound } : {}),
        ...(p.upper_bound ? { upper_bound: p.upper_bound } : {}),
        ...(p.index_position ? { index_position: p.index_position } : {}),
        ...(p.key_type ? { key_type: p.key_type } : {}),
        ...(p.reverse ? { reverse: true } : {}),
      })
      return ok({ rows: res.rows, more: res.more, ...(res.more ? { next_key: res.next_key } : {}) })
    } catch (e) { return fail(e) }
  })

  server.registerTool('get_table_scopes', {
    title: 'Table scopes',
    description: 'Which scopes of a contract hold rows (and how many), e.g. which accounts have a balance row in a token contract.',
    inputSchema: { contract: name, table: name.optional(), limit: z.number().int().min(1).max(100).default(20), lower_bound: z.string().max(64).optional() },
    annotations: RO,
  }, async (p) => {
    try {
      const res = await chain.rpc('/v1/chain/get_table_by_scope', { code: p.contract, ...(p.table ? { table: p.table } : {}), limit: p.limit, ...(p.lower_bound ? { lower_bound: p.lower_bound } : {}) })
      return ok({ scopes: res.rows.map((r: any) => ({ scope: r.scope, table: r.table, rows: r.count })), more: res.more || undefined })
    } catch (e) { return fail(e) }
  })

  server.registerTool('get_block', {
    title: 'Block',
    description: 'A block by number or id: producer, time and its transactions with the actions they ran (first 50).',
    inputSchema: { block: z.union([z.number().int().min(1), z.string().regex(/^[0-9a-f]{64}$/)]) },
    annotations: RO,
  }, async ({ block }) => {
    try {
      const b = await chain.rpc('/v1/chain/get_block', { block_num_or_id: block })
      const txs = (b.transactions ?? []).slice(0, 50).map((t: any) => {
        const trx = typeof t.trx === 'string' ? { id: t.trx } : { id: t.trx.id, actions: (t.trx.transaction?.actions ?? []).map((a: any) => `${a.account}::${a.name} by ${a.authorization.map((x: any) => `${x.actor}@${x.permission}`).join(',')}`) }
        return { ...trx, status: t.status }
      })
      return ok({ block: b.block_num, id: b.id, time: b.timestamp, producer: b.producer, transaction_count: b.transactions?.length ?? 0, transactions: txs })
    } catch (e) { return fail(e) }
  })

  server.registerTool('get_transaction', {
    title: 'Transaction',
    description: `Status of a transaction by id: whether it is in a block and irreversible (recent transactions only)${cfg.hyperionUrl ? ', plus its actions from the history service' : ''}.`,
    inputSchema: { id: z.string().regex(/^[0-9a-f]{64}$/) },
    annotations: RO,
  }, async ({ id }) => {
    const out: Record<string, unknown> = { id }
    try {
      const s = await chain.rpc('/v1/chain/get_transaction_status', { id })
      out.state = s.state
      if (s.block_number) out.block = s.block_number
      if (s.irreversible_number) out.irreversible_block = s.irreversible_number
    } catch (e) {
      out.status_error = /unknown endpoint|not found/i.test((e as Error).message)
        ? 'this node does not provide transaction status (get_transaction_status)'
        : (e as Error).message
    }
    if (cfg.hyperionUrl) {
      try {
        const r = await fetch(`${cfg.hyperionUrl}/v2/history/get_transaction?id=${id}`, { signal: AbortSignal.timeout(15000) })
        const h: any = await r.json()
        if (h.actions?.length) {
          out.block = out.block ?? h.actions[0].block_num
          out.time = h.actions[0]['@timestamp']
          out.actions = h.actions.map((a: any) => ({ action: `${a.act.account}::${a.act.name}`, by: a.act.authorization?.map((x: any) => `${x.actor}@${x.permission}`), data: a.act.data }))
        }
      } catch (e) { out.history_error = (e as Error).message }
    }
    if (!out.state && !out.actions) {
      const hint = cfg.hyperionUrl ? '' : '; configure ANTELOPE_HYPERION_URL for transaction history'
      return fail(new Error(String(out.status_error ?? 'transaction not found') + hint))
    }
    return ok(out)
  })

  server.registerTool('call_readonly_action', {
    title: 'Call or simulate an action',
    description: 'Run a contract action without committing it and return its result (return value and console output). Use it for getter actions, or with `as` to check whether an account permission could run an action and what it would return. No signature is needed and nothing is written to the chain.',
    inputSchema: {
      contract: name,
      action: name,
      data: z.record(z.string(), z.unknown()).default({}).describe('action fields, as in describe_contract'),
      as: authority.optional().describe('simulate as this authority, e.g. alice@active; permissions are checked, signatures are not'),
    },
    annotations: RO,
  }, async ({ contract, action, data, as }) => {
    try {
      const act = (authorization: { actor: string; permission: string }[]) => chain.transaction([{ account: contract, name: action, authorization, data }])
      let res: any
      let simulatedAs = as
      if (!as) {
        try {
          res = await chain.readOnly(await act([]))
        } catch (e) {
          if (!(e instanceof ReadOnlyUnavailable)) throw e
          simulatedAs = `${contract}@active` // a dry run needs an authorization; signatures are not checked
        }
      }
      if (!res) {
        const [actor, permission] = simulatedAs!.split('@')
        res = await chain.compute(await act([{ actor, permission }]))
      }
      const trace = res.processed?.action_traces?.[0]
      if (res.processed?.except) return fail(new Error(exceptText(res.processed.except)))
      return ok({
        action: `${contract}::${action}`,
        ...(simulatedAs ? { simulated_as: simulatedAs } : {}),
        ...(trace?.return_value_data !== undefined && trace?.return_value_data !== '' ? { returns: trace.return_value_data } : trace?.return_value_hex_data ? { returns_hex: trace.return_value_hex_data } : {}),
        ...(trace?.console ? { console: trace.console } : {}),
        cpu_us: res.processed?.receipt?.cpu_usage_us,
        committed: false,
      })
    } catch (e) { return fail(e) }
  })
}
