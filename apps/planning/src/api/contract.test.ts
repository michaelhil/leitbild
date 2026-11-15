import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { planningFactsInputSchema } from '@leitbild/contracts'
import {
  baselineInputSchema, createInputSchema, deleteInputSchema, editInputSchema, explainInputSchema, generateInputSchema, publishedInputSchema,
  buysRowSchema, generateResultSchema, readInputSchema, refreshInputSchema, resultLimitBytes, schemaMapKeywords, sectionDataSchemas, statusOutSchema, stripForPublication,
  explainResultSchema, optionItemSchema, recommendedFactsSchema, strippedKeywords, summaryDataSchema, versusFactsSchema,
} from './contract.ts'
import { statusOut } from './operations.ts'
import { optionSchema } from '../plan/schema.ts'

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
  // Re-measured for increment 2 (lane A, 15 Nov): edit was 19,298 B before part 2; the method option's caveats
  // make create 19,240 B and edit 19,807 B, 193 B under the ceiling. generate grows from 965 B to 3,613 B with
  // also, lead and keep; explain is 727 B, and read 460 B with buys and previous.
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
        certifiedSize: { decided: false, family: 'single-train work weeks', maxJobs: 100, evidence: 'measured 11 Nov', limitJobs: 100 } },
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

// ═══════════ Increment 2 "Choose": the operation contract, part 2 (design r3 §0.3, §2.2, §3) ═══════════

describe('increment 2: the Assistant-facing status names goals by id and carries a what-if\'s lead', () => {
  const line = (goal: number, word: 'proven optimal' | 'best found under budget') => ({ goal, word, value: 10, unit: 'h', ...(word === 'proven optimal' ? { bound: 10, gap: 0 } : {}) })
  const out = (goals: object[], lead?: object) => statusOutSchema.safeParse({ word: 'validated feasible', goals, ...(lead === undefined ? {} : { lead }) })
  const paths = (goals: object[], lead?: object) => out(goals, lead).error?.issues.map(issue => issue.path.join('.')) ?? []

  test('fix C: a valid proof on lead {goal: 1} is accepted; without the lead it breaks the order rule', () => {
    expect(paths([line(0, 'best found under budget'), line(1, 'proven optimal'), line(2, 'best found under budget')], { goal: 1 })).toEqual([])
    expect(paths([line(0, 'best found under budget'), line(1, 'proven optimal'), line(2, 'best found under budget')])).toEqual(['goals.1.word'])
  })

  test('a proof out of place, a renumbered or missing goal id, or a lead beyond the goals is refused', () => {
    expect(paths([line(0, 'proven optimal'), line(1, 'proven optimal')], { goal: 1 })).toEqual(['goals.0.word'])
    expect(paths([line(1, 'best found under budget'), line(0, 'proven optimal')], { goal: 1 })).toContain('goals.0.goal')
    expect(paths([line(0, 'best found under budget')], { goal: 1 })).toEqual(['lead.goal'])
    const { goal: _goal, ...unnamed } = line(0, 'best found under budget')
    expect(out([unnamed]).success).toBe(false)
    expect(statusOutSchema.safeParse({ word: 'unresolved', goals: [], lead: { goal: 0 } }).success).toBe(false)
  })

  test('fix A: a group lead "proven optimal" names its bound, a bound comes with its gap, and no plan goal is proven (draft)', () => {
    const afw = { group: 'AFW-A', word: 'proven optimal', value: 7.5, unit: 'h' }
    const plain = [line(0, 'best found under budget'), line(1, 'best found under budget')]
    expect(paths(plain, afw)).toEqual(['lead.bound'])
    expect(paths(plain, { ...afw, bound: 7.5, gap: 0 })).toEqual([])
    expect(paths(plain, { ...afw, bound: 7.5 })).toEqual(['lead.gap'])
    expect(paths(plain, { ...afw, word: 'best found under budget' })).toEqual([])
    expect(paths([line(0, 'proven optimal'), line(1, 'best found under budget')], { ...afw, bound: 7.5, gap: 0 })).toEqual(['goals.0.word'])
  })
})

