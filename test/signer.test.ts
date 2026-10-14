import { PrivateKey } from '@wharfkit/antelope'
import { describe, expect, it } from 'vitest'
import { parseAllowed, Signer } from '../src/signer.js'

const key = PrivateKey.generate('K1')
const pub = key.toPublic().toLegacyString()

function chainWith(perm: any) {
  return { rpc: async () => ({ permissions: [perm] }) } as any
}

describe('Signer.verify', () => {
  it('allows exactly the linked actions of a linked permission', async () => {
    const s = new Signer({ actor: 'alice', permission: 'mcp', privateKey: String(key) })
    await s.verify(chainWith({ perm_name: 'mcp', required_auth: { keys: [{ key: pub, weight: 1 }] }, linked_actions: [{ account: 'c1', action: 'submit' }, { account: 'c2', action: '' }] }))
    expect(s.allowed).toEqual(['c1::submit', 'c2::*'])
    expect(s.allows('c1', 'submit')).toBe(true)
    expect(s.allows('c2', 'anything')).toBe(true)
    expect(s.allows('c1', 'other')).toBe(false)
    expect(s.allows('eosio.token', 'transfer')).toBe(false)
  })

  it('an explicit list can only narrow a linked permission', async () => {
    const s = new Signer({ actor: 'alice', permission: 'mcp', privateKey: String(key), allowedActions: ['c1::submit', 'eosio.token::transfer'] })
    await s.verify(chainWith({ perm_name: 'mcp', required_auth: { keys: [{ key: pub, weight: 1 }] }, linked_actions: [{ account: 'c1', action: 'submit' }, { account: 'c1', action: 'cancel' }] }))
    expect(s.allowed).toEqual(['c1::submit'])
  })

  it('allows nothing for an unlinked permission without an explicit list', async () => {
    const s = new Signer({ actor: 'alice', permission: 'active', privateKey: String(key) })
    await s.verify(chainWith({ perm_name: 'active', required_auth: { keys: [{ key: pub, weight: 1 }] }, linked_actions: [] }))
    expect(s.allowed).toEqual([])
    expect(s.allows('eosio.token', 'transfer')).toBe(false)
  })

  it('refuses a key that is not in the permission, and a missing permission', async () => {
    const other = PrivateKey.generate('K1').toPublic().toLegacyString()
    const s = new Signer({ actor: 'alice', permission: 'mcp', privateKey: String(key) })
    await expect(s.verify(chainWith({ perm_name: 'mcp', required_auth: { keys: [{ key: other, weight: 1 }] }, linked_actions: [] }))).rejects.toThrow(/not in alice@mcp/)
    await expect(s.verify(chainWith({ perm_name: 'other', required_auth: { keys: [] } }))).rejects.toThrow(/no permission 'mcp'/)
  })
})

describe('parseAllowed', () => {
  it('parses contract::action and contract::*', () => {
    expect(parseAllowed(' eosio.token::transfer, c1::* ')).toEqual(['eosio.token::transfer', 'c1::*'])
    expect(parseAllowed('')).toBeUndefined()
    expect(() => parseAllowed('transfer')).toThrow(/contract::action/)
  })
})
