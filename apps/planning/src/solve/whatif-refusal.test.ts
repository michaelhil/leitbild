// V1 (maint's walk, inc2): "At most 40 h out" for the Train A cooling chain after a 48 h answer. A what-if is
// refused only when every method is, each method's cause verified by lane K and stored beside the others; a
// span refusal names the rule actually breached, the what-if's own 40 h rule, with that rule's limit.
import { afterAll, describe, expect, test } from 'bun:test'
import { verifyEveryMethod, verifySpanRefusal } from '../check/certificate.ts'
import { createRealSolver } from '../api/wiring.ts'
import { optionSchema } from '../plan/schema.ts'
import { bounds } from './bounds.ts'
import { compile } from './compile.ts'
import { prepare } from './decode.ts'
import { generate, solveInputsOf, type AlsoRule, type GenerateDeps } from './generate.ts'
import { createSolverPool } from './pool.ts'
import { searchEngine } from './search.ts'
import { laneKCheck, laneKVerify, laneKVerifyBound, laneKVerifySpan } from './fixtures/lane-k.ts'
import { refusalLines } from './explain.ts'
import { withExtraRules } from './keys.ts'
import { trainAInputs } from './fixtures/train-a-case.ts'

const by = { kind: 'service' as const, name: 'test' }
const deps: GenerateDeps = { engine: searchEngine(), check: laneKCheck, verify: laneKVerify, verifyBound: laneKVerifyBound }
// As production: the child proves a span refusal and stores it (N2, N4); a read words it from storage.
const proving: GenerateDeps = { ...deps, verifySpan: laneKVerifySpan }
const flagship = trainAInputs({ read: true })
const plan72 = flagship.rules.find(rule => rule.kind === 'span-limit' && rule.group === 'COOL-A')!
const at40: Extract<AlsoRule, { kind: 'span-limit' }> = { kind: 'span-limit', key: 'what-if-COOL-A-40h', group: 'COOL-A', limit: { value: 40, unit: 'h' }, singleEntry: true, words: 'At most 40 h out', source: { by: 'planner' } }
const asked = await generate(proving, { inputs: flagship, revision: 1, previous: null, input: { variants: [{ label: 'At most 40 h out', also: [at40] }] }, by, signal: new AbortController().signal, seed: 1, evals: 600 })
const option = asked.optionSet.options[0]!
const pool = createSolverPool()
afterAll(() => pool.shutdown())

describe('a what-if is refused only with a cause for every method', () => {
  test('both methods proven infeasible, each cause stored beside the other and verified by lane K', () => {
    expect(option.status.word).toBe('proven infeasible')
    if (option.status.word !== 'proven infeasible') return
    const byMethod = option.status.byMethod ?? []
    expect(byMethod.map(entry => entry.methods.map(pick => pick.option)).toSorted()).toEqual(flagship.methods[0]!.options.map(choice => [choice.key]).toSorted())
    for (const entry of byMethod) expect(laneKVerify(flagship, { methods: entry.methods, purchases: entry.purchases, also: [at40] }, entry.cause).proves).toBe(true)
    expect(verifyEveryMethod(flagship, [at40], byMethod).proves).toBe(true)
    // The stored cause is the one for the option's own methods.
    expect(byMethod.find(entry => JSON.stringify(entry.methods) === JSON.stringify(option.variant.methods))!.cause).toEqual(option.status.cause)
  })

  test('the stored shape refuses a cause that is not its own methods\' entry, and a single entry', () => {
    if (option.status.word !== 'proven infeasible') throw new Error('refused')
    const byMethod = option.status.byMethod!
    const other = byMethod.find(entry => JSON.stringify(entry.methods) !== JSON.stringify(option.variant.methods))!
    expect(optionSchema.safeParse(option).success).toBe(true)
    expect(optionSchema.safeParse({ ...option, status: { ...option.status, cause: other.cause } }).success).toBe(JSON.stringify(other.cause) === JSON.stringify(option.status.cause))
    expect(optionSchema.safeParse({ ...option, status: { ...option.status, byMethod: byMethod.slice(0, 1) } }).success).toBe(false)
  })
})

describe('a span refusal names the rule breached and that rule\'s limit', () => {
  test('rebuild at 40 h: the what-if\'s own rule, 40 h, never the plan\'s 72 h; lane K proves the claim', () => {
    const rebuild = [{ choice: 'SWA-method', option: 'rebuild' }]
    const { solving } = solveInputsOf(flagship, { also: [at40] })
    const compiled = compile(solving, { methods: rebuild, buy: 'allowed' })
    if (!compiled.ok) throw new Error('compiles')
    const span = bounds(compiled.problem, compiled.index, prepare(compiled.problem)).span
    expect(span).toBeDefined()
    expect([span!.rule, span!.limitHours]).toEqual([at40.key, at40.limit.value])
    expect(span!.leastHours).toBeGreaterThan(at40.limit.value)
    expect(verifySpanRefusal(flagship, { methods: rebuild, purchases: compiled.index.allowedPurchases, also: [at40] }, span!).proves).toBe(true)
    expect(plan72.kind === 'span-limit' && plan72.limit.value).not.toBe(span!.limitHours)
  })

  test('the refusal explain words the what-if\'s 40 h, never 72 h, and never shows nothing', async () => {
    const solver = createRealSolver(pool)
    const answer = await solver.explain({ inputs: flagship, option, ask: 'refusal', job: undefined, cursor: undefined })
    const text = answer.lines.join(' ')
    expect(answer.lines.length).toBeGreaterThan(0)
    expect(text).toContain(`against ${at40.limit.value} h`)
    expect(text).not.toContain(`against ${plan72.kind === 'span-limit' ? plan72.limit.value : 0} h`)
  })
})

