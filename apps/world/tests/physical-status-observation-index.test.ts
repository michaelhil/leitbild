import { expect, test } from 'bun:test'
import { accessContextSchema, newRequestId, newWorkspaceId } from '@leitbild/contracts'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isoTimestampSchema } from '../src/core/model/time.ts'
import { objectIdSchema } from '../src/core/model/ids.ts'
import type { Observation } from '../src/core/observation/model.ts'
import type { VignetteValue } from '../src/features/displays/compose/model.ts'
import type { AlertRow } from '../src/features/displays/alerts/rows.ts'
import { physicalSubjectStatus, type PhysicalSubjectReading } from '../src/ui/physical-layout/status.ts'
import { physicalSubjectStatus as priorStatus } from './fixtures/physical-layout/status-before-observation-index.ts'
import { handleSimulationRunApi } from '../src/core/api/simulation-run-routes.ts'
import { createSimulationRunRegistry } from '../src/core/simulation-runs/registry.ts'
import { scenarioDefinitionSchema } from '../src/core/scenarios/definition.ts'
import { compileScenarioDefinition } from '../src/core/scenarios/compiler.ts'
import { scenarioAuthoringCatalogFor } from '../src/core/scenarios/authoring.ts'
import { createScenarioRuntimeResolver } from '../src/core/scenarios/runtime-resolver.ts'
import { physicalLayoutPack } from '../src/packs/physical-layout/pack.ts'
import { pwrOperatorUnitPhysicalDesignRef } from '../src/packs/physical-layout/design.ts'
import { processPlantPack } from '../src/packs/process-plant/pack.ts'
import { createLocalProcessPlantPackRuntimeAdapter } from '../src/packs/process-plant/sim/adapter.ts'
import { createDirectRoutingAdapter } from '../src/routing/direct-adapter.ts'
import { layoutLiveResponseSchema } from '../src/ui/physical-layout/read-model.ts'

const at = isoTimestampSchema.parse('2026-10-27T21:50:00Z'), subject = { packId: 'process-plant', objectId: 'plant:one', elementId: 'pump', label: 'Pump' }
const value = (id: string, extra: Partial<VignetteValue> = {}): VignetteValue => ({ ref: `plant:one#${id}`, label: id, quantity: 'state', unit: '', valueType: 'boolean', thresholds: [], series: null, states: [{ value: 'true', label: 'RUN' }, { value: 'false', label: 'STOP' }], ...extra })
const observation = (ref: string, raw: Observation['value'] = true, quality: Observation['quality'] = 'good', priority: Observation['priority'] = 'none'): Observation => ({ ref, at, clock: 'simulation', value: raw, quality, priority })
const alert = (id: string, state: AlertRow['state']): AlertRow => ({ key: `plant:one|${id}`, objectId: objectIdSchema.parse('plant:one'), objectLabel: 'Plant', packId: 'process-plant', categoryId: 'plants', group: { objectId: objectIdSchema.parse('plant:one') }, priority: 'alarm', state, raised: { at, clock: 'simulation' }, alert: { id, kind: 'process-alarm', message: 'Pump alarm', severity: 'critical', priority: 'alarm', raisedAt: at, acknowledged: state === 'active-ack', subject: { element: 'pump' }, ...(state === 'returned-unack' ? { returned: true as const } : {}) } })
const compare = (reading: PhysicalSubjectReading, rows: ReadonlyArray<AlertRow> = []): void => {
  for (const frozen of [false, true]) expect(physicalSubjectStatus(reading, rows, frozen)).toEqual(priorStatus(reading, rows, frozen))
}

test('indexed selection retains original observation order and duplicate refs rather than lead order or last-value wins', () => {
  const a = value('a'), b = value('b', { states: [{ value: 'true', label: 'B ON' }] }), rows = [alert('raised', 'active-unack'), alert('returned', 'returned-unack')]
  const readings = [observation('plant:other#unselected', true, 'good', 'alarm'), observation(b.ref, true, 'good', 'warning'), observation(a.ref, false, 'bad'), observation(a.ref, true, 'good', 'alarm'), observation(b.ref, false, 'uncertain')]
  compare({ subject, values: [a, b, a], observations: readings }, rows)
  expect(physicalSubjectStatus({ subject, values: [a, b, a], observations: readings }, rows, false)).toMatchObject({ quality: 'bad', word: 'B ON', priority: 'alarm', active: 1, returned: 1 })
  compare({ subject, values: [b, a, b], observations: [...readings].reverse() }, rows)
  compare({ subject, values: [a], observations: [] }); compare({ subject, values: [], observations: readings })
  for (const quality of ['good', 'bad', 'stale', 'uncertain', 'not-applicable'] as const) compare({ subject, values: [a, b], observations: [observation(a.ref, false, quality), observation(b.ref, true, quality)] })
})

