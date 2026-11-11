import { describe, expect, test } from 'bun:test'
import { workspaceIdSchema } from '@leitbild/contracts'
import { optionWarnings, preconditions, readiness, takenOut, worldSubjects } from './readiness.ts'
import { planInputsSchema, type Plan, type PlanInputs } from './schema.ts'
import { buildSection, byteLength, readinessText, statusSentence, timeWords } from './summary.ts'

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
    expect(preconditions(trainA).map(entry => entry.state)).toEqual(['unread'])
    const fact = (value: boolean) => [{ id: check.entry.fact, label: 'running', quantity: 'state', value, basis: 'observed' as const, at: '2026-11-12T09:02:00Z', locator: checkLocator }]
    expect(preconditions(read(trainA, fact(check.entry.expect as boolean)))).toEqual([{ job: check.job.key, equipment: check.entry.equipment, words: check.entry.words, state: 'met', at: '2026-11-12T09:02:00Z', value: check.entry.expect }])
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

  test('an order deadline is a decision before the data date and a warning after it', () => {
    const purchase = trainA.purchases.find(entry => entry.orderBy !== undefined && entry.ordered === undefined)!
    expect(readiness(planOf(trainA), { staleOptions: [], now: trainA.settings.dataDate! }).find(item => item.about[0] === purchase.key)?.code)
      .toBe(Date.parse(purchase.orderBy!) < Date.parse(trainA.settings.dataDate!) ? 'order-passed' : 'order-by')
    const late = { ...trainA, settings: { ...trainA.settings, dataDate: new Date(Date.parse(purchase.orderBy!) + 3_600_000).toISOString() } }
    expect(readiness(planOf(late), { staleOptions: [], now: late.settings.dataDate }).find(item => item.about[0] === purchase.key)?.code).toBe('order-passed')
  })

  test('two items taken out with no rule keeping any of them in service warn, on the plan and beside an option', () => {
    const two = trainA.equipment.filter(item => item.key !== (trainA.rules[0]!.kind === 'protected' ? trainA.rules[0]!.equipment[0] : '')).slice(0, 2).map(item => item.key)
    const tagOuts = two.map((key, index) => ({ ...trainA.jobs.find(job => job.kind === 'tag-out')!, key: `TAG-${index}`, equipment: [key], checks: [] }))
    const tests = two.map((key, index) => ({ ...trainA.jobs.find(job => job.kind === 'test')!, key: `TEST-${index}`, equipment: [key] }))
    const inputs: PlanInputs = { ...trainA, jobs: [...tagOuts, ...tests], links: [] }
    expect(takenOut(inputs)).toEqual(two)
    expect(codes(inputs)).toContain('redundancy')
    const row = (job: string, start: string, finish: string) => ({ job, start, finish, uses: [], float: { workingHours: 0, limitedBy: { kind: 'window-end' as const } } })
    const option = {
      key: 'O1', label: 'Both at once', variant: { methods: [], purchases: [] }, inputsRevision: 1, metrics: [],
      status: { word: 'invalid input' as const, problems: [{ about: [], code: 'test' }] },
      rows: [row('TAG-0', '2026-11-16T06:00:00Z', '2026-11-16T07:00:00Z'), row('TAG-1', '2026-11-16T07:00:00Z', '2026-11-16T08:00:00Z'), row('TEST-0', '2026-11-16T10:00:00Z', '2026-11-16T11:00:00Z'), row('TEST-1', '2026-11-16T11:00:00Z', '2026-11-16T12:00:00Z')],
    }
    expect(optionWarnings(inputs, option).map(warning => [warning.code, warning.from, warning.to])).toEqual([['redundancy', '2026-11-16T07:00:00.000Z', '2026-11-16T11:00:00.000Z']])
    const keepOne: PlanInputs = { ...inputs, rules: [...inputs.rules, { kind: 'keep-in-service', key: 'K', members: two.map(equipment => ({ equipment })), atLeast: 1, words: 'Keep one in service', source: { by: 'planner' } }] }
    expect(codes(keepOne)).not.toContain('redundancy')
    expect(optionWarnings(keepOne, option)).toEqual([])
  })
})

describe('the presenter', () => {
  test('every section of both cases fits a 4 KB result and pages the rest', () => {
    for (const inputs of [trainA, supplyRun]) {
      const plan = planOf(inputs)
      const context = { plan, readiness: readiness(plan, { staleOptions: [], now: '2026-11-12T09:00:00Z' }), preconditions: preconditions(inputs), options: new Map(), certifiedSize: { family: 'test plans', maxJobs: 100, evidence: 'test' } }
      for (const name of ['summary', 'jobs', 'rules', 'crews', 'sources', 'options', 'history'] as const) {
        let offset = 0, seen = 0, pages = 0
        for (;;) {
          const sections = buildSection(name, context, offset, 3_500)
          expect(byteLength(sections)).toBeLessThanOrEqual(3_500)
          const data = sections[0]!.data as { items?: unknown[]; more?: string | number; total?: number }
          seen += data.items?.length ?? 0
          pages += 1
          if (typeof data.more !== 'string' || name === 'summary') break
          offset = Number(data.more)
        }
        if (name === 'jobs') expect([seen, pages > 1]).toEqual([inputs.jobs.length, byteLength(inputs.jobs) > 3_500])
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