describe('N2, N4: a span refusal is stored as lane K proved it in the sub-solve, and worded from storage', () => {
  const stored = async (with_: GenerateDeps) => (await generate(with_, { inputs: flagship, revision: 1, previous: null, input: { variants: [{ label: 'At most 40 h out', also: [at40] }] }, by, signal: new AbortController().signal, seed: 1, evals: 600 })).optionSet.options[0]!

  test('each method\'s refusal keeps the what-if\'s rule, lane K\'s least span against 40 h, and the chains, in the child too', async () => {
    for (const refused of [await stored(proving), await stored({ ...deps, subSolver: pool.subSolver })]) {
      if (refused.status.word !== 'proven infeasible') throw new Error('refused')
      expect(optionSchema.safeParse(refused).success).toBe(true)
      const entries = refused.status.byMethod ?? []
      expect(entries.length).toBe(flagship.methods[0]!.options.length)
      for (const entry of entries) {
        const span = entry.span!
        const variant = { methods: entry.methods, purchases: entry.purchases, also: [at40] }
        // Lane K's own figure, against the what-if's own limit.
        expect([span.rule, span.limitHours, span.leastHours]).toEqual([at40.key, at40.limit.value, verifySpanRefusal(flagship, variant, span).checkerLeastHours!])
        expect(span.path.length).toBeGreaterThan(0)
        if (span.alsoProven !== undefined) expect(laneKVerify(flagship, variant, span.alsoProven).proves).toBe(true)
      }
      // The option's own entry is the status's.
      expect(entries.find(entry => JSON.stringify(entry.methods) === JSON.stringify(refused.variant.methods))!.span).toEqual(refused.status.span)
    }
  }, 120_000)

  test('the words from storage are the words a read worded with lane K\'s check, so a later read changes nothing', async () => {
    const refused = await stored(proving)
    if (refused.status.word !== 'proven infeasible') throw new Error('refused')
    const solver = createRealSolver(pool)
    const read = await solver.explain({ inputs: flagship, option: refused, ask: 'refusal', job: undefined, cursor: undefined })
    const ruled = withExtraRules(flagship, [at40])
    const own = refusalLines(refused.status.cause, ruled, refused.status.span, refused.variant.purchases, refused.variant.methods, `this option (${flagship.methods[0]!.options.find(choice => choice.key === refused.variant.methods[0]!.option)!.label})`)
    expect(read.lines).toContain(`For ${flagship.methods[0]!.options.find(choice => choice.key === refused.variant.methods[0]!.option)!.label}: ${own[0]}`)
    // From its first span line on, the read is the stored refusal's own lines, until the 20 lines run out.
    const from = read.lines.indexOf(own[1]!)
    expect(from).toBeGreaterThan(0)
    expect(read.lines.slice(from)).toEqual(own.slice(1, 1 + read.lines.length - from))
    expect(own.join(' ')).toContain(`against ${at40.limit.value} h`)
  }, 120_000)

  test('a span lane K does not prove is not stored, and the stored shape keeps a span beside a temporal cause only', async () => {
    const unproven = await stored({ ...deps, verifySpan: () => ({ proves: false, reasons: ['test'] }) })
    if (unproven.status.word !== 'proven infeasible') throw new Error('refused')
    expect([unproven.status.span, ...(unproven.status.byMethod ?? []).map(entry => entry.span)].every(span => span === undefined)).toBe(true)
    const refused = await stored(proving)
    if (refused.status.word !== 'proven infeasible') throw new Error('refused')
    const energy = { kind: 'energy' as const, resources: ['mech-station'], jobs: [], requiredHours: 2, availableHours: 1, from: flagship.settings.window!.start, to: flagship.settings.window!.end }
    expect(optionSchema.safeParse({ ...refused, status: { ...refused.status, cause: energy, byMethod: undefined } }).success).toBe(false)
    const other = refused.status.byMethod!.find(entry => JSON.stringify(entry.methods) !== JSON.stringify(refused.variant.methods))!
    expect(optionSchema.safeParse({ ...refused, status: { ...refused.status, span: other.span } }).success).toBe(JSON.stringify(other.span) === JSON.stringify(refused.status.span))
  }, 120_000)

  test('a refusal held by an outage limit, with no span figures, names that limit in words: the what-if\'s, the tightest', () => {
    const covered = new Set(flagship.equipment.filter(item => item.group === 'COOL-A').map(item => item.key))
    const opener = flagship.jobs.find(job => job.kind === 'tag-out' && job.equipment.some(item => covered.has(item)))!
    const cause = { kind: 'temporal' as const, steps: [{ job: opener.key, via: 'span-limit' as const }] }
    expect(refusalLines(cause, withExtraRules(flagship, [at40]), undefined, [], [])[0]).toBe(`Not possible: ${opener.title} cannot fit inside any outage that '${at40.words}' allows.`)
    expect(refusalLines(cause, flagship, undefined, [], [])[0]!.startsWith(`Not possible: ${opener.title} cannot fit inside any outage that '${plan72.words.slice(0, 80)}`)).toBe(true)
  })
})
