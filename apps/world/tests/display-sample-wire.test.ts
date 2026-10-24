import { newWorkspaceId } from '@leitbild/contracts'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWorldApplicationAssembly } from '../src/app-assembly.ts'
import { displayRunOf, handleDisplayRoute } from '../src/core/api/display-capabilities.ts'
import type { ActorId, IsoTimestamp, ObjectId } from '../src/core/model/index.ts'
import { scenarioAuthoringCatalogFor } from '../src/core/scenarios/authoring.ts'
import { compileScenarioDefinition } from '../src/core/scenarios/compiler.ts'
import { createScenarioRuntimeResolver } from '../src/core/scenarios/runtime-resolver.ts'
import { createSimulationRunRegistry, type SimulationRunRegistry } from '../src/core/simulation-runs/registry.ts'
import type { SimulationRunRuntime } from '../src/core/simulation-runs/runtime.ts'
import type { AlertRow } from '../src/features/displays/alerts/rows.ts'
import { composeDefault } from '../src/features/displays/compose/compose.ts'
import type { VignetteSample, VignetteState, VignetteValue } from '../src/features/displays/compose/model.ts'
import { sampleVignette, type ViewRun } from '../src/features/displays/compose/view.ts'
import { decodeSample, encodeSample, type WireSample } from '../src/features/displays/compose/wire.ts'
import { createDirectRoutingAdapter } from '../src/routing/direct-adapter.ts'
import { builtinScenarioDefinitions } from '../src/scenarios/definitions.ts'
import { guardPlantTests } from './plant-hang-guard.ts'

guardPlantTests()

// A sample as it travels (§5.8, compose/wire.ts): each alert row leaves out what the vignette derives the same from
// the row and from what the sample says once for its object; each lead value travels by ref where the caller holds its
// declaration. The vignette decodes the very sample World composed.

const at = '2026-07-12T04:02:02.000Z'
const value = (ref: string): VignetteValue => ({ ref, label: ref, quantity: 'pressure', unit: 'MPa', valueType: 'number', thresholds: [], series: { seriesId: `s.${ref}`, intervalMs: 1_000 } })
const row = (objectId: string, id: string, extra: Partial<AlertRow> = {}): AlertRow => ({
  key: `${objectId}|${id}`, objectId: objectId as ObjectId, objectLabel: `${objectId} label`, packId: 'process-plant', categoryId: 'process-plants',
  group: { objectId: objectId as ObjectId },
  alert: { id, kind: 'alarm', severity: 'critical', message: `${id} message`, raisedAt: at as IsoTimestamp, acknowledged: false, priority: 'alarm', clock: 'simulation' },
  priority: 'alarm', state: 'active-unack', raised: { at: at as IsoTimestamp, clock: 'simulation' },
  acknowledge: { capabilityId: 'world.process-plant.ic.lifecycle', input: { action: 'acknowledge', plantId: objectId, lifecycleId: id } },
  ...extra,
})
const sampleOf = (alerts: ReadonlyArray<AlertRow>, extra: Partial<VignetteSample> = {}): VignetteSample => ({
  at: { at, clock: 'simulation', paused: true }, observations: [], alerts, entities: {}, slots: {}, maps: {}, ...extra,
})

