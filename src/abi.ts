/**
 * Turn a contract ABI into a compact description an LLM can act on: every action with its
 * fields (struct types expanded), what it returns, its Ricardian title/summary, and every table
 * with its row fields. Pure functions — tested without a chain.
 */
/** A contract ABI as JSON, as returned by /v1/chain/get_abi. */
export type AbiJson = Record<string, any>

type Struct = { name: string; base?: string; fields: { name: string; type: string }[] }

const MAX_DEPTH = 2

/** Title and summary from a Ricardian contract's YAML-like header, if present. */
export function ricardianSummary(text: string | undefined): { title?: string; summary?: string } {
  if (!text) return {}
  const header = text.match(/^---\s*\n([\s\S]*?)\n---/)?.[1] ?? ''
  const field = (k: string) => header.match(new RegExp(`^${k}:\\s*['"]?(.+?)['"]?\\s*$`, 'm'))?.[1]
  const clean = (s?: string) => s?.replace(/\{\{[^}]*\}\}/g, '…').trim()
  return { title: clean(field('title')), summary: clean(field('summary')) }
}

export function describeAbi(abi: AbiJson) {
  const structs = new Map<string, Struct>((abi.structs ?? []).map((s: any) => [s.name, s]))
  const aliases = new Map<string, string>((abi.types ?? []).map((t: any) => [t.new_type_name, t.type]))
  const variants = new Map<string, string[]>((abi.variants ?? []).map((v: any) => [v.name, v.types]))

  const resolve = (type: string): string => {
    let t = type
    for (let i = 0; i < 10 && aliases.has(t.replace(/[?\[\]$]+$/, '')); i++) {
      const base = t.replace(/[?\[\]$]+$/, '')
      t = aliases.get(base)! + t.slice(base.length)
    }
    return t
  }

  // Fields of a struct, with nested structs expanded to MAX_DEPTH and base structs flattened.
  const fields = (name: string, depth = 0): Record<string, unknown> => {
    const s = structs.get(name)
    if (!s) return {}
    const out: Record<string, unknown> = s.base ? fields(s.base, depth) : {}
    for (const f of s.fields) {
      const t = resolve(f.type)
      const base = t.replace(/[?\[\]$]+$/, '')
      const suffix = t.slice(base.length)
      if (structs.has(base) && depth < MAX_DEPTH) out[f.name] = suffix ? { [`${suffix}of`]: fields(base, depth + 1) } : fields(base, depth + 1)
      else if (variants.has(base)) out[f.name] = `one of ${variants.get(base)!.join(' | ')}${suffix}`
      else out[f.name] = t
    }
    return out
  }

  const results = new Map<string, string>((abi.action_results ?? []).map((r: any) => [r.name, r.result_type]))
  const ricardian = new Map<string, string>((abi.actions ?? []).map((a: any) => [a.name, a.ricardian_contract]))

  const actions = (abi.actions ?? []).map((a: any) => {
    const { title, summary } = ricardianSummary(ricardian.get(a.name))
    const ret = results.get(a.name)
    return {
      name: a.name,
      ...(title ? { title } : {}),
      ...(summary ? { summary } : {}),
      fields: fields(a.type),
      ...(ret ? { returns: structs.has(resolve(ret)) ? fields(resolve(ret)) : resolve(ret) } : {}),
    }
  })

  const tables = (abi.tables ?? []).map((t: any) => ({
    name: t.name,
    row: fields(t.type),
    ...(t.key_names?.length ? { keys: t.key_names } : {}),
  }))

  return { actions, tables, ...(abi.ricardian_clauses?.length ? { clauses: abi.ricardian_clauses.map((c: any) => c.id) } : {}) }
}