describe('increment 2: Generate takes what-ifs with an extra rule or a lead, and keep', () => {
  const rule = { kind: 'span-limit', key: 'W48', group: 'COOL-A', limit: { value: 48, unit: 'h' }, singleEntry: true, words: 'Train A cooling chain back within 48 h', source: { by: 'planner' } }
  const ok = (input: unknown) => generateInputSchema.safeParse(input).success

  test('also takes exactly one span-limit or due rule in the stored form', () => {
    expect(ok({ variants: [{ label: 'At most 48 h out', also: [rule] }], keep: true })).toBe(true)
    expect(ok({ variants: [{ also: [{ kind: 'due', key: 'W-AFW', job: 'AFWA-RTS', finishBy: '2026-11-18T12:00:00Z', words: 'AFW A back by Wed 13:00', source: { by: 'planner' } }] }] })).toBe(true)
    expect(ok({ variants: [{ also: [] }] })).toBe(false)
    expect(ok({ variants: [{ also: [rule, rule] }] })).toBe(false)
    expect(ok({ variants: [{ also: [{ ...rule, kind: 'protected' }] }] })).toBe(false)
    expect(ok({ variants: [{ also: [{ ...rule, source: { by: 'reference' } }] }] })).toBe(false)
    expect(ok({ variants: [{ also: [{ ...rule, extra: 1 }] }] })).toBe(false)
  })

  test('lead is {goal} or {group}, never a bare index; keep is true or absent', () => {
    expect(ok({ variants: [{ label: 'Cheapest that keeps every rule', lead: { goal: 1 } }], keep: true })).toBe(true)
    expect(ok({ variants: [{ label: 'Finish AFW A first', lead: { group: 'AFW-A' } }] })).toBe(true)
    expect(ok({ variants: [{ lead: 1 }] })).toBe(false)
    expect(ok({ variants: [{ lead: { goal: 6 } }] })).toBe(false)
    expect(ok({ keep: false })).toBe(false)
  })
})

