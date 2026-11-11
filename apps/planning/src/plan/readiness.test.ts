import { describe, expect, test } from 'bun:test'
import { workspaceIdSchema } from '@leitbild/contracts'
import { outTogether, preconditions, readiness, takenOut, worldRefs, worldSubjects } from './readiness.ts'
import { planInputsSchema, type Plan, type PlanInputs } from './schema.ts'
import { buildSection, byteLength, readinessText, statusSentence, timeWords } from './summary.ts'
import { sectionDataSchemas } from '../api/contract.ts'

const fixture = async (name: string): Promise<PlanInputs> => planInputsSchema.parse(await Bun.file(new URL(`./fixtures/${name}`, import.meta.url)).json())
const trainA = await fixture('train-a.fragment.json')
const supplyRun = await fixture('supply-run.case2.json')
const workspaceId = workspaceIdSchema.parse('5d1b0a9e-6c1e-4d5e-9f00-0000000000a2')
const planOf = (inputs: PlanInputs, revision = 1): Plan => ({
  id: crypto.randomUUID(), workspaceId, revision, createdAt: '2026-11-11T08:00:00Z', updatedAt: '2026-11-11T08:00:00Z',
  inputs, options: null, baselines: [], changes: [{ seq: 1, at: '2026-11-11T08:00:00Z', by: { kind: 'human' }, revision: 1, summary: 'Created', kinds: [] }], droppedChanges: 0,
})
const codes = (inputs: PlanInputs) => readiness(planOf(inputs), { staleOptions: [], now: '2026-11-12T09:00:00Z' }).map(item => item.code)
const check = trainA.jobs.flatMap(job => job.checks.map(entry => ({ job, entry })))[0]!
const checkLocator = trainA.equipment.find(item => item.key === check.entry.equipment)!.locator!
const read = (inputs: PlanInputs, facts: PlanInputs['world']['facts']): PlanInputs => ({ ...inputs, settings: { ...inputs.settings, run: { id: 'run-1', linkedAt: '2026-11-12T09:00:00Z' } }, world: { refreshedAt: '2026-11-12T09:02:00Z', facts } })

