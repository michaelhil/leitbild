// The options and previous sections page a compact item for a refusal (coordinator, shape E): the option's own
// cause and span summary, and per method combination one `line`, the figures first and then the method's name;
// each combination's picks, purchases, cause and full proof only in explain refusal. Each record fits its 4 KB
// page with room to spare on the cases a plan within the certified size can have: the 40 h what-if, 8
// combinations of 3 open method choices with keys and labels at 64 characters, a plain refusal with its stored
// energy proof, and the walk's full 8-option set. (The schema's most is a known limit, for increment 3.)
import { afterAll, describe, expect, test } from 'bun:test'
import { generate, type GenerateDeps } from '../solve/generate.ts'
import { ladderRungs, rungRequest } from '../solve/ladder.ts'
import { searchEngine } from '../solve/search.ts'
import { refusalLines } from '../solve/explain.ts'
import { withExtraRules } from '../solve/keys.ts'
import { laneKCheck, laneKVerify, laneKVerifyBound, laneKVerifySpan } from '../solve/fixtures/lane-k.ts'
import { optionSchema, planInputsSchema, type PlanInputs } from '../plan/schema.ts'
import { clip } from '../plan/summary.ts'
import { compactLineLength, sectionDataSchemas } from './contract.ts'
import { createSolverDouble } from './fixtures/doubles.ts'
import { formulation, planWith, rebuild, swap, trainAInputs, type Option } from './fixtures/choose.ts'
import { createHarness } from './fixtures/harness.ts'

const harness = await createHarness({ solver: { ...createSolverDouble(), formulation: () => formulation } })
afterAll(() => harness.close())

const proving: GenerateDeps = { engine: searchEngine(), check: laneKCheck, verify: laneKVerify, verifyBound: laneKVerifyBound, verifySpan: laneKVerifySpan }
const generated = async (input: Parameters<typeof generate>[1]['input']): Promise<Option[]> =>
  (await generate(proving, { inputs: trainAInputs, revision: 3, previous: null, input, by: { kind: 'service', name: 'test' }, signal: new AbortController().signal, seed: 1, evals: 600 })).optionSet.options
const asked = (hours: number) => ({ kind: 'span-limit' as const, key: `what-if-COOL-A-${hours}h`, group: 'COOL-A', limit: { value: hours, unit: 'h' as const }, singleEntry: true, words: `Train A cooling chain back within ${hours} h`, source: { by: 'planner' as const } })
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength
/** Room to spare inside the 4,096 B result: no record over this (about 12 % under it, after the page frame). */
const roomy = 3_600

/** Every item of the options and previous sections, all pages, each page within 4 KB. */
const read = async (id: string, section: 'options' | 'previous') => {
  const items = []
  let cursor: string | undefined
  do {
    const answer = await harness.call('planning.plan.read', { resource: id, input: { section, ...(cursor === undefined ? {} : { cursor }) } })
    expect([section, answer.status, answer.bytes <= 4_096]).toEqual([section, 200, true])
    const data = sectionDataSchemas[section].parse(answer.body.result.sections[0].data)
    items.push(...data.items)
    cursor = data.more
  } while (cursor !== undefined)
  return items
}
const largest = (items: ReadonlyArray<unknown>) => Math.max(...items.map(bytes))
/** The plan (on `inputs`) with `options` now and as its previous set, so both sections page them. */
const stored = async (options: readonly Option[], inputs: PlanInputs = trainAInputs) => {
  const base = planWith(harness.workspaceId, options, 3, { inputs })
  return harness.store.create(harness.workspaceId, { ...base, previousOptions: { at: base.options!.at, by: { kind: 'human' }, options: options.map(option => ({ ...option, inputsRevision: 2 })) } })
}
/** A pick list in planner words: its method options' labels. */
const labels = (inputs: PlanInputs, methods: ReadonlyArray<{ readonly choice: string; readonly option: string }>) =>
  methods.map(pick => inputs.methods.find(choice => choice.key === pick.choice)!.options.find(option => option.key === pick.option)!.label).join(', ')

const [at40] = await generated({ variants: [{ label: 'At most 40 h out', also: [asked(40)] }] })
if (at40?.status.word !== 'proven infeasible' || at40.status.byMethod === undefined) throw new Error('the 40 h what-if is refused for every method')

