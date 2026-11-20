// The Library beside a Run, against a test double of Host and Planning: which plans and Definitions it shows,
// what it says the Run offers, and the calls that start a plan for the Run (create naming the Run, then the
// refresh the plan screen uses after linking, then open).
import { describe, expect, test } from 'bun:test'
import { bundledPlanDefinitions, guidedPlanDefinitionIds } from '../definitions/index.ts'
import { createPlanningClient } from './api.ts'
import { createLibraryActions, declaresRoles, definitionsForRun, linkedRunOf, plansBesideRun, rolesOffer, runOfferText, runResourceOf, windowBesideRun } from './beside-run.ts'
import { planResource, published, runResource, workspace } from './fixtures/beside-run.ts'

const planId = '0b4b9a52-2f7e-4c1a-9d3e-0000000000bb'
interface Call { readonly capability: string; readonly expectedRevision?: number; readonly input: Record<string, unknown> }
type Refusal = { readonly status: number; readonly code: string; readonly message: string }

/** Answers Planning's writes for one new plan (each saved write raises its revision) and World's planning index in pages. */
const host = (options: { refuse?: Partial<Record<string, Refusal>>; pages?: ReadonlyArray<ReadonlyArray<{ locator: string; kind: string; at?: string }>> } = {}) => {
  let revision = 0
  const calls: Call[] = []
  const blank = bundledPlanDefinitions.find(definition => definition.id === 'blank')!
  const write = () => ({ plan: { id: planId, title: 'Week 47', revision }, target: { kind: 'resource', ref: { workspaceId: workspace, moduleId: 'planning', type: 'planning.plan', id: planId } }, changed: [], attention: [], problems: [] })
  const client = createPlanningClient(workspace, async (path, init) => {
    const capability = decodeURIComponent(String(path).split('/capabilities/')[1]!.replace('/invoke', ''))
    const body = JSON.parse(String(init?.body)) as { expectedRevision?: number; input: Record<string, unknown> }
    calls.push({ capability, ...(body.expectedRevision === undefined ? {} : { expectedRevision: body.expectedRevision }), input: body.input })
    const refusal = options.refuse?.[capability]
    if (refusal !== undefined) return Response.json({ error: { code: refusal.code, message: refusal.message, retryable: false } }, { status: refusal.status })
    switch (capability) {
      case 'planning.plan.read':
        return Response.json({ result: { target: { kind: 'resource', resource: { workspaceId: workspace, moduleId: 'planning', type: 'planning.plan', id: planId } }, title: 'Week 47', observedAt: '2026-11-20T09:00:00.000Z',
          sections: [{ id: 'summary', title: 'Summary', data: { plan: { id: planId, title: 'Week 47', revision, updatedAt: '2026-11-20T09:00:00.000Z' }, settings: blank.inputs.settings, goals: blank.inputs.goals, refreshedAt: null, attention: [], certifiedSize: null } }] } })
      case 'world.simulation-run.planning-facts': {
        const pages = options.pages ?? [[]]
        const at = body.input.cursor === undefined ? 0 : Number(body.input.cursor)
        const items = pages[at]!.map(({ at: factAt, ...item }) => ({ ...item, label: item.locator,
          facts: factAt === undefined ? [] : [{ id: `${item.locator}/running`, label: 'Running', quantity: 'state', value: 'yes', basis: 'observed', at: factAt }] }))
        return Response.json({ result: { run: { workspaceId: workspace, moduleId: 'world', type: 'world.simulation-run', id: 'run-1' }, observedAt: '2026-11-20T09:00:00.000Z', items, ...(at + 1 < pages.length ? { more: String(at + 1) } : {}) } })
      }
      default:
        revision += 1
        return Response.json({ result: write() }, { status: capability === 'planning.plan.create' ? 201 : 200 })
    }
  })
  const progress: string[] = []
  return { calls, progress, actions: createLibraryActions(client, text => { progress.push(text) }) }
}
const definition = (id: string) => published.find(item => item.ref.id === id)!
const form = { title: 'Week 47', timeZone: 'Europe/Oslo', windowStart: '2026-11-23T07:00', windowEnd: '2026-11-28T07:00', goals: ['finish', 'extra-cost'] as const, grid: '30min' as const }

