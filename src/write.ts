/**
 * Write tools.
 *  - prepare_transaction: keyless. Validates, dry-runs and returns an unsigned transaction and
 *    an ESR link (esr://) that Anchor or any ESR wallet signs.
 *  - push_transaction: only with a configured signer, only for its allowed actions, always
 *    dry-run first.
 *  - wait_for_transaction: finds a transaction in blocks (works without history plugins).
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { PackedTransaction, SignedTransaction, type Transaction } from '@wharfkit/antelope'
import { SigningRequest } from '@wharfkit/signing-request'
import { deflateRawSync, inflateRawSync } from 'node:zlib'
import { z } from 'zod'
import { exceptText, type Chain } from './chain.js'
import type { Config } from './config.js'
import type { Signer } from './signer.js'
import { authority, fail, name, ok } from './util.js'

const zlib = { deflateRaw: (d: Uint8Array) => new Uint8Array(deflateRawSync(d)), inflateRaw: (d: Uint8Array) => new Uint8Array(inflateRawSync(d)) }

const actionSchema = z.object({
  contract: name,
  action: name,
  data: z.record(z.string(), z.unknown()).default({}),
  authorization: z.array(authority).min(1).max(4).describe('who signs, e.g. ["alice@active"]'),
})
type ActionInput = z.infer<typeof actionSchema>

function toActions(inputs: ActionInput[]) {
  return inputs.map((a) => ({
    account: a.contract,
    name: a.action,
    authorization: a.authorization.map((x) => { const [actor, permission] = x.split('@'); return { actor, permission } }),
    data: a.data,
  }))
}

/** Scan blocks from `from` to head for the transaction; returns the block number or undefined. */
/** wait_for_transaction scans at most this far back (about an hour at 0.5 s blocks). */
export const MAX_LOOKBACK_BLOCKS = 7200

