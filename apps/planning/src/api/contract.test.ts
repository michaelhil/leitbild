import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { planningFactsInputSchema } from '@leitbild/contracts'
import {
  baselineInputSchema, createInputSchema, deleteInputSchema, editInputSchema, explainInputSchema, generateInputSchema, publishedInputSchema,
  generateResultSchema, readInputSchema, refreshInputSchema, resultLimitBytes, schemaMapKeywords, sectionDataSchemas, stripForPublication, strippedKeywords,
  summaryDataSchema,
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
  // coordinator-adopted `source` on eight edit fields, the due rule, the per-type lag description, the
  // edit envelope's revision, the equipment `function` key and create's grid, create is 18,731 B and edit 19,211 B.
  // 20,000 B is the increment 1 ceiling. Any further growth must remove or merge something; raising this needs a coordinator decision.
  test('create and edit stay within 20,000 B; every other input within 4,096 B', () => {
    for (const [id, schema] of Object.entries(inputs)) {
      const bytes = new TextEncoder().encode(JSON.stringify(publishedInputSchema(schema))).length
      expect({ id, within: bytes <= (large.has(id) ? 20_000 : 4_096) }).toEqual({ id, within: true })
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

  test('create takes the plan grid, 30min or 30s, defaulting to 30min; edit does not', () => {
    expect(createInputSchema.parse({ grid: '30s' }).grid).toBe('30s')
    expect(createInputSchema.parse({ grid: '30min', edits: [] }).grid).toBe('30min')
    expect(createInputSchema.parse({}).grid).toBeUndefined()
    for (const grid of ['1min', '30', 30, null]) expect(createInputSchema.safeParse({ grid }).success).toBe(false)
    expect(editInputSchema.safeParse({ edits: [{ edit: 'plan', title: 'Supply run' }], grid: '30s' }).success).toBe(false)
    expect(editInputSchema.safeParse({ edits: [{ edit: 'plan', grid: '30s' }] }).success).toBe(false)
    const published = publishedInputSchema(createInputSchema) as any
    expect(published.properties.grid).toEqual({ type: 'string', enum: ['30s', '30min'], description: 'Time step of the plan: 30min for work weeks, 30s for jobs of a few minutes; default 30min' })
  })

  test('the boundary still validates with the exact schemas', () => {
    expect(editInputSchema.safeParse({ edits: [] }).success).toBe(false)
    expect(generateInputSchema.safeParse({ seconds: 21 }).success).toBe(false)
    expect(generateInputSchema.safeParse({ variants: [{ buy: 'no-extra-crew-hours', methods: [{ choice: 'SWA-method', option: 'rebuild' }] }] }).success).toBe(true)
    expect(deleteInputSchema.safeParse({}).success).toBe(true)
    expect(deleteInputSchema.safeParse({ confirm: true }).success).toBe(false)
  })
})

const trainA: any = await Bun.file(new URL('../plan/fixtures/train-a.fragment.json', import.meta.url)).json()

describe('read section data and option warnings', () => {
  const plan = { id: '0c4008f3-ffac-47ce-9be0-a0c71e68a781', title: 'Train A work week', revision: 3, updatedAt: '2026-11-12T09:05:00Z' }
  const run = { grid: '30min', engine: 'ts-lahc', formulation: 'f1', seed: 1, budget: { evals: 1, cpuMs: 1, wallMs: 1 }, stoppedBy: 'done', evals: 1, cpuMs: 1 }
  const warning = { kind: 'redundancy', text: 'Both MFW pumps A and B are out Tue 08:00-14:00 and no keep-in-service rule covers them', about: ['MFWA', 'MFWB'] }
  const option = { key: 'swap', label: 'Swap in the spare', variant: { methods: [{ choice: 'SWA-method', option: 'swap' }], purchases: ['ot-mech'] },
    status: { word: 'unresolved', run }, metrics: [{ id: 'span-COOL-A', value: 56, unit: 'h' }], inputsRevision: 3 }
  const row = { job: 'SWA-TAG', start: '2026-11-17T06:00:00Z', finish: '2026-11-17T09:00:00Z', uses: [], float: { workingHours: 2, limitedBy: { kind: 'span-limit', rule: 'R2' } } }
  const fact = { locator: 'process-plant/plant%3Atrain-a/serviceWaterPumpB', id: 'plant:train-a/serviceWaterPumpB/runningState', label: 'Running', quantity: 'state', value: true, basis: 'observed', at: '2026-11-12T09:00:00Z' }
  const change = { seq: 1, at: '2026-11-12T09:00:00Z', by: { kind: 'human' }, revision: 1, summary: 'Created from Train A work week', kinds: ['job'] }

  test('each section shape parses, and summary has no paging', () => {
    const sections: Record<string, unknown> = {
      summary: { plan, settings: trainA.settings, goals: trainA.goals, refreshedAt: null, attention: [{ kind: 'not-ready', text: 'Link the running simulation', about: [] }],
        certifiedSize: { family: 'single-train work weeks', maxJobs: 100, evidence: 'measured 11 Nov' } },
      jobs: { items: [{ job: trainA.jobs[0] }, { link: trainA.links[0] }, { method: trainA.methods[0] }], more: '3' },
      rules: { items: trainA.rules.map((rule: unknown) => ({ rule })) },
      crews: { items: [{ calendar: trainA.calendars[0] }, { resource: trainA.resources[0] }, { purchase: trainA.purchases[0] }] },
      sources: { items: [{ equipment: trainA.equipment[0] }, { group: trainA.groups[0] }, { fact }] },
      options: { at: '2026-11-12T09:04:00Z', recommended: 'swap', items: [{ ...option, fresh: true, warnings: [warning] }] },
      schedule: { option: 'swap', items: [row] },
      history: { items: [change] },
    }
    expect(Object.keys(sectionDataSchemas)).toEqual(readInputSchema.shape.section.unwrap().options)
    for (const [name, data] of Object.entries(sections)) expect({ name, ok: sectionDataSchemas[name as keyof typeof sectionDataSchemas].safeParse(data).success }).toEqual({ name, ok: true })
    expect(summaryDataSchema.safeParse({ ...(sections.summary as object), more: '1' }).success).toBe(false)
    expect(sectionDataSchemas.options.safeParse({ at: null, recommended: null, items: [] }).success).toBe(true)
    expect(sectionDataSchemas.options.safeParse({ ...(sections.options as object), items: [{ ...option, fresh: true, warnings: [], rows: [row] }] }).success).toBe(false)
    expect(sectionDataSchemas.options.safeParse({ ...(sections.options as object), items: [{ ...option, warnings: [] }] }).success).toBe(false)
    expect(sectionDataSchemas.schedule.safeParse({ items: [row] }).success).toBe(false)
    expect(sectionDataSchemas.jobs.safeParse({ items: [{ rule: trainA.rules[0] }] }).success).toBe(false)
    expect(sectionDataSchemas.history.safeParse({ items: [change], more: '' }).success).toBe(false)
  })

  test('an option warning has a kind, planner words and the keys involved', () => {
    const page = (warnings: unknown[]) => sectionDataSchemas.options.safeParse({ at: null, recommended: null, items: [{ ...option, fresh: false, warnings }] }).success
    expect(page([warning])).toBe(true)
    const { kind: _kind, ...unkinded } = warning
    expect(page([unkinded])).toBe(false)
    expect(page([{ ...warning, kind: 'risk' }])).toBe(false)
    expect(page([{ ...warning, about: ['A', 'B', 'C', 'D', 'E'] }])).toBe(false)
    expect(page([warning, warning, warning, warning, warning])).toBe(false)
  })

  test('generate options carry their warnings, and the whole result stays within 4 KB', () => {
    const status = { word: 'unresolved', goals: [] }
    const result = (options: unknown[]) => generateResultSchema.safeParse({ plan: { id: plan.id, revision: 3 }, options, recommended: 'o0', text: 'Swap in the spare is the best found.' })
    expect(result([{ key: 'o0', label: 'Swap', status, warnings: [warning] }]).success).toBe(true)
    expect(result([{ key: 'o0', label: 'Swap', status }]).success).toBe(false)
    const full = Array.from({ length: 8 }, (_, index) => ({ key: `o${index}`, label: 'Swap in the spare, overtime, two contractor nights', status, span: 56.5, cost: 464250, warnings: [warning, warning, warning] }))
    expect(JSON.stringify(full).length).toBeGreaterThan(resultLimitBytes)
    expect(result(full).success).toBe(false)
    expect(result(full.slice(0, 3)).success).toBe(true)
  })
})