describe('increment 2: explain recommended and versus {previous}; read buys', () => {
  test('versus names the option of the previous set, and only for ask versus', () => {
    const ok = (input: unknown) => explainInputSchema.safeParse(input).success
    expect(ok({ ask: 'recommended' })).toBe(true)
    expect(ok({ ask: 'versus', option: 'swap.b1', versus: { previous: 'swap.a1' } })).toBe(true)
    expect(ok({ ask: 'versus' })).toBe(false)
    expect(ok({ ask: 'finish', versus: { previous: 'swap.a1' } })).toBe(false)
    expect(ok({ ask: 'versus', versus: { option: 'swap.a1' } })).toBe(false)
    expect(ok({ ask: 'versus', versus: { baseline: 'B1' } })).toBe(false)
  })

  const rung = (number: number, buy: string[], option?: string) => ({ rung: { rung: number, buy, ...(option === undefined ? {} : { option }), bought: [] } })
  const page = (items: unknown[]) => sectionDataSchemas.buys.safeParse({ items }).success
  const row = (value: object) => buysRowSchema.safeParse(value).error?.issues.map(issue => issue.path.join('.')) ?? []
  const finish = { kind: 'crew', about: [{ kind: 'resource', key: 'crane' }] }
  const ends = (from: string, to: string) => ({ ends: { from, to } })

  test('the buys section pages rungs and rows; a row says one ladder word, never "buys nothing"', () => {
    expect(readInputSchema.safeParse({ section: 'buys' }).success).toBe(true)
    const days = ['ect-friday', 'crane-fri']
    expect(page([rung(0, days, 'r0'), rung(1, [...days, 'ot-mech'], 'r1'), rung(2, [...days, 'ot-mech', 'contractor-nights']), { row: { from: 0, to: 1, ...ends('found', 'found'), word: 'found', outage: -6, cost: 41_000 } }])).toBe(true)
    expect(page([{ row: { from: 0, to: 1, ...ends('found', 'found'), word: 'buys nothing', outage: 0, cost: 0 } }])).toBe(false)
    expect(page([{ row: { from: 0, to: 1, word: 'found', outage: -6, cost: 41_000 } }])).toBe(false)
  })

  test('rungs follow the rungs offered: with one price form, rungs 0 and 1, and rung 1 buys all crew time', () => {
    // A plan whose crew time is priced per period only (contractor nights): days only, then everything.
    const days = ['crane-fri'], all = ['crane-fri', 'contractor-nights']
    expect(page([rung(0, days, 'r0'), rung(1, all, 'r1'), { row: { from: 0, to: 1, ...ends('refused', 'found'), word: 'makes it possible' } }])).toBe(true)
    expect(row({ from: 0, to: 2, ...ends('refused', 'found'), word: 'makes it possible' })).toEqual(['to'])
    // With three rungs offered, rung 1 to rung 2 is adjacent too.
    expect(row({ from: 1, to: 2, ...ends('found', 'found'), word: 'found', outage: -3, cost: 9_000 })).toEqual([])
    expect(row({ from: 1, to: 0, ...ends('found', 'found'), word: 'not found better', outage: 0, cost: 0 })).toEqual(['to'])
    expect(sectionDataSchemas.buys.safeParse({ items: [rung(3, all)] }).success).toBe(false)
  })

  test('each word stands on its two ends', () => {
    // makes it possible: a refused lower rung and a solved higher one, with no differences.
    expect(row({ from: 0, to: 1, ...ends('refused', 'proven'), word: 'makes it possible' })).toEqual([])
    expect(row({ from: 0, to: 1, ...ends('refused', 'found'), word: 'makes it possible' })).toEqual([])
    expect(row({ from: 0, to: 1, ...ends('found', 'found'), word: 'makes it possible', outage: -2, cost: 0 })).toEqual(['word'])
    expect(row({ from: 0, to: 1, ...ends('refused', 'unsolved'), word: 'makes it possible' })).toEqual(['word'])
    expect(row({ from: 0, to: 1, ...ends('refused', 'found'), word: 'makes it possible', outage: -2, cost: 0 })).toEqual(['outage'])
    // proven and proven: no gain: both ends proven.
    expect(row({ from: 1, to: 2, ...ends('proven', 'proven'), word: 'proven', outage: -2, cost: 9_000 })).toEqual([])
    expect(row({ from: 1, to: 2, ...ends('found', 'proven'), word: 'proven', outage: -2, cost: 9_000 })).toEqual(['word'])
    expect(row({ from: 1, to: 2, ...ends('proven', 'proven'), word: 'proven: no gain', outage: 0, cost: 0, finish })).toEqual([])
    expect(row({ from: 1, to: 2, ...ends('proven', 'found'), word: 'proven: no gain', outage: 0, cost: 0, finish })).toEqual(['word'])
    expect(row({ from: 1, to: 2, ...ends('proven', 'proven'), word: 'proven: no gain', outage: 0, cost: 0 })).toEqual(['finish'])
    expect(row({ from: 1, to: 2, ...ends('proven', 'proven'), word: 'proven: no gain', outage: -1, cost: 0, finish })).toEqual(['outage'])
    // found: both solved, at least one not proven.
    expect(row({ from: 1, to: 2, ...ends('proven', 'found'), word: 'found', outage: -2, cost: 9_000 })).toEqual([])
    expect(row({ from: 1, to: 2, ...ends('proven', 'proven'), word: 'found', outage: -2, cost: 9_000 })).toEqual(['word'])
    expect(row({ from: 1, to: 2, ...ends('found', 'unsolved'), word: 'found', outage: -2, cost: 9_000 })).toEqual(['word', 'outage'])
    expect(row({ from: 1, to: 2, ...ends('found', 'found'), word: 'found', outage: 0, cost: 0, finish })).toEqual(['outage'])
    // not solved: an unsolved end, with no differences.
    expect(row({ from: 1, to: 2, ...ends('found', 'unsolved'), word: 'not solved' })).toEqual([])
    expect(row({ from: 0, to: 1, ...ends('unsolved', 'refused'), word: 'not solved' })).toEqual([])
    expect(row({ from: 1, to: 2, ...ends('found', 'found'), word: 'not solved', outage: 0, cost: 0 })).toEqual(['word'])
    // not found better: both solved and no shorter outage above; two proven equal ends read "proven: no gain".
    expect(row({ from: 1, to: 2, ...ends('found', 'found'), word: 'not found better', outage: 0, cost: 0 })).toEqual([])
    expect(row({ from: 1, to: 2, ...ends('found', 'found'), word: 'not found better', outage: -2, cost: 0 })).toEqual(['outage'])
    expect(row({ from: 1, to: 2, ...ends('proven', 'proven'), word: 'not found better', outage: 0, cost: 0 })).toEqual(['word'])
    expect(row({ from: 0, to: 1, ...ends('refused', 'found'), word: 'not found better' })).toEqual(['word'])
    // No word fits two refused rungs, or a solved rung below a refused one.
    for (const word of ['makes it possible', 'not solved', 'proven: no gain', 'found', 'proven', 'not found better']) {
      expect(row({ from: 0, to: 1, ...ends('refused', 'refused'), word })).toContain('word')
      expect(row({ from: 0, to: 1, ...ends('found', 'refused'), word })).toContain('word')
    }
  })
})

