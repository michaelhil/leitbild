import { accessContextSchema, moduleCapabilityCollectionSchema, newRequestId, newWorkspaceId, type WorkspaceId } from '@leitbild/contracts'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWorldApplicationAssembly } from '../src/app-assembly.ts'
import { dashboardInputs, displayRunOf, handleDashboard } from '../src/core/api/display-capabilities.ts'
import { handleSimulationRunApi } from '../src/core/api/simulation-run-routes.ts'
import { handleWorldModuleApi } from '../src/core/api/workspace-module-api.ts'
import { objectIdSchema, type ActorId, type IsoTimestamp, type SimulationRunId } from '../src/core/model/index.ts'
import { scenarioAuthoringCatalogFor } from '../src/core/scenarios/authoring.ts'
import { compileScenarioDefinition } from '../src/core/scenarios/compiler.ts'
import { createScenarioRuntimeResolver } from '../src/core/scenarios/runtime-resolver.ts'
import { createSimulationRunRegistry, type SimulationRunRegistry } from '../src/core/simulation-runs/registry.ts'
import type { WorldWorkspaceRuntimeRegistry } from '../src/core/workspaces/runtime-registry.ts'
import { compileVignette, sampleVignette } from '../src/features/displays/compose/view.ts'
import { dashboardsFileSchema } from '../src/features/displays/dashboards/store.ts'
import { createDirectRoutingAdapter } from '../src/routing/direct-adapter.ts'
import { builtinScenarioDefinitions } from '../src/scenarios/definitions.ts'
import { createRoleRunWorkspaces, roleRunPacks, sidedRunDefinition } from './fixtures/role-runs.ts'
import { guardPlantTests } from './plant-hang-guard.ts'

guardPlantTests()

// A4: a Run's dashboards. dashboards.json holds, per scope, the pins and a revision (D-I) and nothing else; it is read
// when asked, never on load, copied with the Run and kept on reset. World computes each scope's default and never
// stores it; a pin that no longer reads is refused alone; a stale revision is refused with the current one; a Run whose
// roles see different sides offers no dashboard (D-31). People (the person routes) and the Assistant (the Capabilities)
// read and change it the same way, each as the caller.

const workspaceId = newWorkspaceId() as WorkspaceId
const nonce = 'board'
let workspaces: WorldWorkspaceRuntimeRegistry
let dataDir: string
const registry = (): SimulationRunRegistry => workspaces.getLoaded(workspaceId)!.simulationRuns
const access = (kind: 'human' | 'ai') => accessContextSchema.parse({ workspaceId, requestId: newRequestId(), actor: { kind, id: `${kind}-board` } })
const person = { id: 'actor:human:board' as ActorId, label: 'Board', role: 'operator' as const }

/** A person's call: the World-direct display route, with the screen's role set where it holds one. */
const board = async (runId: SimulationRunId, kind: 'read' | 'update', body: unknown, roles?: string) => {
  const request = new Request(`http://world.test/api/workspaces/${workspaceId}/world/simulation-runs/${encodeURIComponent(runId)}/displays/dashboard/${kind}${roles === undefined ? '' : `?roles=${roles}`}`, { method: 'POST', body: JSON.stringify(body) })
  const response = (await handleSimulationRunApi(request, new URL(request.url), { registry: registry(), accessContext: access('human'), roleHolders: () => ({}) }))!
  return { status: response.status, body: await response.json() as any }
}
const call = async (path: string, init?: RequestInit) => {
  const request = new Request(`http://world.test${path}`, init)
  const response = (await handleWorldModuleApi(request, new URL(request.url), workspaces))!
  return { status: response.status, body: await response.json() as any }
}
/** The Assistant's call: the Capability through the Host broker, as the AI. */
const assistant = (runId: SimulationRunId, kind: 'read' | 'update', input: unknown) => call(`/internal/workspaces/${workspaceId}/capabilities/world.simulation-run.dashboard.${kind}/invoke`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ workspaceId, capabilityId: `world.simulation-run.dashboard.${kind}`, resource: { workspaceId, moduleId: 'world', type: 'world.simulation-run', id: runId }, input, access: access('ai') }),
})
const fileOf = async (runId: SimulationRunId): Promise<string> => join((await registry().status()).dataDir, 'simulation-runs', runId, 'dashboards.json')
const speedOf = (unit: 'one' | 'two') => ({ spec: { title: `Unit ${unit} speed`, question: 'How fast?', subjects: [`unit:${unit}#speed`], views: [] } })
const openRun = async () => registry().create({ scenarioId: 'open-run' })