describe('readiness: warnings only, never a score (T2)', () => {
  test('an unlinked Definition plan first asks to start its World Scenario and link it', () => {
    const items = readiness(planOf(trainA), { staleOptions: [], now: '2026-11-12T09:00:00Z' })
    expect(items[0]).toMatchObject({ code: 'link-run', label: trainA.settings.scenario!.title })
    expect(readinessText(items[0]!, trainA)).toBe(`Start the '${trainA.settings.scenario!.title}' simulation in World, then link it here.`)
  })

  test('unread World values block Generate; the Supply run names every job and truck that waits for them', () => {
    const unread = readiness(planOf(supplyRun), { staleOptions: [], now: '2026-09-03T08:00:00Z' }).filter(item => item.code === 'world-unread')
    expect(unread.every(item => item.blocks)).toBe(true)
    const owners = new Set([
      ...supplyRun.jobs.filter(job => job.duration.origin.by === 'world' || job.durationWith.some(entry => 'refs' in entry)).map(job => job.key),
      ...supplyRun.resources.filter(resource => resource.attributes.some(attribute => attribute.origin.by === 'world')).map(resource => resource.key),
    ])
    expect(new Set(unread.map(item => item.about[0]))).toEqual(owners)
    expect(worldSubjects(supplyRun).length).toBeLessThanOrEqual(32)
  })

  test('the precondition is checked at read time: unread, met, or not met, with the read time', () => {
    expect(preconditions(trainA).map(entry => entry.state)).toEqual(trainA.jobs.flatMap(job => job.checks.map(() => 'unread')))
    const fact = (value: boolean) => [{ id: check.entry.fact, label: 'running', quantity: 'state', value, basis: 'observed' as const, at: '2026-11-12T09:02:00Z', locator: checkLocator }]
    expect(preconditions(read(trainA, fact(check.entry.expect as boolean))).filter(entry => entry.job === check.job.key)).toEqual([{ job: check.job.key, equipment: check.entry.equipment, words: check.entry.words, state: 'met', at: '2026-11-12T09:02:00Z', value: check.entry.expect }])
    const unmet = readiness(planOf(read(trainA, fact(!check.entry.expect))), { staleOptions: [], now: '2026-11-12T09:00:00Z' }).find(item => item.code === 'precondition-unmet')!
    expect(unmet.blocks).toBe(false)
    expect(readinessText(unmet, trainA)).toBe(`Not ready at read time (${timeWords('2026-11-12T09:02:00Z', trainA.settings.timeZone)}): ${check.entry.words} is not so.`)
  })

  test('missing crew and missing covering tag-out or test are named; an assumption is scheduled and flagged at its promised time', () => {
    const noCrew = { ...trainA, jobs: trainA.jobs.map((job, index) => index === 0 ? { ...job, needs: [] } : job) }
    expect(codes(noCrew)).toContain('no-crew')
    const inside = trainA.jobs.filter(job => job.isolation === 'inside').map(job => job.equipment[0]!)
    const untagged = inside.find(key => !trainA.jobs.some(job => job.kind === 'tag-out' && job.equipment.includes(key)))
    if (untagged !== undefined) expect(readiness(planOf(trainA), { staleOptions: [], now: '2026-11-12T09:00:00Z' }).find(item => item.code === 'no-tag-out' && item.about[0] === untagged)?.blocks).toBe(true)
    const promised = trainA.jobs.find(job => job.notBefore?.source.by === 'assumption')!
    const flagged = readiness(planOf(trainA), { staleOptions: [], now: '2026-11-12T09:00:00Z' }).find(item => item.code === 'assumption' && item.about[0] === promised.key)!
    expect(flagged).toMatchObject({ blocks: false, at: promised.notBefore!.at })
    expect(readinessText(flagged, trainA)).toContain(timeWords(promised.notBefore!.at, trainA.settings.timeZone))
  })

  test('a World value that makes a test shorter than its minimum blocks Generate until a person decides', () => {
    const test = trainA.jobs.find(job => job.kind === 'test' && job.minimum !== undefined)!
    const crew = test.needs.flatMap(need => need.anyOf)[0]!
    const ref = { locator: checkLocator, fact: 'plant:train-a/test-time' }
    const withWorld: PlanInputs = { ...trainA, jobs: trainA.jobs.map(job => job.key !== test.key ? job : { ...job, durationWith: [{ resource: crew, refs: [ref] }] }) }
    const minimumSeconds = test.minimum!.value * 3_600
    const fact = (seconds: number) => [{ id: ref.fact, label: 'Test time', quantity: 'time', unit: 's', value: seconds, basis: 'owner-estimate' as const, at: '2026-11-12T09:02:00Z', locator: checkLocator }]
    expect(codes(read(withWorld, fact(minimumSeconds * 2)))).not.toContain('below-minimum')
    const below = readiness(planOf(read(withWorld, fact(minimumSeconds / 2))), { staleOptions: [], now: '2026-11-12T09:00:00Z' }).find(item => item.code === 'below-minimum')!
    expect([below.about, below.blocks]).toEqual([[test.key], true])
  })

  test('assumptions are one card, never one per value; a promised release keeps its own card (walk fix 10)', () => {
    const items = readiness(planOf(supplyRun), { staleOptions: [], now: '2026-09-03T08:00:00Z' })
    const grouped = items.filter(item => item.code === 'assumptions')
    expect(grouped).toHaveLength(1)
    expect(items.filter(item => item.code === 'assumption')).toEqual([])
    expect(grouped[0]!.count).toBeGreaterThan(1)
    expect(readinessText(grouped[0]!, supplyRun)).toMatch(/^\d+ planning values are assumptions, such as .*: review them\.$/)
    const promised = trainA.jobs.filter(job => job.notBefore?.source.by === 'assumption').map(job => job.key)
    expect(readiness(planOf(trainA), { staleOptions: [], now: '2026-11-12T09:00:00Z' }).filter(item => item.code === 'assumption').map(item => item.about[0])).toEqual(promised)
  })

  test('World values standing in for durations join the one assumptions card; the rounding note stays one card (walk 2, R2-10)', () => {
    const refs = worldRefs(supplyRun).map(entry => entry.ref)
    const facts = [...new Map(refs.map(ref => [`${ref.locator} ${ref.fact}`, ref])).values()].map(ref => ({ id: ref.fact, label: 'Arrival', quantity: 'time', unit: 's', value: 209.8, basis: 'owner-estimate' as const, at: '2026-09-03T08:00:00Z', locator: ref.locator }))
    const read = { ...supplyRun, world: { refreshedAt: '2026-09-03T08:00:00Z', facts } }
    const stand = read.jobs.filter(job => job.duration.origin.by === 'world').length
    expect(stand).toBeGreaterThan(1)
    const items = readiness(planOf(read), { staleOptions: [], now: '2026-09-03T08:00:00Z' })
    expect(items.filter(item => item.code === 'world-duration')).toEqual([])
    const card = items.filter(item => item.code === 'assumptions')
    expect(card.map(item => item.proxies)).toEqual([stand])
    expect(readinessText(card[0]!, read)).toMatch(new RegExp(`^\\d+ planning values are assumptions and ${stand} durations are World values that stand in for the work, such as .*: review them\\.$`))
    expect(items.filter(item => item.code === 'rounded')).toHaveLength(1)
    expect(items.filter(item => !item.blocks).length).toBeLessThanOrEqual(4)
  })

  test('only World values the plan uses are required; an unusable one is named with what to do (walk 3, R3-2, N-B-01)', () => {
    const locator = 'einsatz/unit/unit%3Atruck-1'
    const at = '2026-09-03T08:00:00Z'
    const fact = (id: string, label: string, value: number, unit: string) => ({ id, label, quantity: id, unit, value, basis: 'observed' as const, at, locator })
    const inputs = (needs: PlanInputs['jobs'][number]['needs']): PlanInputs => planInputsSchema.parse({
      settings: { title: 'Trucks', timeZone: 'Europe/Oslo', window: { start: at, end: '2026-09-03T10:00:00Z' }, dataDate: at, grid: '30s', currency: 'NOK', run: { id: 'run-1', linkedAt: at } },
      equipment: [], groups: [], purchases: [], methods: [], links: [], rules: [], goals: [{ metric: 'finish', tolerance: { value: 0, unit: 'h' } }],
      calendars: [{ key: 'whole', label: 'Available for the whole window', weekly: [], periods: [{ start: at, end: '2026-09-03T10:00:00Z' }], except: [], source: { by: 'planner' } }],
      resources: [{ key: 'truck-1', label: 'Truck 1', kind: 'tool', count: 1, calendar: 'whole', locator, source: { by: 'planner' }, attributes: [
        { key: 'payload', label: 'Payload', value: null, unit: 'kg', changes: [], origin: { by: 'world', refs: [{ locator, fact: 'payloadKg' }] } },
        { key: 'steps', label: 'Committed job steps', value: null, unit: 'kg', changes: [], origin: { by: 'world', refs: [{ locator, fact: 'committedSteps' }] } },
      ] }],
      jobs: [{ key: 'haul', title: 'Haul water', kind: 'work', equipment: [], isolation: 'none', duration: { value: 10, unit: 'min', calendar: 'working', origin: { by: 'planner' } }, durationWith: [], needs, continuous: true, checks: [], tags: [] }],
      world: { refreshedAt: at, facts: [fact('payloadKg', 'Payload', 900, 'kg'), fact('committedSteps', 'Committed job steps', 2, '1')] },
    })
    const world = (plan: PlanInputs) => readiness(planOf(plan), { staleOptions: [], now: at }).filter(item => item.code.startsWith('world-'))
    // No job asks for either value: nothing about them is a readiness problem.
    expect(world(inputs([{ anyOf: ['truck-1'], amount: 1, handover: false }]))).toEqual([])
    // A job asks for the payload: it is read and converts, so still nothing.
    expect(world(inputs([{ anyOf: ['truck-1'], amount: 1, handover: false, where: { attribute: 'payload', atLeast: 500, unit: 'kg' } }]))).toEqual([])
    // A job asks for the count as if it were kilograms: one card, naming the value, why, and what to do.
    const asked = inputs([{ anyOf: ['truck-1'], amount: 1, handover: false, where: { attribute: 'steps', atLeast: 1, unit: 'kg' } }])
    const items = world(asked)
    expect(items.map(item => [item.code, item.about[0], item.blocks])).toEqual([['world-unusable', 'truck-1', true]])
    expect(readinessText(items[0]!, asked)).toBe("Truck 1: 'Committed job steps' from World is a plain count with no unit, which does not convert to kg; change that job's need, or stop using this value.")
  })

  test('durations that do not fit the time step are listed once, as rounded up (design D9)', () => {
    expect(codes(trainA)).not.toContain('rounded')
    // The Supply run's World times for one request: arrival 3 min 29.8 s plus service 0 s, on the 30 s step.
    const job = supplyRun.jobs.find(entry => entry.durationWith.some(with_ => 'refs' in with_))!
    const entry = job.durationWith.find(with_ => 'refs' in with_)!
    const refs = 'refs' in entry ? entry.refs : []
    const facts = refs.map((ref, index) => ({ id: ref.fact, label: 'time', quantity: 'time', unit: 's', value: index === 0 ? 209.8 : 0, basis: 'owner-estimate' as const, at: '2026-09-03T08:00:00Z', locator: ref.locator }))
    const read = { ...supplyRun, world: { refreshedAt: '2026-09-03T08:00:00Z', facts } }
    const item = readiness(planOf(read), { staleOptions: [], now: '2026-09-03T08:00:00Z' }).find(entry => entry.code === 'rounded')!
    expect(item.durations).toContainEqual({ job: job.key, resource: entry.resource, fromMs: 209_800, toMs: 210_000 })
    expect(readinessText(item, read)).toContain(`${job.title} with ${read.resources.find(resource => resource.key === entry.resource)!.label} from 3 min 29.8 s to 3 min 30 s`)
    expect(readinessText(item, read)).toMatch(/^(One duration was|\d+ durations were) rounded up to the 30 s step: /)
  })

  test('an order deadline is a decision before the data date and a warning after it', () => {
    const purchase = trainA.purchases.find(entry => entry.orderBy !== undefined && entry.ordered === undefined)!
    expect(readiness(planOf(trainA), { staleOptions: [], now: trainA.settings.dataDate! }).find(item => item.about[0] === purchase.key)?.code)
      .toBe(Date.parse(purchase.orderBy!) < Date.parse(trainA.settings.dataDate!) ? 'order-passed' : 'order-by')
    const late = { ...trainA, settings: { ...trainA.settings, dataDate: new Date(Date.parse(purchase.orderBy!) + 3_600_000).toISOString() } }
    expect(readiness(planOf(late), { staleOptions: [], now: late.settings.dataDate }).find(item => item.about[0] === purchase.key)?.code).toBe('order-passed')
  })

  test('redundancy warns only for items that back each other up (one function), out together, with no rule', () => {
    // Train A's chain is one train in series: its items share no function with each other, so no warning.
    expect(codes(trainA)).not.toContain('redundancy')
    // A pair of feedwater pumps that back each other up, both taken out, with no rule keeping one in service.
    const pump = (key: string): PlanInputs['equipment'][number] => ({ key, label: `Main feedwater pump ${key.slice(-1)}`, supportedBy: [], function: 'MFW' })
    const tagOut = trainA.jobs.find(job => job.kind === 'tag-out')!
    const test = trainA.jobs.find(job => job.kind === 'test')!
    const jobs = ['MFWA', 'MFWB'].flatMap(key => [{ ...tagOut, key: `${key}-TAG`, equipment: [key], checks: [] }, { ...test, key: `${key}-RTS`, equipment: [key] }])
    const pair: PlanInputs = { ...trainA, equipment: [...trainA.equipment, pump('MFWA'), pump('MFWB')], jobs, links: [] }
    expect(readiness(planOf(pair), { staleOptions: [], now: '2026-11-12T09:00:00Z' }).find(item => item.code === 'redundancy')?.about).toEqual(['MFWA', 'MFWB'])
    const row = (job: string, start: string, finish: string) => ({ job, start, finish })
    const together = [row('MFWA-TAG', '2026-11-16T06:00:00Z', '2026-11-16T07:00:00Z'), row('MFWB-TAG', '2026-11-16T07:00:00Z', '2026-11-16T08:00:00Z'), row('MFWA-RTS', '2026-11-16T10:00:00Z', '2026-11-16T11:00:00Z'), row('MFWB-RTS', '2026-11-16T11:00:00Z', '2026-11-16T12:00:00Z')]
    expect(outTogether(pair, together)).toEqual({ kind: 'redundancy', about: ['MFWA', 'MFWB'], from: '2026-11-16T07:00:00.000Z', to: '2026-11-16T11:00:00.000Z' })
    const apart = [row('MFWA-TAG', '2026-11-16T06:00:00Z', '2026-11-16T07:00:00Z'), row('MFWA-RTS', '2026-11-16T08:00:00Z', '2026-11-16T09:00:00Z'), row('MFWB-TAG', '2026-11-16T09:00:00Z', '2026-11-16T10:00:00Z'), row('MFWB-RTS', '2026-11-16T11:00:00Z', '2026-11-16T12:00:00Z')]
    expect(outTogether(pair, apart)).toBeUndefined()
    // A rule keeping one in service answers it.
    const ruled: PlanInputs = { ...pair, rules: [...pair.rules, { kind: 'keep-in-service', key: 'K', members: [{ equipment: 'MFWA' }, { equipment: 'MFWB' }], atLeast: 1, words: 'Keep one feedwater pump in service', source: { by: 'planner' } }] }
    expect(codes(ruled)).not.toContain('redundancy')
    expect(outTogether(ruled, together)).toBeUndefined()
  })
})