describe('increment 2: statusOut carries the lead, so a stored lead proof reaches the Assistant (adversary review P1)', () => {
  const run = { grid: '30min', engine: 'ts-lahc', formulation: 'f1', seed: 1, budget: { evals: 1, cpuMs: 1, wallMs: 1 }, stoppedBy: 'done', evals: 1, cpuMs: 1 }
  const proven = (goal: number) => ({ word: 'proven optimal', goal, value: 340_000, unit: 'NOK', bound: { value: 340_000, source: 'fixed-costs', certificate: { kind: 'fixed-costs', items: [{ key: 'SWA-method', amount: 340_000 }] } } })
  const found = (goal: number) => ({ word: 'best found under budget', goal, value: 2.5, unit: 'h' })
  const option = (lead: object, status: object) => optionSchema.parse({ key: 'cheapest', label: 'Cheapest that keeps every rule', variant: { methods: [], purchases: [], lead },
    status: { word: 'validated feasible', run, ...status }, rows: [], metrics: [], inputsRevision: 1 })

  test('lead {goal: 1} with goal 1 proven: statusOut keeps the lead and parses; without it the order rule would refuse it', () => {
    const stored = option({ goal: 1 }, { goals: [found(0), proven(1), found(2)], lead: { goal: 1 } })
    const out = statusOut(stored.status)
    expect(statusOutSchema.safeParse(out).success).toBe(true)
    expect(out).toMatchObject({ lead: { goal: 1 }, goals: [{ goal: 0, word: 'best found under budget' }, { goal: 1, word: 'proven optimal', bound: 340_000, gap: 0 }, { goal: 2 }] })
    const { lead: _lead, ...withoutLead } = out
    expect(statusOutSchema.safeParse(withoutLead).success).toBe(false)
  })

  test('a group lead\'s own line reaches statusOut with its bound and gap', () => {
    const line = { group: 'AFW-A', word: 'proven optimal', value: 7.5, unit: 'h', bound: { value: 7.5, source: 'logic+calendars', certificate: { kind: 'least-span', spans: [{ group: 'AFW-A', hours: 7.5 }] } } }
    const out = statusOut(option({ group: 'AFW-A' }, { goals: [found(0), found(1)], lead: line }).status)
    expect(statusOutSchema.safeParse(out).success).toBe(true)
    expect(out.lead).toEqual({ group: 'AFW-A', word: 'proven optimal', value: 7.5, unit: 'h', bound: 7.5, gap: 0 })
  })
})