beforeAll(async () => {
  ({ workspaces, dataDir } = await createRoleRunWorkspaces(roleRunPacks, [sidedRunDefinition(nonce), sidedRunDefinition(nonce, { sided: false })]))
  await call(`/internal/workspaces/${workspaceId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workspaceId }) })
})
afterAll(async () => { await workspaces.shutdown(); await rm(dataDir, { recursive: true, force: true }) })

describe('dashboards (A4)', () => {
  test('World computes each scope\'s default as the caller reads it, and never stores it', async () => {
    const run = await openRun()
    const all = await board(run.id, 'read', { scope: 'run' })
    expect(all.status).toBe(200)
    // The Run: each observed asset's leads, in Run order; no pin id, each a vignette the window samples like any other.
    expect(all.body.result).toMatchObject({ scope: 'run', revision: 0, stored: false })
    expect(all.body.result.sections.map((section: any) => section.title)).toEqual(['Unit One', 'Unit Two'])
    for (const section of all.body.result.sections) {
      expect(section).not.toHaveProperty('id')
      expect(section.view).toMatchObject({ viewType: 'display.vignette', height: expect.any(Number) })
      expect(JSON.parse(section.view.state).views[0]).toMatchObject({ kind: 'values', lead: { objectId: expect.stringMatching(/^unit:/) } })
    }
    // One card of what the sections show, keyed once across them.
    const card = all.body.result.card
    expect(card.items.map((item: any) => item.key)).toEqual(card.items.map((_: unknown, index: number) => `k${index + 1}`))
    expect(new Set(card.items.flatMap((item: any) => item.subject?.ref === undefined ? [] : [item.subject.ref.split('#')[0]]))).toEqual(new Set(['unit:one', 'unit:two']))
    // A subject: its default. A collection: its observed members' leads side by side, or, observing none, its own default.
    const subject = (await board(run.id, 'read', { scope: { subject: 'unit:one' } })).body.result
    expect(subject.scope).toEqual({ objectId: 'unit:one' })
    expect(JSON.parse(subject.sections[0].view.state).views.map((view: any) => view.kind)).toEqual(['values', 'alerts', 'topology'])
    const units = (await board(run.id, 'read', { scope: { of: { category: 'units' } } })).body.result
    expect(units.scope).toEqual({ of: { packId: 'fixture', categoryId: 'units', closed: false } })
    expect(units.sections.map((section: any) => section.title)).toEqual(['Unit One', 'Unit Two'])
    const tasks = (await board(run.id, 'read', { scope: { of: { category: 'tasks' } } })).body.result
    expect(JSON.parse(tasks.sections[0].view.state).views[0]).toMatchObject({ kind: 'collection', of: { categoryId: 'tasks' } })
    // A subject's dashboard is about one object; an unknown scope is refused with the composer's words.
    expect(await board(run.id, 'read', { scope: { subject: 'unit:one#speed' } })).toMatchObject({ status: 422, body: { error: { code: 'unknown_name' } } })
    expect((await board(run.id, 'read', { scope: { subject: 'fixture' } })).body.error.code).toBe('pack_is_not_an_object')
    // Nothing was stored: no file, and none on read.
    expect(await registry().dashboards(run.id).read()).toEqual({ dashboards: [] })
    await expect(readFile(await fileOf(run.id), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('pins replace the default; a stale revision is refused with the current one; the file holds the signed-off shape only', async () => {
    const run = await openRun()
    const first = await board(run.id, 'update', { scope: 'run', expectedRevision: 0, pin: [speedOf('one')] })
    expect(first.status).toBe(200)
    const pinned = first.body.result.pins[0].id as string
    expect(pinned).toMatch(/^pin-[0-9a-f]{8}$/)
    expect(first.body.result).toMatchObject({ scope: 'run', revision: 1, pins: [{ id: pinned, by: 'person', title: 'Unit one speed' }] })
    expect(await board(run.id, 'update', { scope: 'run', expectedRevision: 0, unpin: [pinned] }))
      .toMatchObject({ status: 409, body: { error: { code: 'dashboard_revision_conflict', details: { revision: 1 } } } })
    // A person pins what they see: a default section's state, by value.
    const shown = (await board(run.id, 'read', { scope: { of: { category: 'units' } } })).body.result.sections[1].view.state as string
    const second = await board(run.id, 'update', { scope: 'run', expectedRevision: 1, pin: [{ state: shown }] })
    expect(second.body.result.pins.map((pin: any) => pin.title)).toEqual(['Unit one speed', 'Unit Two'])
    const read = (await board(run.id, 'read', { scope: 'run' })).body.result
    expect(read).toMatchObject({ revision: 2, stored: true })
    expect(read.sections.map((section: any) => [section.id, section.by, section.title])).toEqual(second.body.result.pins.map((pin: any) => [pin.id, 'person', pin.title]))
    expect(JSON.parse(read.sections[1].view.state)).toEqual(JSON.parse(shown))
    // A spec a person pins is composed now, never marked as the Assistant's.
    expect(JSON.parse(read.sections[0].view.state)).not.toHaveProperty('by')
    // Unpin by id; an id not on it is refused, never skipped.
    expect((await board(run.id, 'update', { scope: 'run', expectedRevision: 2, unpin: [pinned] })).body.result).toMatchObject({ revision: 3, pins: [{ title: 'Unit Two' }] })
    expect(await board(run.id, 'update', { scope: 'run', expectedRevision: 3, unpin: ['pin-00000000'] })).toMatchObject({ status: 404, body: { error: { code: 'dashboard_pin_not_found' } } })
    // At most 2 pins a change and 8 a dashboard.
    expect((await board(run.id, 'update', { scope: 'run', expectedRevision: 3, pin: [speedOf('one'), speedOf('two'), speedOf('one')] })).status).toBe(400)
    for (const revision of [3, 4, 5]) expect((await board(run.id, 'update', { scope: 'run', expectedRevision: revision, pin: [speedOf('one'), speedOf('two')] })).status).toBe(200)
    expect(await board(run.id, 'update', { scope: 'run', expectedRevision: 6, pin: [speedOf('one'), speedOf('two')] })).toMatchObject({ status: 422, body: { error: { code: 'dashboard_full' } } })
    // Another scope keeps its own revision and pins.
    expect((await board(run.id, 'update', { scope: { subject: 'unit:one' }, expectedRevision: 0, pin: [speedOf('one')] })).body.result).toMatchObject({ scope: { objectId: 'unit:one' }, revision: 1 })
    const file = JSON.parse(await readFile(await fileOf(run.id), 'utf8'))
    expect(dashboardsFileSchema.safeParse(file).success).toBe(true)
    expect(Object.keys(file)).toEqual(['dashboards'])
    expect(file.dashboards.map((dashboard: object) => Object.keys(dashboard))).toEqual([['scope', 'revision', 'pins'], ['scope', 'revision', 'pins']])
    expect(file.dashboards.flatMap((dashboard: any) => dashboard.pins.map((pin: object) => Object.keys(pin).join()))).toEqual(Array(8).fill('id,by,spec'))
  })

  test('a pin that no longer reads is refused alone, as the caller: hidden from the Assistant, or gone', async () => {
    const run = await openRun()
    expect((await board(run.id, 'update', { scope: 'run', expectedRevision: 0, pin: [speedOf('one'), speedOf('two')] })).status).toBe(200)
    const revision = run.snapshot().scenario!.agentRestrictions.revision
    await run.setAgentRestrictions(person, { operationIds: [], objects: [{ objectId: objectIdSchema.parse('unit:two'), deny: ['inspect'] }] }, revision)
    // The Assistant reads the card and the sections' titles and refusals, never their states.
    const seen = await assistant(run.id, 'read', { scope: 'run' })
    expect(seen.status).toBe(200)
    expect(seen.body.result.sections.map((section: any) => [section.title, section.refused?.code ?? 'live'])).toEqual([['Unit one speed', 'live'], ['Unit two speed', 'agent_access_restricted']])
    expect(seen.body.result.sections.every((section: any) => section.view === undefined)).toBe(true)
    expect(seen.body.result.card.items.length).toBeGreaterThan(0)
    expect(JSON.stringify(seen.body.result.card)).not.toContain('unit:two')
    // Its pins are refused on what it may not inspect; a pin it makes is the Assistant's.
    expect(await assistant(run.id, 'update', { scope: 'run', expectedRevision: 1, pin: [speedOf('two')] })).toMatchObject({ status: 422, body: { error: { code: 'agent_access_restricted' } } })
    expect((await assistant(run.id, 'update', { scope: 'run', expectedRevision: 1, pin: [speedOf('one')] })).body.result.pins.map((pin: any) => pin.by)).toEqual(['person', 'person', 'agent'])
    expect((await registry().dashboards(run.id).read()).dashboards[0]!.pins.map(pin => pin.spec.by)).toEqual([undefined, undefined, 'assistant'])
    await run.setAgentRestrictions(person, { operationIds: [], objects: [] }, revision + 1)
    // A person reads every pin; once Unit Two is deleted its pin is refused, the others live.
    expect((await board(run.id, 'read', { scope: 'run' })).body.result.sections.every((section: any) => section.refused === undefined)).toBe(true)
    await run.invokeCapability(person, { capabilityId: 'world.object.delete', input: { objectId: 'unit:two' } })
    const after = (await board(run.id, 'read', { scope: 'run' })).body.result
    expect(after.sections.map((section: any) => section.refused?.code ?? 'live')).toEqual(['live', 'unknown_name', 'live'])
    expect(after.sections[1]).toMatchObject({ title: 'Unit two speed', refused: { message: 'unit:two is no longer in this Run' } })
    expect(after.sections[1]).not.toHaveProperty('view')
    // The Run context names the scopes that hold pins.
    const context = await call(`/internal/workspaces/${workspaceId}/capabilities/world.simulation-run.context/invoke`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceId, capabilityId: 'world.simulation-run.context', resource: { workspaceId, moduleId: 'world', type: 'world.simulation-run', id: run.id }, input: {}, access: access('ai') }),
    })
    expect(context.body.result.context.text).toContain('Dashboards stored: run (3 pins); other scopes show World\'s default')
  })

  test('a copy holds the dashboards, a reset keeps them, and the file is read when asked, never on load', async () => {
    const run = await openRun()
    expect((await board(run.id, 'update', { scope: 'run', expectedRevision: 0, pin: [speedOf('one')] })).status).toBe(200)
    const stored = await registry().dashboards(run.id).read()
    const copy = await registry().copy(run.id, {})
    expect(await registry().dashboards(copy.id).read()).toEqual(stored)
    expect((await board(copy.id, 'read', { scope: 'run' })).body.result).toMatchObject({ revision: 1, stored: true, sections: [{ title: 'Unit one speed' }] })
    const reset = await registry().reset(run.id)
    expect(await registry().dashboards(reset.id).read()).toEqual(stored)
    // A file that does not parse never stops the Run loading; it fails visibly when the dashboard is asked for.
    await writeFile(await fileOf(copy.id), '{"dashboards": [{"scope": "run", "revision": 1, "pins": [], "removed": []}]}\n')
    await registry().close(copy.id)
    expect((await registry().load(copy.id)).id).toBe(copy.id)
    await expect(registry().dashboards(copy.id).read()).rejects.toMatchObject({ code: 'dashboards_unreadable' })
  })

  test('refused in a Run whose roles see different sides; a role Run whose roles see everything works as open mode', async () => {
    const sided = await registry().create({ scenarioId: 'sided-run' })
    for (const kind of ['read', 'update'] as const) {
      expect(await board(sided.id, kind, { scope: 'run', expectedRevision: 0, pin: [] }, 'umpire')).toMatchObject({ status: 403, body: { error: { code: 'dashboard_sided_run' } } })
    }
    expect((await board(sided.id, 'read', { scope: 'run' }, 'red-lead')).body.error.code).toBe('role_view_not_supported')
    const unsided = await registry().create({ scenarioId: 'unsided-run' })
    const read = await board(unsided.id, 'read', { scope: 'run' }, 'red-lead')
    expect(read.status).toBe(200)
    expect(read.body.result.sections.length).toBeGreaterThan(0)
    const unit = `unit:redunit-${nonce}`
    expect((await board(unsided.id, 'update', { scope: 'run', expectedRevision: 0, pin: [{ spec: { title: 'Red speed', question: 'How fast?', subjects: [`${unit}#speed`], views: [] } }] }, 'red-lead')).body.result.revision).toBe(1)
    // The Assistant is refused in every role Run, as the platform refuses it.
    expect((await assistant(unsided.id, 'read', { scope: 'run' })).body.error.code).toBe('ai_role_run_unsupported')
  })

  test('the Capabilities\' schemas: a scope, a revision, at most 2 pins and 8 unpins; the Assistant reads and changes, publishing nothing', async () => {
    const update = dashboardInputs.update
    const base = { scope: 'run', expectedRevision: 0 }
    expect(update.safeParse({ ...base, pin: [speedOf('one')] }).success).toBe(true)
    expect(update.safeParse({ ...base, unpin: Array.from({ length: 8 }, (_, index) => `pin-0000000${index}`) }).success).toBe(true)
    for (const refused of [
      base, { ...base, pin: [] }, { ...base, unpin: ['pin-00000001', 'pin-00000001'] }, { ...base, unpin: Array.from({ length: 9 }, (_, index) => `pin-0000000${index}`) },
      { ...base, unpin: ['p1'] }, { ...base, pin: [{ ...speedOf('one'), state: '{}' }] }, { ...base, pin: [{ state: '{"views": []}' }] }, { ...base, expectedRevision: -1, pin: [speedOf('one')] },
      { ...base, scope: 'all', pin: [speedOf('one')] }, { ...base, scope: { subject: '' }, pin: [speedOf('one')] }, { ...base, pin: [speedOf('one')], removed: [] },
    ]) expect(update.safeParse(refused).success).toBe(false)
    expect(dashboardInputs.read.safeParse({ scope: { of: { category: 'units' } } }).success).toBe(true)
    expect(dashboardInputs.read.safeParse({ scope: 'run', since: 0 }).success).toBe(false)
    // The file stores nothing beyond its signed-off shape (D-I): no history, removed list or composed time.
    const pin = { id: 'pin-0000abcd', by: 'person', spec: { title: 'x', at: { at: '2026-01-01T08:00:00.000Z', clock: 'simulation' }, views: [{ kind: 'values', refs: ['unit:one#speed'], rows: 1 }] } }
    expect(dashboardsFileSchema.safeParse({ dashboards: [{ scope: 'run', revision: 1, pins: [pin] }] }).success).toBe(true)
    for (const refused of [
      { dashboards: [{ scope: 'run', revision: 1, pins: [pin], removed: [] }] }, { dashboards: [{ scope: 'run', revision: 1, pins: [{ ...pin, composedAt: 'now' }] }] },
      { dashboards: [{ scope: 'run', revision: 1, pins: [pin, pin] }] }, { dashboards: [{ scope: 'run', revision: 1, pins: [] }, { scope: 'run', revision: 2, pins: [] }] },
      { dashboards: [{ scope: 'run', revision: 1, pins: Array.from({ length: 9 }, (_, index) => ({ ...pin, id: `pin-0000000${index}` })) }] }, { dashboards: [], history: [] },
    ]) expect(dashboardsFileSchema.safeParse(refused).success).toBe(false)
    const catalog = moduleCapabilityCollectionSchema.parse((await call(`/internal/workspaces/${workspaceId}/capabilities`)).body).capabilities
    expect(catalog.filter(entry => String(entry.id).startsWith('world.simulation-run.dashboard.')).map(entry => [String(entry.id), entry.kind, entry.risk, entry.publishes])).toEqual([
      ['world.simulation-run.dashboard.read', 'query', 'read', undefined], ['world.simulation-run.dashboard.update', 'command', 'write', undefined],
    ])
  })
})