export async function findInBlocks(chain: Chain, id: string, from: number, deadlineMs: number): Promise<number | undefined> {
  let next = from
  while (Date.now() < deadlineMs) {
    const info = await chain.info()
    while (next <= info.head_block_num) {
      const b = await chain.rpc('/v1/chain/get_block', { block_num_or_id: next })
      if ((b.transactions ?? []).some((t: any) => (typeof t.trx === 'string' ? t.trx : t.trx.id) === id)) return next
      next++
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  return undefined
}

async function dryRun(chain: Chain, tx: Transaction) {
  const res = await chain.compute(tx)
  if (res.processed?.except) throw new Error(`dry run failed: ${exceptText(res.processed.except)}`)
  const traces = (res.processed?.action_traces ?? []) as any[]
  return {
    cpu_us: res.processed?.receipt?.cpu_usage_us,
    net_words: res.processed?.receipt?.net_usage_words,
    returns: traces.map((t) => t.return_value_data).filter((v) => v !== undefined && v !== ''),
    console: traces.map((t) => t.console).filter(Boolean),
  }
}

export function registerWriteTools(server: McpServer, chain: Chain, cfg: Config, signer?: Signer) {
  server.registerTool('prepare_transaction', {
    title: 'Prepare a transaction for a wallet',
    description: 'Build a transaction from one or more actions, check it against the contract ABIs, run it without committing (dry run), and return it unsigned together with an ESR link (esr://…) that the account holder opens in Anchor or another ESR wallet to sign and broadcast. Nothing is written to the chain by this tool. Use describe_contract first for the action fields.',
    inputSchema: {
      actions: z.array(actionSchema).min(1).max(20),
      expire_seconds: z.number().int().min(30).max(3600).default(cfg.txExpireSeconds).describe('validity of the unsigned transaction'),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, async ({ actions, expire_seconds }) => {
    try {
      const acts = toActions(actions)
      const { tx, headBlock } = await chain.transactionAt(acts, expire_seconds)
      let dry: Record<string, unknown> | { dry_run_error: string }
      try { dry = await dryRun(chain, tx) } catch (e) { dry = { dry_run_error: (e as Error).message } }
      const chainId = cfg.chainId ?? (await chain.info()).chain_id
      // The full transaction goes into the request (expiry and reference block included), so the
      // wallet signs exactly this transaction and transaction_id below is the id it will have.
      const req = await SigningRequest.create({ transaction: tx, chainId, broadcast: true }, { zlib, abiProvider: { getAbi: (a) => chain.abi(String(a)) } })
      return ok({
        transaction: JSON.parse(JSON.stringify(tx)),
        transaction_id: String(tx.id),
        expires: String(tx.expiration),
        esr: req.encode(),
        dry_run: dry,
        how_to_sign: `Open the esr link in Anchor (Import Transaction, or paste it into a signing-request field), review the actions and sign before ${String(tx.expiration)} UTC. Then call wait_for_transaction with transaction_id and from_block to confirm it is in a block.`,
        from_block: headBlock,
      })
    } catch (e) { return fail(e) }
  })

  server.registerTool('wait_for_transaction', {
    title: 'Wait for a transaction',
    description: 'Wait until a transaction (by id) appears in a block, scanning blocks from `from_block`; optionally until that block is irreversible. Works on any node.',
    inputSchema: {
      transaction_id: z.string().regex(/^[0-9a-f]{64}$/),
      from_block: z.number().int().min(1).describe('block number to start scanning from (from prepare_transaction or push_transaction)'),
      until: z.enum(['included', 'irreversible']).default('included'),
      timeout_seconds: z.number().int().min(5).max(600).default(90),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, async ({ transaction_id, from_block, until, timeout_seconds }) => {
    try {
      const head = (await chain.info()).head_block_num
      if (from_block < head - MAX_LOOKBACK_BLOCKS) {
        return fail(new Error(`from_block ${from_block} is ${head - from_block} blocks behind the head (${head}); use the from_block returned by prepare_transaction or push_transaction (at most ${MAX_LOOKBACK_BLOCKS} blocks back)`))
      }
      if (from_block > head + 120) return fail(new Error(`from_block ${from_block} is ahead of the head block ${head}`))
      const deadline = Date.now() + timeout_seconds * 1000
      const block = await findInBlocks(chain, transaction_id, from_block, deadline)
      if (!block) return fail(new Error(`transaction ${transaction_id} not found in blocks ${from_block}… within ${timeout_seconds} s (not signed yet, expired, or started scanning too late)`))
      let irreversible = false
      while (true) {
        const info = await chain.info()
        irreversible = info.last_irreversible_block_num >= block
        if (irreversible || until === 'included' || Date.now() >= deadline) break
        await new Promise((r) => setTimeout(r, 1000))
      }
      return ok({ transaction_id, block, irreversible, ...(until === 'irreversible' && !irreversible ? { note: 'timed out before irreversibility' } : {}) })
    } catch (e) { return fail(e) }
  })

  if (!signer) return

  server.registerTool('push_transaction', {
    title: `Sign and push (as ${signer.authority})`,
    description: `Sign one or more actions with the server's key as ${signer.authority} and broadcast them. Allowed actions: ${signer.allowed.length ? signer.allowed.join(', ') : 'none'}. The transaction is dry-run first and refused if it would fail. Returns the transaction id and the block it was included in.`,
    inputSchema: {
      actions: z.array(z.object({ contract: name, action: name, data: z.record(z.string(), z.unknown()).default({}) })).min(1).max(10),
      wait: z.enum(['included', 'irreversible']).default('included').describe('return after inclusion in a block, or after that block is irreversible'),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  }, async ({ actions, wait }) => {
    try {
      for (const a of actions) {
        if (!signer.allows(a.contract, a.action)) return fail(new Error(`${a.contract}::${a.action} is not allowed for ${signer.authority}${signer.linked ? ' (not linked to this permission)' : ' (set ANTELOPE_ALLOWED_ACTIONS)'}`))
      }
      const auth = [{ actor: signer.cfg.actor, permission: signer.cfg.permission }]
      const { tx, headBlock } = await chain.transactionAt(actions.map((a) => ({ account: a.contract, name: a.action, authorization: auth, data: a.data })), cfg.pushExpireSeconds)
      const dry = await dryRun(chain, tx)
      const chainId = cfg.chainId ?? (await chain.info()).chain_id
      const signed = SignedTransaction.from({ ...tx, signatures: [signer.key.signDigest(tx.signingDigest(chainId))] })
      const res = await chain.rpc('/v1/chain/send_transaction', PackedTransaction.fromSigned(signed).toJSON())
      const id = String(res.transaction_id ?? tx.id)
      // The API node's answer is advisory: confirm the transaction is really in a block.
      const deadline = Date.now() + (cfg.pushExpireSeconds + 15) * 1000
      const block = await findInBlocks(chain, id, headBlock, deadline)
      if (!block) return fail(new Error(`transaction ${id} was accepted by the API node but not seen in a block within ${cfg.pushExpireSeconds + 15} s; it has expired`))
      let irreversible = false
      if (wait === 'irreversible') {
        while (Date.now() < deadline + 600_000) {
          const info = await chain.info()
          if (info.last_irreversible_block_num >= block) { irreversible = true; break }
          await new Promise((r) => setTimeout(r, 1000))
        }
      }
      return ok({ transaction_id: id, block, irreversible, signed_as: signer.authority, ...dry })
    } catch (e) { return fail(e) }
  })
}