describe('a sample on the wire', () => {
  test('rows leave out what decodes the same, and decode to the rows World composed', () => {
    const sample = sampleOf([
      row('plant:a', 'alarm:one', { category: { id: 'electrical', label: 'Electrical', order: 5 }, tag: 'LO-LO · ALM' }),
      row('plant:a', 'alarm:two', { category: { id: 'reactor', label: 'Reactor', order: 0 }, expected: { after: 'RX TRIP' }, action: { label: 'RX TRIP', ends: ['core'] } }),
      // A subject group its Pack names, acknowledged, and a raise time and priority other than its alert's: sent as they are.
      row('plant:a', 'alarm:three', {
        group: { objectId: 'plant:a' as ObjectId, subjectGroup: 'loop-a', label: 'Loop A' }, raised: null, priority: null, state: 'active-ack',
        alert: { id: 'alarm:three', kind: 'alarm', severity: 'warning', message: 'three', raisedAt: at as IsoTimestamp, acknowledged: true, subject: { group: 'loop-a' }, priority: 'warning', clock: 'simulation' },
      }),
      // Its own, derived: no clock, no priority.
      row('plant:a', 'alarm:five', { raised: null, priority: null, alert: { id: 'alarm:five', kind: 'alarm', severity: 'warning', message: 'five', raisedAt: at as IsoTimestamp, acknowledged: false } }),
      // A command that does not follow the object's: sent whole.
      row('plant:a', 'alarm:four', { acknowledge: { capabilityId: 'another.capability', input: { lifecycleId: 'alarm:four' } } }),
      row('plant:b', 'alarm:one', { objectLabel: 'Unit B', category: { id: 'electrical', label: 'Electrical', order: 5 } }),
    ].map(entry => entry.state === 'active-ack' ? (({ acknowledge: _, ...rest }) => rest)(entry) : entry), {
      // Plant A's categories are declared in the sample (its tiles); plant B's are not.
      categories: { 'plant:a': [{ id: 'reactor', label: 'Reactor' }, { id: 'pressurizer', label: 'Pressurizer' }, { id: 'x', label: 'X' }, { id: 'y', label: 'Y' }, { id: 'z', label: 'Z' }, { id: 'electrical', label: 'Electrical' }] },
    })
    const wire = encodeSample(sample)
    expect(decodeSample(JSON.parse(JSON.stringify(wire)) as WireSample)).toEqual(sample)
    const [one, two, three, five, four, other] = wire.alerts
    const plantA = 'plant:a' as ObjectId
    expect(one).toEqual({ objectId: plantA, alert: sample.alerts[0]!.alert, state: 'active-unack', tag: 'LO-LO · ALM', category: 'electrical', acknowledge: true })
    expect([two!.category, two!.acknowledge, two!.expected, two!.action]).toEqual(['reactor', true, { after: 'RX TRIP' }, { label: 'RX TRIP', ends: ['core'] }])
    expect([three!.group, three!.raised, three!.priority, three!.acknowledge]).toEqual([{ objectId: plantA, subjectGroup: 'loop-a', label: 'Loop A' }, null, null, undefined])
    expect(four!.acknowledge).toEqual({ capabilityId: 'another.capability', input: { lifecycleId: 'alarm:four' } })
    expect(five).toEqual({ objectId: plantA, alert: sample.alerts[3]!.alert, state: 'active-unack', acknowledge: true })
    expect([other!.category, other!.objectLabel]).toEqual(['electrical', undefined])
    expect(wire.objects).toEqual({
      'plant:a': { label: 'plant:a label', packId: 'process-plant', categoryId: 'process-plants', acknowledge: { capabilityId: 'world.process-plant.ic.lifecycle', input: { action: 'acknowledge', plantId: 'plant:a' }, alertField: 'lifecycleId' } },
      'plant:b': { label: 'Unit B', packId: 'process-plant', categoryId: 'process-plants', categories: { electrical: { label: 'Electrical', order: 5 } }, acknowledge: { capabilityId: 'world.process-plant.ic.lifecycle', input: { action: 'acknowledge', plantId: 'plant:b' }, alertField: 'lifecycleId' } },
    })
  })

  test('lead values travel by ref where the caller holds them, whole otherwise; one neither held nor sent is refused', () => {
    const [a, b, c] = ['u#a', 'u#b', 'u#c'].map(value)
    const sample = sampleOf([], { leads: { 0: [a!, b!], 2: [c!, a!] } })
    const held = new Map([[a!.ref, a!]])
    const wire = encodeSample(sample, new Set(held.keys()))
    expect(wire.leads).toEqual({ 0: ['u#a', 'u#b'], 2: ['u#c', 'u#a'] })
    expect(wire.declared).toEqual([b!, c!])
    expect(decodeSample(JSON.parse(JSON.stringify(wire)) as WireSample, held)).toEqual(sample)
    expect(decodeSample(encodeSample(sample))).toEqual(sample)
    expect(() => decodeSample(wire)).toThrow('u#a has no declaration')
  })
})