describe('T5: the four units\' steam generator levels side by side, and a person pins them', () => {
  const assembly = createWorldApplicationAssembly({ routing: createDirectRoutingAdapter() })
  let plants: SimulationRunRegistry
  let plantsDir: string
  beforeAll(async () => {
    plantsDir = await mkdtemp(join(tmpdir(), 'leitbild-dashboards-'))
    plants = createSimulationRunRegistry({
      dataDir: plantsDir, workspaceId: newWorkspaceId(), scenarioDefinitions: builtinScenarioDefinitions,
      compileScenarioDefinition: source => compileScenarioDefinition(source, assembly.packs, { routing: createDirectRoutingAdapter() }),
      scenarioAuthoringCatalog: scenarioAuthoringCatalogFor(assembly.packs), runtimeAdapters: assembly.runtimeAdapters,
      scenarioRuntimeResolver: createScenarioRuntimeResolver({ packs: assembly.packs }), idleRuntimeCloseTimer: () => () => {},
    })
  })
  afterAll(async () => { await plants.shutdown(); await rm(plantsDir, { recursive: true, force: true }) })

  test('the collection\'s default: each unit\'s leads with its drawn parts\' readings as a table; four pins put it on the Run\'s dashboard', async () => {
    const runtime = await plants.create({ scenarioId: 'halden-offsite-power-restoration' })
    await runtime.setClock({ paused: true })
    await runtime.runMaximumPace(new Date(Date.parse(runtime.snapshot().clock!.currentTime) + 30_000).toISOString() as IsoTimestamp, { shouldStop: () => false })
    const run = await displayRunOf(plants, runtime, person, new Set())
    const dashboard = async (kind: 'read' | 'update', body: unknown) => (await (await handleDashboard(kind, body, { registry: plants, runtime, run, by: 'person' })).json() as any).result
    const units = await dashboard('read', { scope: { of: { category: 'process-plants' } } })
    expect(units.sections.map((section: any) => section.title)).toEqual(['Halden Unit 1', 'Halden Unit 2', 'Halden Unit 3', 'Halden Unit 4'])
    for (const [index, section] of units.sections.entries()) {
      const unit = `plant:halden-${index + 1}`
      const state = JSON.parse(section.view.state)
      // Its leads as its Pack ranks them each sample, then what its drawing writes on its steam generators.
      expect(state.views[0]).toMatchObject({ kind: 'values', lead: { objectId: unit } })
      expect(state.views[1].refs).toEqual(['A', 'B', 'C', 'D'].flatMap(letter => [`${unit}#sg${letter}.levelPercent`, `${unit}#sg${letter}.pressureMPa`]))
      const table = (await compileVignette(run, state)).sections.find(entry => entry.kind === 'grouped')
      expect(table).toMatchObject({ kind: 'grouped', rows: 5, quantities: [{ unit: '%' }, { unit: 'MPa' }] })
      expect(table?.kind === 'grouped' && table.lines.map(line => line.element.shortLabel)).toEqual(['SG A', 'SG B', 'SG C', 'SG D'])
      const read = (await sampleVignette(run, state)).observations.map(observation => observation.ref)
      expect(['A', 'B', 'C', 'D'].every(letter => read.includes(`${unit}#sg${letter}.levelPercent`))).toBe(true)
    }
    // The one card leaves each unit its leading items, side by side: the cap never starves the last.
    expect(units.card.items.slice(0, 4).map((item: any) => item.subject.ref.split('#')[0])).toEqual(units.sections.map((_: unknown, index: number) => `plant:halden-${index + 1}`))
    // A person pins the four of them on the Run's dashboard, two a change.
    const first = await dashboard('update', { scope: 'run', expectedRevision: 0, pin: units.sections.slice(0, 2).map((section: any) => ({ state: section.view.state })) })
    await dashboard('update', { scope: 'run', expectedRevision: first.revision, pin: units.sections.slice(2).map((section: any) => ({ state: section.view.state })) })
    const pinned = await dashboard('read', { scope: 'run' })
    expect(pinned).toMatchObject({ revision: 2, stored: true })
    expect(pinned.sections.map((section: any) => [section.title, section.refused === undefined])).toEqual(units.sections.map((section: any) => [section.title, true]))
  })
})