test('owner/refusal and alert lifecycle semantics remain unchanged before and after an index is warm', () => {
  const a = value('a'), observations = [observation(a.ref), observation('plant:other#unselected')], reading = { subject, values: [a], observations }
  compare(reading)
  for (const values of [[{ ...a, ref: 'plant:other#a' }], [a, { ...a, ref: 'plant:other#a' }]]) {
    for (const status of [physicalSubjectStatus, priorStatus]) expect(() => status({ ...reading, values }, [], false)).toThrow('Layout readings belong to another operational owner')
  }
  const first = alert('same', 'active-unack'), conflicting = { ...first, state: 'active-ack' as const }
  for (const status of [physicalSubjectStatus, priorStatus]) expect(() => status(reading, [first, conflicting], false)).toThrow('Conflicting lifecycle rows')
  compare(reading, [first, first]); compare(reading, [{ ...first, objectId: objectIdSchema.parse('plant:other'), key: 'plant:other|same' }])
})

test('one immutable sample index avoids rescanning unselected refs and a replacement array gets its own index', () => {
  let irrelevantRefReads = 0
  const a = value('a'), irrelevant = Array.from({ length: 200 }, (_, index) => ({ ...observation(`plant:one#irrelevant-${index}`), get ref() { irrelevantRefReads++; return `plant:one#irrelevant-${index}` } })), observations = [...irrelevant, observation(a.ref)]
  physicalSubjectStatus({ subject, values: [a], observations }, [], false)
  const once = irrelevantRefReads; expect(once).toBe(200)
  for (let index = 0; index < 20; index++) physicalSubjectStatus({ subject, values: [a, a], observations }, [], index % 2 === 0)
  expect(irrelevantRefReads).toBe(once)
  const replaced = [...observations]; physicalSubjectStatus({ subject, values: [a], observations: replaced }, [], false); expect(irrelevantRefReads).toBe(once + 200)
  const unread = [{ ...observation(a.ref), get ref(): string { throw Error('Empty lead must not read any observation ref') } }]
  compare({ subject, values: [], observations: unread })
})

test('varied duplicate/missing/ref order, first state words and worst quality equal the frozen filter', () => {
  let seed = 10727; const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32 }
  const values = Array.from({ length: 12 }, (_, index) => value(`state-${index}`, { states: [{ value: 'true', label: `RUN ${index}` }, { value: 'false', label: `STOP ${index}` }] })), qualities = ['good', 'bad', 'stale', 'uncertain', 'not-applicable'] as const
  for (let example = 0; example < 200; example++) {
    const declared = Array.from({ length: 8 }, () => values[Math.floor(random() * values.length)]!), observations = Array.from({ length: 60 }, () => observation(values[Math.floor(random() * values.length)]!.ref, random() > .5, qualities[Math.floor(random() * qualities.length)]!))
    compare({ subject, values: declared, observations })
  }
})

test('actual acquired R5 subjects retain all live/frozen statuses against the prior filter', async () => {
  const packs = [processPlantPack, physicalLayoutPack], definition = scenarioDefinitionSchema.parse({ id: 'status-index-proof', title: 'Status index proof', packs: [
    { id: 'process-plant', config: {}, items: [{ type: 'plant', id: 'plant:proof', label: 'PWR', location: [11.47, 59.087], model: { ref: 'process-plant.pwr.reference', parameters: { loopCount: 4 } }, operatingPoint: { ref: 'process-plant.pwr.full-power' }, automation: { ref: 'process-plant.pwr.standard' } }] },
    { id: 'physical-layout', config: {}, items: [{ type: 'site-layout', id: 'layout:proof', label: 'Full unit', design: pwrOperatorUnitPhysicalDesignRef, members: { unit: 'plant:proof' }, bearing: 0 }] },
  ], world: { startsAt: '2026-10-27T00:00:00Z' }, view: { map: { center: [11.47, 59.087], zoom: 16 } } })
  const dataDir = await mkdtemp(join(tmpdir(), 'leitbild-status-index-')), workspaceId = newWorkspaceId(), registry = createSimulationRunRegistry({ dataDir, workspaceId, scenarioDefinitions: [definition], compileScenarioDefinition: source => compileScenarioDefinition(source, packs, { routing: createDirectRoutingAdapter() }), scenarioAuthoringCatalog: scenarioAuthoringCatalogFor(packs), scenarioRuntimeResolver: createScenarioRuntimeResolver({ packs }), runtimeAdapters: [createLocalProcessPlantPackRuntimeAdapter()] })
  try {
    const run = await registry.create({ scenarioId: definition.id }); await run.setClock({ paused: true })
    const request = new Request(`http://leitbild.test/api/workspaces/${workspaceId}/world/simulation-runs/${run.id}/displays/layout`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ layoutObjectId: 'layout:proof', expectedRevision: pwrOperatorUnitPhysicalDesignRef.digest }) })
    const response = await handleSimulationRunApi(request, new URL(request.url), { registry, accessContext: accessContextSchema.parse({ workspaceId, requestId: newRequestId(), actor: { kind: 'anonymous' } }), roleHolders: () => ({}) })
    expect(response?.status).toBe(200); const acquired = layoutLiveResponseSchema.parse(await response!.json())
    expect(acquired.subjects.length).toBeGreaterThan(100)
    for (const current of acquired.subjects) compare({ subject: { objectId: acquired.scope.objectId, packId: acquired.scope.packId, elementId: current.elementId, label: current.label }, values: current.values, observations: acquired.sample.observations }, acquired.sample.alerts)
  } finally { await registry.shutdown(); await rm(dataDir, { recursive: true, force: true }) }
})