describe('a whole unit after a loss of offsite power, through the route', () => {
  const routing = createDirectRoutingAdapter()
  const assembly = createWorldApplicationAssembly({ routing })
  const person = { id: 'actor:human:wire' as ActorId, label: 'Wire', role: 'operator' as const }
  let registry: SimulationRunRegistry
  let dataDir: string
  let runtime: SimulationRunRuntime
  const runNow = (): Promise<ViewRun> => displayRunOf(registry, runtime, person, new Set())
  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'leitbild-sample-wire-'))
    registry = createSimulationRunRegistry({
      dataDir, workspaceId: newWorkspaceId(), scenarioDefinitions: builtinScenarioDefinitions,
      compileScenarioDefinition: source => compileScenarioDefinition(source, assembly.packs, { routing }),
      scenarioAuthoringCatalog: scenarioAuthoringCatalogFor(assembly.packs), runtimeAdapters: assembly.runtimeAdapters,
      scenarioRuntimeResolver: createScenarioRuntimeResolver({ packs: assembly.packs }), idleRuntimeCloseTimer: () => () => {},
    })
    runtime = await registry.create({ scenarioId: 'halden-offsite-power-restoration' })
    await runtime.setClock({ paused: true })
    const start = Date.parse(runtime.snapshot().clock!.currentTime)
    await runtime.runMaximumPace(new Date(start + 300_000).toISOString() as IsoTimestamp, { shouldStop: () => false })
  })
  afterAll(async () => { await registry.shutdown(); await rm(dataDir, { recursive: true, force: true }) })

  test('the vignette decodes the sample World composed, in under two thirds of its size', async () => {
    const outcome = await composeDefault(await runNow(), 'plant:halden-1')
    if (!outcome.ok) throw new Error(JSON.stringify(outcome.issues))
    const state: VignetteState = outcome.state
    const composed = await sampleVignette(await runNow(), state)
    expect(composed.alerts.length).toBeGreaterThan(10)
    expect(composed.alerts.some(entry => entry.acknowledge !== undefined) && composed.alerts.some(entry => entry.category !== undefined)).toBe(true)
    const leads = [...new Map(Object.values(composed.leads ?? {}).flat().map(entry => [entry.ref, entry] as const))]
    expect(leads.length).toBeGreaterThan(0)
    // As the vignette asks: holding its lead rows' declarations.
    const response = await handleDisplayRoute('sample', { state: JSON.stringify(state), held: leads.map(([ref]) => ref) }, await runNow())
    const text = await response!.text()
    const wire = (JSON.parse(text) as { readonly sample: WireSample }).sample
    expect(wire.declared).toBeUndefined()
    expect(decodeSample(wire, new Map(leads))).toEqual(composed)
    expect(text.length).toBeLessThan(JSON.stringify({ sample: composed }).length * 2 / 3)
    // Asked holding none, every lead value comes whole.
    const unheld = (JSON.parse(await (await handleDisplayRoute('sample', { state: JSON.stringify(state) }, await runNow()))!.text()) as { readonly sample: WireSample }).sample
    expect(decodeSample(unheld)).toEqual(composed)
  })

  test('its history read lets the server\'s other work run between records', async () => {
    const outcome = await composeDefault(await runNow(), 'plant:halden-1')
    if (!outcome.ok) throw new Error(JSON.stringify(outcome.issues))
    const base = await runNow()
    const order: string[] = []
    const viewRun: ViewRun = { ...base, series: (seriesId, from, to) => { order.push('record'); return base.series(seriesId, from, to) } }
    // Another request's work, a turn at a time, for as long as the read lasts.
    let reading = true
    const other = (async () => { while (reading) { await new Promise(resolve => { setImmediate(resolve) }); order.push('other') } })()
    const sample = await sampleVignette(viewRun, outcome.state, { fromMs: Date.parse(runtime.snapshot().clock!.currentTime) - 600_000 })
    reading = false
    await other
    const records = order.flatMap((entry, at) => entry === 'record' ? [at] : [])
    expect(records.length).toBe(Object.keys(sample.series!).length)
    expect(records.length).toBeGreaterThan(8)
    // Between any two records, the other work had a turn.
    expect(records.slice(1).every((at, index) => order.slice(records[index]! + 1, at).includes('other'))).toBe(true)
  })
})