// ═══════════ Increment 2: structured explain facts, the previous options page, dominated options (decision "Lane P batch 2", 3) ═══════════

describe('increment 2: explain recommended gives its facts', () => {
  const facts = {
    option: 'swap.b1', against: 'rebuild.b1', deciding: 1,
    goals: [{ goal: 0, value: 0, against: 0, unit: 'h' }, { goal: 1, value: 472_650, against: 498_200, unit: 'NOK' }, { goal: 2, value: 242.5, against: 322.5, unit: 'h' }],
    caveats: [{ choice: 'SWA-method', option: 'swap', label: 'Weeks without a ready SW spare', value: 10, unit: 'weeks', against: 0 }],
    outage: { goal: 0, group: 'COOL-A', hours: 49 },
  }
  const paths = (value: object) => recommendedFactsSchema.safeParse(value).error?.issues.map(issue => issue.path.join('.')) ?? []

  test('accepted: against another option, or alone; caveats with or without a value', () => {
    expect(paths(facts)).toEqual([])
    expect(explainResultSchema.safeParse({ lines: ['Swap in the spare is recommended.'], items: [], recommended: facts }).success).toBe(true)
    const { against: _against, deciding: _deciding, ...alone } = facts
    expect(paths({ ...alone, goals: alone.goals.map(({ against: _value, ...line }) => line), caveats: [{ choice: 'SWA-method', option: 'swap', label: 'Depends on a delivery' }] })).toEqual([])
    expect(paths({ ...facts, outage: undefined })).toEqual([])
  })

  test('refused: a deciding goal or other values without an option to compare with, against itself, out of order, or an outage that is not a floor in hours (G4)', () => {
    const { against: _against, ...alone } = facts
    expect(paths(alone)).toEqual(expect.arrayContaining(['deciding', 'goals.0.against', 'caveats.0.against']))
    expect(paths({ ...facts, against: facts.option })).toEqual(['against'])
    expect(paths({ ...facts, goals: [facts.goals[1], facts.goals[0]] })).toEqual(['goals'])
    expect(paths({ ...facts, deciding: 4 })).toEqual(['deciding'])
    expect(paths({ ...facts, goals: [facts.goals[0], { ...facts.goals[1], against: undefined }, facts.goals[2]] })).toEqual(['goals.1.against'])
    expect(paths({ ...facts, caveats: [{ ...facts.caveats[0], unit: undefined }] })).toEqual(['caveats.0.unit'])
    expect(paths({ ...facts, outage: { goal: 0, word: 'proven optimal', value: 0, unit: 'h', bound: 0 } }).length).toBeGreaterThan(0)
    expect(paths({ ...facts, outage: { ...facts.outage, goal: 5 } })).toEqual(['outage.goal'])
    expect(paths({ ...facts, outage: { ...facts.outage, hours: -1 } }).length).toBeGreaterThan(0)
    expect(paths({ ...facts, outage: { goal: 0, hours: 49 } }).length).toBeGreaterThan(0)
    expect(paths({ ...facts, outage: { ...facts.outage, group: 'COOL A' } }).length).toBeGreaterThan(0)
    expect(paths({ ...facts, note: 'x' }).length).toBeGreaterThan(0)
  })
})

