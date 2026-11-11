import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { planningFactsInputSchema } from '@leitbild/contracts'
import {
  baselineInputSchema, createInputSchema, deleteInputSchema, editInputSchema, explainInputSchema, generateInputSchema, publishedInputSchema,
  readInputSchema, refreshInputSchema, schemaMapKeywords, stripForPublication, strippedKeywords,
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

/** Stripped keywords still present in keyword positions (field names inside schema maps are not keywords). */
const keywordsLeft = (node: unknown, path = ''): string[] => {
  if (Array.isArray(node)) return node.flatMap((child, index) => keywordsLeft(child, `${path}[${index}]`))
  if (node === null || typeof node !== 'object') return []
  return Object.entries(node).flatMap(([name, value]) => {
    if (strippedKeywords.has(name)) return [`${path}.${name}`]
    if (schemaMapKeywords.has(name) && value !== null && typeof value === 'object') return Object.entries(value).flatMap(([field, child]) => keywordsLeft(child, `${path}.${name}.${field}`))
    return keywordsLeft(value, `${path}.${name}`)
  })
}

/** Walks the exact and the published schema together and lists every object whose property names differ. */
const propertyDifferences = (exact: any, published: any, path: string): string[] => {
  if (exact === null || typeof exact !== 'object' || published === null || typeof published !== 'object') return []
  // A nullable pair {anyOf: [T, null]} is published as one schema; compare T with the published node.
  if (exact.anyOf?.length === 2 && exact.anyOf[1]?.type === 'null' && published.anyOf === undefined) return propertyDifferences(exact.anyOf[0], published, path)
  const out: string[] = []
  if (exact.properties !== undefined || published.properties !== undefined) {
    const a = Object.keys(exact.properties ?? {}).join(','), b = Object.keys(published.properties ?? {}).join(',')
    if (a !== b) out.push(`${path}: exact ${a} published ${b}`)
    for (const name of Object.keys(exact.properties ?? {})) out.push(...propertyDifferences(exact.properties[name], published.properties?.[name], `${path}.${name}`))
  }
  for (const keyword of ['anyOf', 'oneOf', 'allOf'] as const) {
    (exact[keyword] ?? []).forEach((branch: unknown, index: number) => out.push(...propertyDifferences(branch, published[keyword]?.[index], `${path}.${keyword}[${index}]`)))
  }
  if (exact.items !== undefined) out.push(...propertyDifferences(exact.items, published.items, `${path}[]`))
  return out
}

describe('published operation inputs', () => {
  test('every published input field is described', () => {
    for (const [id, schema] of Object.entries(inputs)) expect({ id, undescribed: undescribed(publishedInputSchema(schema), '', []) }).toEqual({ id, undescribed: [] })
  })

  // Design r2 measured 15,023 B (create) and 15,495 B (edit) and set the guard at 16,000 B, but its
  // publication also dropped the job edit's `minimum` field. With that field kept and the
  // coordinator-adopted `source` on seven edit fields and the due rule, create is 17,818 B and edit 18,290 B;
  // the guard is 19,000 B.
  test('create and edit stay within 19,000 B; every other input within 4,096 B', () => {
    for (const [id, schema] of Object.entries(inputs)) {
      const bytes = new TextEncoder().encode(JSON.stringify(publishedInputSchema(schema))).length
      expect({ id, within: bytes <= (large.has(id) ? 19_000 : 4_096) }).toEqual({ id, within: true })
    }
  })

  test('publication drops patterns, formats and bounds and keeps types, enums, required and descriptions', () => {
    const published = publishedInputSchema(baselineInputSchema) as any
    expect(published.$schema).toBeUndefined()
    expect(published.required).toEqual(['option', 'name'])
    expect(published.additionalProperties).toBe(false)
    expect(published.properties.option).toEqual({ type: 'string', description: 'Option key' })
    expect(published.properties.name).toEqual({ type: 'string', description: 'Baseline name' })
    for (const schema of Object.values(inputs)) expect(keywordsLeft(publishedInputSchema(schema))).toEqual([])
    expect(stripForPublication({ anyOf: [{ type: 'string' }, { type: 'null' }], description: 'x' })).toEqual({ type: ['string', 'null'], description: 'x' })
    expect(stripForPublication({ type: 'string', enum: ['a', 'b'], maxLength: 3 })).toEqual({ type: 'string', enum: ['a', 'b'] })
  })

  test('publication never removes a field: every published object has the exact schema\'s property names', () => {
    for (const [id, schema] of Object.entries(inputs)) {
      const { $schema: _dialect, ...exact } = z.toJSONSchema(schema, { io: 'input' }) as Record<string, unknown>
      expect({ id, differences: propertyDifferences(exact, publishedInputSchema(schema), '') }).toEqual({ id, differences: [] })
    }
    const job = (publishedInputSchema(editInputSchema) as any).properties.edits.items.oneOf.find((branch: any) => branch.properties.edit.const === 'job')
    expect(Object.keys(job.properties.minimum.anyOf?.[0]?.properties ?? job.properties.minimum.properties)).toEqual(['value', 'unit', 'words'])
    expect(stripForPublication({ type: 'object', properties: { minimum: { type: 'number', minimum: 0 }, pattern: { type: 'string', pattern: 'x' } } }))
      .toEqual({ type: 'object', properties: { minimum: { type: 'number' }, pattern: { type: 'string' } } })
  })

  test('the boundary still validates with the exact schemas', () => {
    expect(editInputSchema.safeParse({ edits: [] }).success).toBe(false)
    expect(generateInputSchema.safeParse({ seconds: 21 }).success).toBe(false)
    expect(generateInputSchema.safeParse({ variants: [{ buy: 'no-extra-crew-hours', methods: [{ choice: 'SWA-method', option: 'rebuild' }] }] }).success).toBe(true)
    expect(deleteInputSchema.safeParse({}).success).toBe(true)
    expect(deleteInputSchema.safeParse({ confirm: true }).success).toBe(false)
  })
})
