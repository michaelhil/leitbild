import { describe, expect, test } from 'bun:test'
import type { z } from 'zod'
import { planningFactsInputSchema } from '@leitbild/contracts'
import {
  baselineInputSchema, createInputSchema, deleteInputSchema, editInputSchema, explainInputSchema, generateInputSchema, publishedInputSchema,
  readInputSchema, refreshInputSchema, stripForPublication,
} from './contract.ts'

const inputs: Record<string, z.ZodType> = {
  'world.simulation-run.planning-facts': planningFactsInputSchema,
  'planning.plan.create': createInputSchema,
  'planning.plan.edit': editInputSchema,
  'planning.plan.generate': generateInputSchema,
  'planning.plan.explain': explainInputSchema,
  'planning.plan.read': readInputSchema,
  'planning.plan.baseline': baselineInputSchema,
  'planning.sources.refresh': refreshInputSchema,
  'planning.plan.delete': deleteInputSchema,
}
const large = new Set(['planning.plan.create', 'planning.plan.edit'])

/** Paths of object properties without a description; the `edit` discriminator names itself. */
const undescribed = (node: any, path: string, out: string[]): string[] => {
  if (node === null || typeof node !== 'object') return out
  if (node.properties) for (const [name, child] of Object.entries<any>(node.properties)) {
    const here = `${path}.${name}`
    const described = child.description !== undefined || (child.anyOf ?? child.oneOf ?? []).some((branch: any) => branch.description !== undefined)
    if (!described && name !== 'edit') out.push(here)
    undescribed(child, here, out)
  }
  for (const branch of [...(node.anyOf ?? []), ...(node.oneOf ?? [])]) undescribed(branch, path, out)
  if (node.items) undescribed(node.items, `${path}[]`, out)
  return out
}

describe('published operation inputs', () => {
  test('every published input field is described', () => {
    for (const [id, schema] of Object.entries(inputs)) expect({ id, undescribed: undescribed(publishedInputSchema(schema), '', []) }).toEqual({ id, undescribed: [] })
  })

  // Design r2 measured 15,023 B (create) and 15,495 B (edit) and set the guard at 16,000 B. The
  // coordinator-adopted `source` on seven edit fields adds about 2,200 B (17,251 and 17,723 B), so the
  // guard is 18,000 B.
  test('create and edit stay within 18,000 B; every other input within 4,096 B', () => {
    for (const [id, schema] of Object.entries(inputs)) {
      const bytes = new TextEncoder().encode(JSON.stringify(publishedInputSchema(schema))).length
      expect({ id, within: bytes <= (large.has(id) ? 18_000 : 4_096) }).toEqual({ id, within: true })
    }
  })

  test('publication drops patterns, formats and bounds and keeps types, enums, required and descriptions', () => {
    const published = publishedInputSchema(baselineInputSchema) as any
    expect(published.$schema).toBeUndefined()
    expect(published.required).toEqual(['option', 'name'])
    expect(published.additionalProperties).toBe(false)
    expect(published.properties.option).toEqual({ type: 'string', description: 'Option key' })
    expect(published.properties.name).toEqual({ type: 'string', description: 'Baseline name' })
    expect(JSON.stringify(publishedInputSchema(editInputSchema))).not.toMatch(/"(pattern|format|minLength|maxLength|minimum|maximum|minItems|maxItems)"/)
    expect(stripForPublication({ anyOf: [{ type: 'string' }, { type: 'null' }], description: 'x' })).toEqual({ type: ['string', 'null'], description: 'x' })
    expect(stripForPublication({ type: 'string', enum: ['a', 'b'], maxLength: 3 })).toEqual({ type: 'string', enum: ['a', 'b'] })
  })

  test('the boundary still validates with the exact schemas', () => {
    expect(editInputSchema.safeParse({ edits: [] }).success).toBe(false)
    expect(generateInputSchema.safeParse({ seconds: 21 }).success).toBe(false)
    expect(generateInputSchema.safeParse({ variants: [{ buy: 'no-extra-crew-hours', methods: [{ choice: 'SWA-method', option: 'rebuild' }] }] }).success).toBe(true)
    expect(deleteInputSchema.safeParse({}).success).toBe(true)
    expect(deleteInputSchema.safeParse({ confirm: true }).success).toBe(false)
  })
})