describe('increment 2: explain versus {previous} gives its facts', () => {
  const was = { start: '2026-11-17T06:00:00Z', finish: '2026-11-17T16:00:00Z' }, now = { start: '2026-11-17T08:00:00Z', finish: '2026-11-17T18:00:00Z' }
  const facts = {
    option: 'swap.c1', previous: 'swap.b1', from: 3, to: 4, complete: true,
    changes: [{ revision: 4, summary: "Changed 'Replace CCW A pump seal': duration" }],
    goals: [{ goal: 0, now: 2, was: 0, unit: 'h' }],
    methods: [{ choice: 'SWA-method', now: 'swap', was: 'rebuild' }],
    buys: { added: ['ot-mech'], dropped: ['contractor-nights'] },
    moved: [{ job: 'CCWA-SEAL', now, was }], movedMore: 3, added: ['CCWA-SEAL-CHECK'], removed: [],
  }
  const paths = (value: object) => versusFactsSchema.safeParse(value).error?.issues.map(issue => issue.path.join('.')) ?? []

  test('accepted: the same option key in both sets, with or without goal values', () => {
    expect(paths(facts)).toEqual([])
    expect(paths({ ...facts, previous: facts.option, complete: false, goals: undefined })).toEqual([])
    expect(explainResultSchema.safeParse({ lines: ['What differs'], items: [], versus: facts }).success).toBe(true)
  })

  test('refused: a previous set not earlier, changes outside the two revisions, a pick or a job that did not change, or one said twice', () => {
    expect(paths({ ...facts, from: 4 })).toEqual(expect.arrayContaining(['from']))
    expect(paths({ ...facts, changes: [{ revision: 3, summary: 'x' }] })).toEqual(['changes'])
    expect(paths({ ...facts, changes: [{ revision: 5, summary: 'x' }] })).toEqual(['changes'])
    expect(paths({ ...facts, methods: [{ choice: 'SWA-method', now: 'swap', was: 'swap' }] })).toEqual(['methods.0.now'])
    expect(paths({ ...facts, methods: [facts.methods[0], facts.methods[0]] })).toEqual(['methods'])
    expect(paths({ ...facts, buys: { added: ['ot-mech'], dropped: ['ot-mech'] } })).toEqual(['buys'])
    expect(paths({ ...facts, moved: [{ job: 'CCWA-SEAL', now: was, was }] })).toEqual(['moved.0'])
    expect(paths({ ...facts, removed: ['CCWA-SEAL'] })).toEqual(['added'])
    expect(paths({ ...facts, moved: Array.from({ length: 21 }, (_, index) => ({ job: `J${index}`, now, was })) }).length).toBeGreaterThan(0)
    expect(paths({ ...facts, movedMore: -1 }).length).toBeGreaterThan(0)
    expect(explainResultSchema.safeParse({ lines: [], items: [], versus: facts, recommended: { option: 'swap.c1', goals: [], caveats: [] } }).success).toBe(false)
  })
})

describe('increment 2: the previous options page, and dominated options', () => {
  const run = { grid: '30min', engine: 'ts-lahc', formulation: 'f1', seed: 1, budget: { evals: 1, cpuMs: 1, wallMs: 1 }, stoppedBy: 'done', evals: 1, cpuMs: 1 }
  const item = (key: string, extra: object = {}) => ({ key, label: key, variant: { methods: [], purchases: [] }, status: { word: 'unresolved', run }, metrics: [], inputsRevision: 3, fresh: false, warnings: [], ...extra })
  const page = (items: unknown[]) => ({ at: '2026-11-12T09:04:00Z', recommended: 'swap.b1', items })

  test('previous pages as the options section does; it is a read section', () => {
    expect(readInputSchema.safeParse({ section: 'previous' }).success).toBe(true)
    expect(sectionDataSchemas.previous.safeParse(page([item('swap.b1'), item('rebuild.b1', { dominated: { by: 'swap.b1' } })])).success).toBe(true)
    expect(sectionDataSchemas.previous.safeParse({ at: null, recommended: null, items: [] }).success).toBe(true)
    expect(sectionDataSchemas.previous.safeParse(page([{ ...item('swap.b1'), rows: [] }])).success).toBe(false)
    expect(sectionDataSchemas.previous.safeParse({ items: [] }).success).toBe(false)
  })

  test('an option is dominated by another option, never by itself; a lead what-if is never dominated', () => {
    expect(optionItemSchema.safeParse(item('rebuild.b1', { dominated: { by: 'swap.b1' } })).success).toBe(true)
    expect(optionItemSchema.safeParse(item('rebuild.b1', { dominated: { by: 'rebuild.b1' } })).error?.issues.map(issue => issue.path.join('.'))).toEqual(['dominated.by'])
    expect(optionItemSchema.safeParse(item('rebuild.b1', { dominated: {} })).success).toBe(false)
    expect(optionItemSchema.safeParse(item('rebuild.b1', { dominated: 'swap.b1' })).success).toBe(false)
    expect(optionItemSchema.safeParse(item('afw-first', { variant: { methods: [], purchases: [], lead: { group: 'AFW-A' } }, dominated: { by: 'swap.b1' } })).success).toBe(false)
    for (const section of ['options', 'previous'] as const) {
      expect(sectionDataSchemas[section].safeParse(page([item('swap.b1', { dominated: { by: 'swap.b1' } })])).success).toBe(false)
    }
  })
})