describe('the presenter', () => {
  test('every section of both cases matches its shared schema, fits its budget and pages every record exactly once', () => {
    for (const inputs of [trainA, supplyRun]) {
      const plan = planOf(inputs)
      const context = { plan, readiness: readiness(plan, { staleOptions: [], now: '2026-11-12T09:00:00Z' }), options: new Map(), certifiedSize: { decided: false, family: 'test plans', maxJobs: 100, evidence: 'test' } }
      const summary = buildSection('summary', context, 0, 3_500)[0]!.data
      expect(sectionDataSchemas.summary.parse(summary).settings).toEqual(inputs.settings)
      const records = { jobs: inputs.jobs.length + inputs.links.length + inputs.methods.length, rules: inputs.rules.length, crews: inputs.calendars.length + inputs.resources.length + inputs.purchases.length, sources: inputs.equipment.length + inputs.groups.length + inputs.world.facts.length, history: plan.changes.length }
      for (const [name, count] of Object.entries(records) as Array<[keyof typeof records, number]>) {
        let offset = 0, seen = 0
        for (;;) {
          const data = buildSection(name, context, offset, 3_500)[0]!.data
          expect(byteLength(data)).toBeLessThanOrEqual(3_500)
          const parsed = sectionDataSchemas[name].parse(data) as { items: unknown[]; more?: string }
          seen += parsed.items.length
          if (parsed.more === undefined) break
          offset = Number(parsed.more)
        }
        expect([name, seen]).toEqual([name, count])
      }
    }
  })

  test('status words come from the structure; a proof states the work and the capacity', () => {
    const run = { grid: '30min' as const, engine: 'x', formulation: 'x', seed: 1, budget: { evals: 1, cpuMs: 1, wallMs: 1 }, stoppedBy: 'done' as const, evals: 1, cpuMs: 1 }
    const jobs = trainA.jobs.slice(0, 2).map(job => job.key)
    const text = statusSentence({ word: 'proven infeasible', run, cause: { kind: 'chain', jobs, workHours: 38, calendars: ['day'], availableHours: 32, from: '2026-11-16T06:00:00Z', by: '2026-11-19T06:00:00Z' } }, trainA)
    expect(text.startsWith('Proven infeasible: the chain')).toBe(true)
    expect(text).toContain('38 h of work, but only 32 h')
    expect(statusSentence({ word: 'unresolved', run }, trainA)).toContain('not proof')
  })
})
