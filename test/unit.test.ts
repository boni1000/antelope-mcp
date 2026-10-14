import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { describeAbi, ricardianSummary } from '../src/abi.js'
import { errorText, exceptText } from '../src/chain.js'
import { loadConfig } from '../src/config.js'
import { authority, name } from '../src/util.js'

const fixture = (f: string) => JSON.parse(readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8'))

describe('describeAbi', () => {
  const agentgov = describeAbi(fixture('agentgov.abi.json'))
  const token = describeAbi(fixture('eosio.token.abi.json'))

  it('lists every action with its fields', () => {
    expect(agentgov.actions.map((a) => a.name)).toContain('authorize')
    const authorize = agentgov.actions.find((a) => a.name === 'authorize')!
    expect(authorize.fields).toEqual({ agent: 'name', vendor_id: 'uint64', amount: 'uint64', params_hash: 'checksum256', nonce: 'uint64' })
  })

  it('expands struct return values and keeps scalar ones', () => {
    expect(agentgov.actions.find((a) => a.name === 'authorize')!.returns).toEqual({ id: 'uint64', status: 'uint8' })
    expect(agentgov.actions.find((a) => a.name === 'addvendor')!.returns).toBe('uint64')
    expect(agentgov.actions.find((a) => a.name === 'approve')!.returns).toBeUndefined()
  })

  it('describes tables by their row fields', () => {
    const policies = agentgov.tables.find((t) => t.name === 'policies')!
    expect(Object.keys(policies.row)).toEqual(['agent', 'per_tx_max', 'daily_max', 'approval_threshold', 'approver'])
  })

  it('takes title and summary from Ricardian contracts', () => {
    const transfer = token.actions.find((a) => a.name === 'transfer')!
    expect(transfer.title).toBe('Transfer Tokens')
    expect(transfer.summary).toMatch(/^Send … from … to …$/)
  })

  it('handles an empty ABI', () => {
    expect(describeAbi({})).toEqual({ actions: [], tables: [] })
  })

  it('expands nested structs and resolves type aliases', () => {
    const abi = {
      types: [{ new_type_name: 'account_name', type: 'name' }],
      structs: [
        { name: 'permission_level', base: '', fields: [{ name: 'actor', type: 'account_name' }, { name: 'permission', type: 'name' }] },
        { name: 'propose', base: '', fields: [{ name: 'proposer', type: 'account_name' }, { name: 'requested', type: 'permission_level[]' }] },
      ],
      actions: [{ name: 'propose', type: 'propose', ricardian_contract: '' }],
    }
    expect(describeAbi(abi).actions[0].fields).toEqual({ proposer: 'name', requested: { '[]of': { actor: 'name', permission: 'name' } } })
  })
})

describe('ricardianSummary', () => {
  it('reads quoted and unquoted header fields', () => {
    expect(ricardianSummary('---\nspec_version: "0.2.0"\ntitle: Vote\nsummary: \'Vote for {{producers}}\'\n---\nbody')).toEqual({ title: 'Vote', summary: 'Vote for …' })
  })
  it('returns nothing without a header', () => {
    expect(ricardianSummary('just text')).toEqual({ title: undefined, summary: undefined })
    expect(ricardianSummary(undefined)).toEqual({})
  })
})

describe('chain error texts', () => {
  it('fills placeholders, showing permission levels as actor@permission', () => {
    const except = { stack: [{ format: "action declares irrelevant authority '${auth}'; minimum authority is ${min}", data: { auth: { actor: 'a', permission: 'gw' }, min: { actor: 'a', permission: 'active' } } }] }
    expect(exceptText(except)).toBe("action declares irrelevant authority 'a@gw'; minimum authority is a@active")
  })
  it('strips the assertion prefix', () => {
    expect(exceptText({ stack: [{ format: 'assertion failure with message: ${s}', data: { s: 'request is not pending' } }] })).toBe('request is not pending')
    expect(errorText({ error: { details: [{ message: 'assertion failure with message: daily limit exceeded' }] } })).toBe('daily limit exceeded')
  })
  it('does not return an unfilled template', () => {
    expect(errorText({ error: { what: 'Transaction exception', details: [{ message: '${s}' }] } })).toBe('Transaction exception')
  })
})

describe('input validation', () => {
  it('accepts valid Antelope names and rejects others', () => {
    for (const ok of ['eosio', 'eosio.token', 'agtresearch1', 'a', 'abcdefghijkl', 'abcdefghijklj']) expect(name.safeParse(ok).success, ok).toBe(true)
    for (const bad of ['', 'Eosio', 'eosio6', 'abcdefghijklz', 'abcdefghijklmn', 'eosio.', 'a b']) expect(name.safeParse(bad).success, bad).toBe(false)
  })
  it('accepts actor@permission only', () => {
    expect(authority.safeParse('alice@active').success).toBe(true)
    expect(authority.safeParse('alice').success).toBe(false)
  })
})

describe('loadConfig', () => {
  it('requires a URL and validates the chain id', () => {
    expect(() => loadConfig({})).toThrow(/ANTELOPE_URL is required/)
    expect(() => loadConfig({ ANTELOPE_URL: 'ftp://x' })).toThrow(/http/)
    expect(() => loadConfig({ ANTELOPE_URL: 'https://x', ANTELOPE_CHAIN_ID: 'abc' })).toThrow(/64 hex/)
    expect(loadConfig({ ANTELOPE_URL: 'https://x.org/', ANTELOPE_CHAIN_ID: 'A'.repeat(64) })).toEqual({ url: 'https://x.org', chainId: 'a'.repeat(64), chainName: undefined, hyperionUrl: undefined })
  })
})