describe('the plans beside a Run', () => {
  test('plans linked to this Run, then plans linked to no Run; plans of other Runs are left with their Runs', () => {
    const resources = [
      runResource('run-1', 'Train A work week', 'train-a-work-week'),
      planResource('0b4b9a52-2f7e-4c1a-9d3e-000000000001', 'For this Run', 'run-1'),
      planResource('0b4b9a52-2f7e-4c1a-9d3e-000000000002', 'Unlinked', null),
      planResource('0b4b9a52-2f7e-4c1a-9d3e-000000000003', 'For another Run', 'run-9'),
    ]
    const grouped = plansBesideRun(resources, 'run-1')
    expect(grouped.forRun.map(plan => plan.title)).toEqual(['For this Run'])
    expect(grouped.unlinked.map(plan => plan.title)).toEqual(['Unlinked'])
    expect(linkedRunOf(resources[3]!)).toBe('run-9')
    expect(runResourceOf(resources, 'run-1')?.title).toBe('Train A work week')
    expect(runResourceOf(resources, 'run-9')).toBeNull()
  })

  test('a Run allows the blank plan and the Definitions of its own Scenario only', () => {
    const offered = (scenario: string | null) => definitionsForRun(published, runResource('run-1', 'A Run', scenario)).map(item => String(item.ref.id))
    expect(offered('train-a-work-week')).toEqual(['blank', 'train-a-work-week'])
    expect(offered('supply-run')).toEqual(['blank', 'supply-run'])
    // A guided Definition is offered only beside a Run of its own Scenario.
    expect(offered('halden-delivery-planning')).toEqual(['blank', 'halden-delivery-planning'])
    expect(offered('nuclear-maintenance-planning')).toEqual(['blank', 'nuclear-maintenance-planning'])
    expect(offered('halden-normal-operation')).toEqual(['blank'])
    expect(offered(null)).toEqual(['blank'])
  })

  test('every bundled Definition that names a Scenario has that Scenario\'s id as its own, which the match relies on', () => {
    for (const item of bundledPlanDefinitions) {
      const scenario = item.inputs.settings.scenario
      if (scenario === undefined) expect(item.id).toBe('blank')
      else expect(scenario.id).toBe(item.id)
    }
    // A guided Definition's published link names the same Scenario.
    for (const item of published.filter(entry => guidedPlanDefinitionIds.has(entry.ref.id))) expect(item.links?.map(link => link.ref.id)).toEqual([item.ref.id])
  })
})

describe('what this Run offers', () => {
  test('every page of World\'s planning index is read once and counted by kind', async () => {
    const double = host({ pages: [
      [{ locator: 'process-plant/pump/a', kind: 'pump' }, { locator: 'process-plant/pump/b', kind: 'pump' }],
      [{ locator: 'process-plant/pump/b', kind: 'pump' }, { locator: 'process-plant/hx/a', kind: 'heat-exchanger' }],
    ] })
    const offer = await double.actions.runOffer('run-1')
    expect(double.calls.map(call => call.input)).toEqual([{ limit: 20 }, { limit: 20, cursor: '1' }])
    expect(offer).toEqual({ state: 'read', kinds: [{ kind: 'pump', count: 2 }, { kind: 'heat-exchanger', count: 1 }], simulationAt: null })
    expect(runOfferText(offer)).toBe('Planning can read 3 items in this simulation (pump: 2, heat exchanger: 1). A plan can also use the planner\'s own figures.')
  })

  test('the latest simulation time a read value describes starts a new plan\'s window, on the hour, five days long', async () => {
    const offer = await host({ pages: [
      [{ locator: 'process-plant/pump/a', kind: 'pump', at: '2026-07-12T04:05:02.000Z' }],
      [{ locator: 'process-plant/pump/b', kind: 'pump', at: '2026-07-12T04:05:31.500Z' }],
    ] }).actions.runOffer('run-1')
    expect(offer).toEqual({ state: 'read', kinds: [{ kind: 'pump', count: 2 }], simulationAt: '2026-07-12T04:05:31.500Z' })
    expect(windowBesideRun('2026-07-12T04:05:31.500Z')).toEqual({ start: '2026-07-12T04:00:00.000Z', end: '2026-07-17T04:00:00.000Z' })
  })

  test('a Run with roles is not asked: picking a role would not change the answer', () => {
    const plain = runResource('run-1', 'Halden border', 'halden-border')
    expect(declaresRoles(plain)).toBe(false)
    expect(declaresRoles({ ...plain, summary: [...plain.summary, { key: 'roles', label: 'Roles', kind: 'count' as const, value: 2 }] })).toBe(true)
    expect(runOfferText(rolesOffer)).toBe('Planning does not read simulations with roles. A plan can still use the planner\'s own figures.')
  })

  test('a simulation with nothing Planning can read says so', async () => {
    const offer = await host({ pages: [[]] }).actions.runOffer('run-1')
    expect(runOfferText(offer)).toBe('This simulation has nothing Planning can read. A plan can still use the planner\'s own figures.')
  })

  test('a Run with roles says World\'s refusal in its own words', async () => {
    const offer = await host({ refuse: { 'world.simulation-run.planning-facts': { status: 403, code: 'query_read_scope_unavailable', message: 'Planning facts are read only from Runs without roles' } } }).actions.runOffer('run-1')
    expect(runOfferText(offer)).toBe('Planning facts are read only from Runs without roles. A plan can still use the planner\'s own figures.')
    expect(runOfferText({ state: 'reading' })).toBe('Looking at what Planning can read in this simulation…')
  })
})

