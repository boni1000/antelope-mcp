import { z } from 'zod'

/** An Antelope account or action name: up to 12 characters a-z, 1-5 and '.', a 13th only a-j/1-5. */
export const name = z
  .string()
  .regex(/^(?:[a-z1-5.]{0,11}[a-z1-5]|[a-z1-5.]{12}[a-j1-5])$/, 'not a valid Antelope name')

/** actor@permission, e.g. alice@active */
export const authority = z
  .string()
  .regex(/^[a-z1-5.]{1,13}@[a-z1-5.]{1,13}$/, 'expected actor@permission, e.g. alice@active')

export function ok(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 1) }] }
}

export function fail(e: unknown) {
  return { isError: true, content: [{ type: 'text' as const, text: (e as Error)?.message ?? String(e) }] }
}
