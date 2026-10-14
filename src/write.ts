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
import { exceptText, type Chain, type ChainError } from './chain.js'
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

/** wait_for_transaction scans at most this far back (about an hour at 0.5 s blocks). */
export const MAX_LOOKBACK_BLOCKS = 7200

/**
 * MCP clients commonly cancel a tool call after 60 s, so one call works for at most this long
 * and then reports where it stopped; the agent calls again to continue.
 */
export const CALL_BUDGET_SECONDS = 50

/**
 * Find the block that contains a transaction: by the transaction-status API where the node has
 * it, else by reading blocks from `from` on. Returns the block, or how far the scan got.
 */
export async function findInBlocks(chain: Chain, id: string, from: number, deadlineMs: number): Promise<{ block?: number; next: number }> {
  // Fast path: nodes with the transaction-status API answer directly, without reading blocks.
  let statusApi = true
  while (statusApi && Date.now() < deadlineMs) {
    try {
      const s = await chain.rpc('/v1/chain/get_transaction_status', { id })
      if (s.block_number && (s.state === 'IN_BLOCK' || s.state === 'IRREVERSIBLE')) return { block: Number(s.block_number), next: Number(s.block_number) + 1 }
      await new Promise((r) => setTimeout(r, 1000))
    } catch (e) {
      if (!/unknown endpoint|not found|not enabled/i.test((e as Error).message) && (e as ChainError).status !== 404) throw e
      statusApi = false // fall back to scanning blocks
    }
  }
  let next = from
  while (Date.now() < deadlineMs) {
    const info = await chain.info()
    while (next <= info.head_block_num && Date.now() < deadlineMs) {
      const b = await chain.rpc('/v1/chain/get_block', { block_num_or_id: next })
      if ((b.transactions ?? []).some((t: any) => (typeof t.trx === 'string' ? t.trx : t.trx.id) === id)) return { block: next, next: next + 1 }
      next++
    }
    if (Date.now() < deadlineMs) await new Promise((r) => setTimeout(r, 500))
  }
  return { next }
}

/** Wait until `block` is irreversible or the deadline passes. */
async function waitIrreversible(chain: Chain, block: number, deadlineMs: number) {
  while (true) {
    const info = await chain.info()
    if (info.last_irreversible_block_num >= block) return true
    if (Date.now() >= deadlineMs) return false
    await new Promise((r) => setTimeout(r, 1000))
  }
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
    description: `Wait until a transaction (by id) is in a block, and optionally until that block is irreversible. Works on any node (reads blocks from from_block where the node has no transaction-status API). One call waits at most ${CALL_BUDGET_SECONDS} s; if it returns found: false or irreversible: false, call it again with the returned from_block to continue.`,
    inputSchema: {
      transaction_id: z.string().regex(/^[0-9a-f]{64}$/),
      from_block: z.number().int().min(1).describe('block number to start from (from prepare_transaction, push_transaction, or a previous call)'),
      until: z.enum(['included', 'irreversible']).default('included'),
      timeout_seconds: z.number().int().min(5).max(CALL_BUDGET_SECONDS).default(45),
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
      const { block, next } = await findInBlocks(chain, transaction_id, from_block, deadline)
      if (!block) {
        return ok({
          transaction_id, found: false, checked_blocks: `${from_block}–${next - 1}`, from_block: next,
          note: 'Not in these blocks yet. Call wait_for_transaction again with this from_block to continue. If the transaction has passed its expiry and is still not found, it was never included.',
        })
      }
      const irreversible = until === 'irreversible' ? await waitIrreversible(chain, block, deadline) : (await chain.info()).last_irreversible_block_num >= block
      return ok({
        transaction_id, found: true, block, irreversible,
        ...(until === 'irreversible' && !irreversible ? { from_block: block, note: 'In a block but not yet irreversible; call again with until: irreversible to keep waiting.' } : {}),
      })
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
      const started = Date.now()
      const { block } = await findInBlocks(chain, id, headBlock, started + Math.min(cfg.pushExpireSeconds + 10, CALL_BUDGET_SECONDS) * 1000)
      if (!block) return fail(new Error(`transaction ${id} was accepted by the API node but not seen in a block within ${cfg.pushExpireSeconds + 10} s; check with wait_for_transaction from block ${headBlock} — it can no longer be included after ${String(tx.expiration)} UTC`))
      const irreversible = wait === 'irreversible' ? await waitIrreversible(chain, block, started + CALL_BUDGET_SECONDS * 1000) : false
      return ok({
        transaction_id: id, block, irreversible, signed_as: signer.authority, ...dry,
        ...(wait === 'irreversible' && !irreversible ? { note: 'Included but not yet irreversible; call wait_for_transaction with until: irreversible and from_block to keep waiting.', from_block: block } : {}),
      })
    } catch (e) { return fail(e) }
  })
}