describe('starting a plan for this Run', () => {
  test('a Definition is created with a plan edit naming the Run, then read with the refresh at its new revision', async () => {
    const double = host()
    expect(await double.actions.start(definition('train-a-work-week'), 'run-1')).toBe(planId)
    expect(double.calls).toEqual([
      { capability: 'planning.plan.create', input: { edits: [{ edit: 'plan', run: 'run-1' }] } },
      { capability: 'planning.sources.refresh', expectedRevision: 1, input: { plan: planId } },
    ])
    expect(double.progress).toEqual(['Starting the plan…', 'Reading World values…'])
  })

  test('a refused read still opens the plan, which exists and is linked', async () => {
    const double = host({ refuse: { 'planning.sources.refresh': { status: 403, code: 'query_read_scope_unavailable', message: 'Planning facts are read only from Runs without roles' } } })
    expect(await double.actions.start(definition('train-a-work-week'), 'run-1')).toBe(planId)
    expect(double.calls.map(call => call.capability)).toEqual(['planning.plan.create', 'planning.sources.refresh'])
  })

  test('a refused create opens nothing: its refusal is the Library\'s to say', async () => {
    const double = host({ refuse: { 'planning.plan.create': { status: 400, code: 'invalid_request', message: 'No' } } })
    await expect(double.actions.start(definition('train-a-work-week'), 'run-1')).rejects.toThrow('No')
    expect(double.calls.map(call => call.capability)).toEqual(['planning.plan.create'])
  })

  test('a blank plan names the Run at create, gets its goals, then reads its values at the latest revision', async () => {
    const double = host()
    expect(await double.actions.startBlank(definition('blank'), { ...form, goals: [...form.goals] }, 'run-1')).toBe(planId)
    expect(double.calls.map(call => call.capability)).toEqual(['planning.plan.create', 'planning.plan.read', 'planning.plan.edit', 'planning.sources.refresh'])
    const create = double.calls[0]!.input
    expect(create.grid).toBe('30min')
    expect((create.edits as Array<{ edit: string; run?: string; title?: string }>).map(edit => [edit.edit, edit.run ?? edit.title])).toEqual([['plan', 'Week 47'], ['plan', 'run-1']])
    expect(double.calls[2]!.expectedRevision).toBe(1)
    expect(double.calls[3]).toEqual({ capability: 'planning.sources.refresh', expectedRevision: 2, input: { plan: planId } })
  })

  test('beside no Run the calls are as before: create alone, and a blank plan without a Run or a read', async () => {
    const alone = host()
    await alone.actions.start(definition('train-a-work-week'), null)
    expect(alone.calls).toEqual([{ capability: 'planning.plan.create', input: {} }])
    const blank = host()
    await blank.actions.startBlank(definition('blank'), { ...form, goals: [...form.goals] }, null)
    expect(blank.calls.map(call => call.capability)).toEqual(['planning.plan.create', 'planning.plan.read', 'planning.plan.edit'])
    expect((blank.calls[0]!.input.edits as unknown[]).length).toBe(1)
  })

  test('the guided plan of this Run\'s Scenario is opened through the guided create for this Run', async () => {
    const double = host()
    expect(await double.actions.openGuided(definition('halden-delivery-planning'), 'run-1')).toBe(planId)
    expect(double.calls).toEqual([{ capability: 'planning.plan.create', input: { demoRun: 'run-1' } }])
  })
})
