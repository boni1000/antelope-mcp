import { ABI, Action, Transaction } from '@wharfkit/antelope'
import { SigningRequest } from '@wharfkit/signing-request'
import { readFileSync } from 'node:fs'
import { deflateRawSync, inflateRawSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'

const zlib = { deflateRaw: (d: Uint8Array) => new Uint8Array(deflateRawSync(d)), inflateRaw: (d: Uint8Array) => new Uint8Array(inflateRawSync(d)) }
const tokenAbi = ABI.from(JSON.parse(readFileSync(new URL('./fixtures/eosio.token.abi.json', import.meta.url), 'utf8')))
const chainId = '3b24add5385ba8cb7a581a0986f40d221eab9b52438b74d76719830f96daf415'

describe('ESR from a prepared transaction', () => {
  it('keeps expiry and reference block, so the signed id is the prepared id', async () => {
    const action = Action.from({ account: 'eosio.token', name: 'transfer', authorization: [{ actor: 'boni', permission: 'active' }], data: { from: 'boni', to: 'cert', quantity: '0.0001 SYS', memo: 'mcp test' } }, tokenAbi)
    const tx = Transaction.from({ expiration: '2026-10-14T12:53:29', ref_block_num: 62745, ref_block_prefix: 1234567, actions: [action] })
    const req = await SigningRequest.create({ transaction: tx, chainId, broadcast: true }, { zlib, abiProvider: { getAbi: async () => tokenAbi } })
    const back = SigningRequest.from(req.encode(), { zlib })
    expect(back.requiresTapos()).toBe(false)
    expect(String(back.getRawTransaction().id)).toBe(String(tx.id))
    expect(String(back.getChainId())).toBe(chainId)
  })
})