describe('a refusal is a compact item in the options and previous sections', () => {
  test('the 40 h what-if: its own cause and span summary, and one line per method, figures first; no picks, path, later start or energy proof', async () => {
    const plan = await stored([swap, rebuild, at40])
    for (const section of ['options', 'previous'] as const) {
      const item = (await read(plan.id, section)).find(entry => entry.key === at40.key)!
      if (item.status.word !== 'proven infeasible' || at40.status.word !== 'proven infeasible') throw new Error('refused')
      expect(item.status.cause).toEqual(at40.status.cause)
      expect(item.status.span).toEqual({ rule: at40.status.span!.rule, leastHours: at40.status.span!.leastHours, limitHours: at40.status.span!.limitHours })
      // Each entry is {line}: the option's own first (as stored), each method named after its figures.
      expect(item.status.byMethod).toEqual(at40.status.byMethod!.map(entry => ({ line: `Out at least ${entry.span!.leastHours} h, against the 40 h asked: ${labels(trainAInputs, entry.methods)}.` })))
      expect(JSON.stringify(item)).not.toMatch(/"path"|"later"|"alsoProven"/)
      expect(bytes(item)).toBeLessThanOrEqual(roomy)
    }
  }, 120_000)

  test('a method without a span: its stored cause\'s one sentence, then the method\'s name', async () => {
    if (at40.status.word !== 'proven infeasible') throw new Error('refused')
    const [own, other] = at40.status.byMethod!
    const { span: _, ...plain } = other!
    const mixed = optionSchema.parse({ ...at40, key: 'one-without-span', status: { ...at40.status, byMethod: [own, plain] } })
    const plan = await stored([swap, rebuild, mixed])
    const item = (await read(plan.id, 'options')).find(entry => entry.key === 'one-without-span')!
    if (item.status.word !== 'proven infeasible') throw new Error('refused')
    const sentence = refusalLines(plain.cause, withExtraRules(trainAInputs, at40.variant.also), undefined, plain.purchases, plain.methods)[0]!
    expect(item.status.byMethod![1]).toEqual({ line: clip(`${sentence.replace(/\.$/, '')}: ${labels(trainAInputs, plain.methods)}.`, compactLineLength) })
  }, 120_000)

  test('release size: 8 combinations of 3 open method choices, keys and labels at 64 characters, rule words at 200, the flagship\'s cause and run', async () => {
    if (at40.status.word !== 'proven infeasible') throw new Error('refused')
    // What a plan within the certified size can have (coordinator): keys and labels at 64 characters, the what-if's
    // words at 200; the cause and run as the flagship's 40 h proof stores them. The schema's most is a known limit.
    const key = (stem: string) => stem.padEnd(64, 'x')
    const label = (stem: string) => `${`${stem} `.padEnd(63, 'word ')}x`
    const renames = [['SWA-method', key('SWA-method-')], ['swap', key('swap-')], ['rebuild', key('rebuild-')], ['COOL-A', key('COOL-A-')], [asked(40).key, key('what-if-COOL-A-')]] as const
    const renamed = <T>(value: T): T => JSON.parse(renames.reduce((text, [from, to]) => text.replaceAll(`"${from}"`, `"${to}"`), JSON.stringify(value)))
    const base = renamed(trainAInputs)
    const real = { ...base.methods[0]!, label: label('Pump A method'), options: base.methods[0]!.options.map(option => ({ ...option, label: label(option.label) })) }
    const more = [2, 3].map(n => ({ ...real, key: key(`PMP-${n}-method-`), label: label(`Pump ${n} method`), options: real.options.map((option, k) => ({ ...option, key: key(`pmp-${n}-${k}-`), label: label(`Pump ${n} option ${k}`) })) }))
    const inputs = planInputsSchema.parse({ ...base, methods: [real, ...more] })
    const what = renamed(at40)
    if (what.status.word !== 'proven infeasible') throw new Error('refused')
    const [own, other] = what.status.byMethod!
    // Combination k flips choice c from the option's own pick when bit c is set; k = 0 is the option's own.
    const ownAt = real.options.findIndex(option => option.key === own!.methods[0]!.option)
    const place = (k: number) => inputs.methods.map((_, c) => ((k >> c) & 1) === 1 ? 1 - ownAt : ownAt)
    const picks = (k: number) => inputs.methods.map((choice, c) => ({ choice: choice.key, option: choice.options[place(k)[c]!]!.key }))
    const entries = Array.from({ length: 8 }, (_, k) => ({ ...((k & 1) === 1 ? other! : own!), methods: picks(k) }))
    const option = optionSchema.parse({
      ...what, key: key('what-if-option-'), label: label('At most 40 h out'),
      variant: { ...what.variant, methods: picks(0), also: [{ ...what.variant.also![0]!, words: `${'Train A cooling chain back within 40 h, '.repeat(6).slice(0, 199)}x` }] },
      status: { ...what.status, byMethod: [5, 3, 0, 7, 1, 6, 2, 4].map(k => entries[k]!) },   // stored in no particular order
    })
    // The option's own first, then the plan's combination order: by each choice's option, the first choice first.
    const rest = [1, 2, 3, 4, 5, 6, 7].sort((a, b) => { const [x, y] = [place(a), place(b)]; const c = x.findIndex((at, index) => at !== y[index]); return c === -1 ? 0 : x[c]! - y[c]! })
    const figures = (k: number) => `Out at least ${entries[k]!.span!.leastHours} h, against the 40 h asked: `
    console.log('stored release case, without rows:', bytes({ ...option, rows: undefined }))
    const plan = await stored([renamed(swap), renamed(rebuild), option], inputs)
    for (const section of ['options', 'previous'] as const) {
      const item = (await read(plan.id, section)).find(entry => entry.key === option.key)!
      if (item.status.word !== 'proven infeasible') throw new Error('refused')
      expect(item.status.byMethod).toEqual([0, ...rest].map(k => ({ line: clip(`${figures(k)}${labels(inputs, picks(k))}.`, compactLineLength) })))
      // A clip cuts the name, never the figures.
      expect(item.status.byMethod!.every((entry, at) => entry.line.length <= compactLineLength && entry.line.startsWith(figures([0, ...rest][at]!)))).toBe(true)
      console.log(`${section}: release-case item`, bytes(item))
      expect(bytes(item)).toBeLessThanOrEqual(roomy)
    }
  }, 120_000)

  test('a plain refusal with its stored energy proof, and the walk\'s full 8-option set: every record fits', async () => {
    // The walk's set: the ladder's lower rungs (their refusals with stored spans and energy proofs), the plan's
    // two options, and two refused what-ifs.
    const lower = (await Promise.all(ladderRungs(trainAInputs).slice(0, 2).map(rung => generated(rungRequest(trainAInputs, rung, combo => `${combo[0]!.option}: rung ${rung.rung + 1}`))))).flat()
    const [at38] = await generated({ variants: [{ label: 'At most 38 h out', also: [asked(38)] }] })
    const set = [swap, rebuild, ...lower, at40, at38!].slice(0, 8)
    expect(set).toHaveLength(8)
    const energy = set.filter(option => option.status.word === 'proven infeasible' && option.status.span?.alsoProven !== undefined)
    console.log('stored refusals with an energy proof:', energy.map(option => [option.label, bytes({ ...option, rows: undefined })]))
    const plan = await stored(set)
    for (const section of ['options', 'previous'] as const) {
      const items = await read(plan.id, section)
      expect(items).toHaveLength(8)
      console.log(`${section}: largest item`, largest(items))
      expect(largest(items)).toBeLessThanOrEqual(roomy)
    }
    // Generate's result carries all eight, with room: statusOut gives no span or methods.
    const inner = createSolverDouble()
    const local = await createHarness({ solver: { ...inner, formulation: () => formulation, generate: async request => ({ at: request.at, by: request.by, options: set.map(option => ({ ...option, inputsRevision: request.inputsRevision })), recommended: swap.key }) } })
    try {
      const created = await local.create('train-a-work-week')
      const answer = await local.call('planning.plan.generate', { resource: created.id, input: {}, expectedRevision: 1 })
      console.log('generate result', answer.bytes)
      expect([answer.status, answer.body.result.options.length, answer.bytes <= 4_096]).toEqual([200, 8, true])
      for (const section of ['summary', 'buys', 'history'] as const) {
        const page = await local.call('planning.plan.read', { resource: created.id, input: { section } })
        console.log(section, page.bytes)
        expect([section, page.status, page.bytes <= 4_096]).toEqual([section, 200, true])
      }
    } finally { await local.close() }
  }, 300_000)
})