describe('fix round: what sets the finish on any compared row (G3); each group\'s outage in versus (G5)', () => {
  const finish = { kind: 'crew', about: [{ kind: 'resource', key: 'crane' }] }
  const row = (value: object) => buysRowSchema.safeParse(value).error?.issues.map(issue => issue.path.join('.')) ?? []
  const ends = (from: string, to: string) => ({ ends: { from, to } })

  test('G3: the higher rung\'s cause rides on every row between two solved rungs, and is required only with "proven: no gain"', () => {
    expect(row({ from: 1, to: 2, ...ends('found', 'found'), word: 'found', outage: -2, cost: 9_000, finish })).toEqual([])
    expect(row({ from: 1, to: 2, ...ends('proven', 'proven'), word: 'proven', outage: -2, cost: 9_000, finish })).toEqual([])
    expect(row({ from: 1, to: 2, ...ends('found', 'found'), word: 'not found better', outage: 0, cost: 0, finish })).toEqual([])
    // A "no gain" without its cause reads "not found better"; with both ends proven it still needs its cause.
    expect(row({ from: 1, to: 2, ...ends('found', 'proven'), word: 'not found better', outage: 0, cost: 0 })).toEqual([])
    expect(row({ from: 1, to: 2, ...ends('proven', 'proven'), word: 'proven: no gain', outage: 0, cost: 0 })).toEqual(['finish'])
    expect(row({ from: 0, to: 1, ...ends('refused', 'found'), word: 'makes it possible', finish })).toEqual(['finish'])
    expect(row({ from: 1, to: 2, ...ends('found', 'unsolved'), word: 'not solved', finish })).toEqual(['finish'])
    expect(row({ from: 1, to: 2, ...ends('found', 'found'), word: 'found', outage: -2, cost: 9_000, finish: { kind: 'crew' } }).length).toBeGreaterThan(0)
  })

  test('G5: versus gives each group\'s longest outage now and then, in hours, once per group', () => {
    const facts = { option: 'swap.c1', previous: 'swap.b1', from: 3, to: 4, complete: true, changes: [], methods: [], buys: { added: [], dropped: [] }, moved: [], movedMore: 0, added: [], removed: [] }
    const paths = (value: object) => versusFactsSchema.safeParse(value).error?.issues.map(issue => issue.path.join('.')) ?? []
    const outages = [{ group: 'COOL-A', now: 51, was: 49 }, { group: 'CS-A', now: 7.5, was: 7.5 }, { group: 'AFW-A', now: 9, was: 9 }]
    expect(paths({ ...facts, outages })).toEqual([])
    expect(paths({ ...facts, outages: [] })).toEqual([])
    expect(paths(facts)).toEqual([])
    expect(paths({ ...facts, outages: [outages[0], outages[0]] })).toEqual(['outages'])
    expect(paths({ ...facts, outages: [{ ...outages[0], now: -1 }] }).length).toBeGreaterThan(0)
    expect(paths({ ...facts, outages: [{ group: 'COOL-A', now: 51 }] }).length).toBeGreaterThan(0)
    expect(paths({ ...facts, outages: [{ ...outages[0], unit: 'h' }] }).length).toBeGreaterThan(0)
  })
})
