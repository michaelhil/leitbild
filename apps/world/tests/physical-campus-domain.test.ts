import { accessContextSchema, newRequestId, newWorkspaceId } from '@leitbild/contracts'
import { describe, expect, spyOn, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import normalOperation from '../src/scenarios/halden-normal-operation.scenario.json'
import { scenarioDefinitionSchema } from '../src/core/scenarios/definition.ts'
import { compileScenarioDefinition } from '../src/core/scenarios/compiler.ts'
import { scenarioAuthoringCatalogFor } from '../src/core/scenarios/authoring.ts'
import { createScenarioRuntimeResolver } from '../src/core/scenarios/runtime-resolver.ts'
import { createSimulationRunRegistry, type SimulationRunRegistry } from '../src/core/simulation-runs/registry.ts'
import type { SimulationRunRuntime } from '../src/core/simulation-runs/runtime.ts'
import { handleSimulationRunApi } from '../src/core/api/simulation-run-routes.ts'
import { actorIdSchema, geoPointFromLonLat, objectIdSchema, type IsoTimestamp, type OperationalObject } from '../src/core/model/index.ts'
import { sideViewOfSnapshot } from '../src/core/simulation-runs/side-view.ts'
import type { SimulationRunStateSnapshot } from '../src/core/simulation-runs/state-store.ts'
import { createDirectRoutingAdapter } from '../src/routing/direct-adapter.ts'
import { processPlantPack as liveProcessPlantPack } from '../src/packs/process-plant/pack.ts'
import { historicalPhysicalProcessPlantPack as processPlantPack } from './fixtures/physical-layout/historical-targets.ts'
import { electricGridPack } from '../src/packs/electric-grid/pack.ts'
import { weatherPack } from '../src/packs/weather/pack.ts'
import { physicalLayoutPack, physicalLayoutScenarioItemSchema } from '../src/packs/physical-layout/pack.ts'
import { campusLayoutDataSchema, draftingLayoutDataSchema, canonicalPhysicalJson } from '../src/packs/physical-layout/model.ts'
import { currentPwrPhysicalDesignRef, pwrFullUnitPhysicalDesignRef, pwrCampusPhysicalDesignRef, pwrShutdownCoolingUnitPhysicalDesignRef, pwrShutdownCoolingCampusPhysicalDesignRef } from '../src/packs/physical-layout/design.ts'
import { describePhysicalLayoutScene, loadPhysicalLayoutScene } from '../src/packs/physical-layout/scene.ts'
import { createLocalProcessPlantPackRuntimeAdapter } from '../src/packs/process-plant/sim/adapter.ts'
import { createLocalElectricGridPackRuntimeAdapter } from '../src/packs/electric-grid/sim/adapter.ts'
import { createLocalWeatherPackRuntimeAdapter } from '../src/packs/weather/sim/adapter.ts'
import { layoutLiveResponseSchema } from '../src/ui/physical-layout/read-model.ts'
import { physicalLayoutStatusSummary } from '../src/ui/physical-layout/status.ts'
import { subjectOf } from '../src/features/displays/alerts/rows.ts'

const packs = [processPlantPack, electricGridPack, weatherPack, physicalLayoutPack]
// These regressions deliberately retain the r1 compiler/source/profile. Current
// bundled r2 admission and scopes have their own explorer suite.
const source = () => {
  const value = scenarioDefinitionSchema.parse(normalOperation)
  for (const item of value.packs.find(pack => pack.id === 'physical-layout')!.items) {
    item.design = item.id === 'layout:halden-campus' ? pwrCampusPhysicalDesignRef : pwrFullUnitPhysicalDesignRef
    delete item.group
  }
  return value
}
const compile = (value: unknown) => compileScenarioDefinition(value, packs, { routing: createDirectRoutingAdapter() })
const objectFor = (objects: ReadonlyArray<OperationalObject>, id: string): OperationalObject => objects.find(object => object.id === id) ?? (() => { throw new Error(`Missing test object ${id}`) })()
const withRun = async (work: (registry: SimulationRunRegistry, run: SimulationRunRuntime) => Promise<void>) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'leitbild-campus-api-'))
  const livePacks = [liveProcessPlantPack, electricGridPack, weatherPack, physicalLayoutPack]
  const registry = createSimulationRunRegistry({ dataDir, workspaceId: newWorkspaceId(), scenarioDefinitions: [scenarioDefinitionSchema.parse(normalOperation)], compileScenarioDefinition: value => compileScenarioDefinition(value, livePacks, { routing: createDirectRoutingAdapter() }),
    scenarioAuthoringCatalog: scenarioAuthoringCatalogFor(livePacks), scenarioRuntimeResolver: createScenarioRuntimeResolver({ packs: livePacks }),
    runtimeAdapters: [createLocalProcessPlantPackRuntimeAdapter(), createLocalElectricGridPackRuntimeAdapter(), createLocalWeatherPackRuntimeAdapter()] })
  try { const run = await registry.create({ scenarioId: 'halden-normal-operation' }); await run.setClock({ paused: true }); await work(registry, run) }
  finally { await registry.shutdown(); await rm(dataDir, { recursive: true, force: true }) }
}
const read = async (registry: SimulationRunRegistry, run: SimulationRunRuntime, layoutObjectId: string, expectedRevision: string) => {
  const request = new Request(`http://leitbild.test/api/workspaces/${registry.workspaceId}/world/simulation-runs/${run.id}/displays/layout`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ layoutObjectId, expectedRevision }) })
  const response = await handleSimulationRunApi(request, new URL(request.url), { registry, accessContext: accessContextSchema.parse({ workspaceId: registry.workspaceId, requestId: newRequestId(), actor: { kind: 'anonymous' } }), roleHolders: () => ({}) })
  if (!response) throw new Error('Layout route was not handled')
  return { status: response.status, body: await response.json() as unknown }
}

describe('Full PWR and shared campus admission', () => {
  test('the retained r1 Scenario carries four reusable full units and one geographically separate shared site', async () => {
    const compiled = await compile(source())
    expect(compiled.initialObjects.filter(object => object.packId === 'physical-layout')).toHaveLength(5)
    for (const unit of [1, 2, 3, 4]) {
      const layout = objectFor(compiled.initialObjects, `layout:halden-${unit}`), data = campusLayoutDataSchema.parse(layout.packData)
      expect(data.design).toEqual(pwrFullUnitPhysicalDesignRef)
      expect(data.coverage.totalSubjects).toBe(121)
      for (const id of ['core', 'turbine', 'condenser']) expect(data.coverage.representedSubjectIds).toContain(id)
      for (const id of ['atmosphere', 'offsiteGrid']) expect(data.coverage.unplacedSubjectIds).toContain(id)
      expect(data.coverage.representedSubjectIds).toHaveLength(108)
      expect(data.coverage.unplacedSubjectIds).toHaveLength(13)
      expect(data.coverageEvidence.dispositions).toHaveLength(121)
      expect(data.coverageEvidence.dispositions.find(entry => entry.subjectId === 'core')?.disposition).toBe('housed')
      expect(data.bindings.find(binding => binding.elementId === 'core')).toMatchObject({ relation: 'houses' })
      expect(data.source.levels.map(level => level.elevation)).toEqual([0, 8, 15, 22])
      expect(describePhysicalLayoutScene(layout, compiled.initialObjects)?.overviewFootprints!.length).toBeGreaterThanOrEqual(6)
    }
    const campus = objectFor(compiled.initialObjects, 'layout:halden-campus'), data = campusLayoutDataSchema.parse(campus.packData)
    expect(data.design).toEqual(pwrCampusPhysicalDesignRef)
    expect(data.owner).toMatchObject({ objectId: 'grid:halden-four-unit', packId: 'electric-grid', modelRef: 'electric-grid.halden.four-unit' })
    expect(data.placement.anchor).toEqual([11.48, 59.08])
    expect(data.relatedMembers).toHaveLength(4)
    expect(data.coverage.representedSubjectIds).toHaveLength(11)
    expect(data.coverage.totalSubjects).toBe(6405)
    expect(data.source.elements.some(element => element.id === 'building/administration')).toBe(true)
    expect(data.source.elements.filter(element => element.kind === 'conductor' && element.terminatesBeyond).length).toBe(18)
    expect(new Set(data.source.elements.filter(element => element.kind === 'conductor' && element.terminatesBeyond).flatMap(element => element.supportIds ?? [])).size).toBe(4)
    expect(data.bindings.some(binding => binding.physicalElementId.startsWith('building/administration'))).toBe(false)
    expect(describePhysicalLayoutScene(campus, compiled.initialObjects)?.overviewFootprints).toHaveLength(5)
  })

  test('missing roles, relocated owners and mismatched graph geography are refused before admission', async () => {
    const missing = source(), item = missing.packs.find(pack => pack.id === 'physical-layout')!.items.find(item => item.id === 'layout:halden-campus')!
    item.members = {}
    await expect(compile(missing)).rejects.toThrow('exact Design roles')
    const movedUnit = source()
    movedUnit.packs.find(pack => pack.id === 'process-plant')!.items[1]!.location = [11.478, 59.085]
    await expect(compile(movedUnit)).rejects.toThrow('member geography mismatch')
    const movedGrid = source()
    movedGrid.packs.find(pack => pack.id === 'electric-grid')!.items[0]!.location = [11.49, 59.08]
    await expect(compile(movedGrid)).rejects.toThrow('site geography differs')
    const provider = electricGridPack.physicalTargets!
    const badGraph = { ...electricGridPack, physicalTargets: async (object: OperationalObject) => {
      const targets = await provider(object)
      return { ...targets, subjects: targets.subjects.map(subject => subject.id === 'bus:curated-halden-pwr-switchyard@420' ? { ...subject, location: [12, 60] as const } : subject) }
    } }
    await expect(compileScenarioDefinition(source(), [processPlantPack, badGraph, weatherPack, physicalLayoutPack], { routing: createDirectRoutingAdapter() })).rejects.toThrow('site geography differs')
  })

  test('physical unit feeders require the actual role-qualified Scenario endpoint pairs', async () => {
    const swapped = source()
    const first = swapped.connections[0]!, second = swapped.connections[1]!
    const port = first.network.portId
    first.network.portId = second.network.portId; second.network.portId = port
    await expect(compile(swapped)).rejects.toThrow('Physical layout connection mismatch')
    const missing = source()
    missing.connections.splice(0, 1)
    await expect(compile(missing)).rejects.toThrow('Physical layout connection mismatch')
  })

  test('shared routing requires exactly one unit physical Design with its admitted bearing and anchor', async () => {
    const rotated = source()
    rotated.packs.find(pack => pack.id === 'physical-layout')!.items.find(item => item.id === 'layout:halden-1')!.bearing = 90
    await expect(compile(rotated)).rejects.toThrow('Physical layout dependency mismatch')
    const replaced = source()
    replaced.packs.find(pack => pack.id === 'physical-layout')!.items.find(item => item.id === 'layout:halden-1')!.design = currentPwrPhysicalDesignRef
    await expect(compile(replaced)).rejects.toThrow('Physical layout dependency mismatch')
    const removed = source()
    const selected = removed.packs.find(pack => pack.id === 'physical-layout')!
    selected.items = selected.items.filter(item => item.id !== 'layout:halden-1')
    await expect(compile(removed)).rejects.toThrow('Physical layout dependency mismatch')
    const duplicated = source()
    const items = duplicated.packs.find(pack => pack.id === 'physical-layout')!.items
    items.push({ ...structuredClone(items.find(item => item.id === 'layout:halden-1')!), id: objectIdSchema.parse('layout:duplicate-unit-1') })
    await expect(compile(duplicated)).rejects.toThrow('Physical layout dependency mismatch')
    const shifted = source()
    shifted.packs.find(pack => pack.id === 'process-plant')!.items[0]!.location = [11.470001, 59.087]
    await expect(compile(shifted)).rejects.toThrow('Physical layout dependency mismatch')
  })

  test('related member movement or disappearance invalidates the shared attachment without moving any source', async () => {
    const compiled = await compile(source()), campus = objectFor(compiled.initialObjects, 'layout:halden-campus')
    const before = canonicalPhysicalJson(campus.packData)
    expect(describePhysicalLayoutScene(campus, compiled.initialObjects)?.locationValid).toBe(true)
    const moved = compiled.initialObjects.map(object => object.id !== 'plant:halden-2' ? object : { ...object, spatial: { ...object.spatial, position: { ...object.spatial.position!, point: geoPointFromLonLat(11.478, 59.085) } } })
    expect(describePhysicalLayoutScene(campus, moved)?.locationValid).toBe(false)
    expect(describePhysicalLayoutScene(campus, compiled.initialObjects.filter(object => object.id !== 'plant:halden-2'))?.locationValid).toBe(false)
    const rotated = compiled.initialObjects.map(object => object.id !== 'layout:halden-1' ? object : { ...object, packData: { ...campusLayoutDataSchema.parse(object.packData), placement: { anchor: [11.47, 59.087], bearing: 90 } } })
    expect(describePhysicalLayoutScene(campus, rotated)?.locationValid).toBe(false)
    expect(describePhysicalLayoutScene(campus, compiled.initialObjects.filter(object => object.id !== 'layout:halden-1'))?.locationValid).toBe(false)
    expect(canonicalPhysicalJson(campus.packData)).toBe(before)
  })

  test('shared source inherits the intersection of all members audiences and rejects disjoint pictures', async () => {
    const compiled = await compile(source())
    const objects = compiled.initialObjects.map(object => object.packId !== 'process-plant' ? object : { ...object, audience: ['blue'] })
    const item = physicalLayoutScenarioItemSchema.parse({ ...source().packs.find(pack => pack.id === 'physical-layout')!.items.find(item => item.id === 'layout:halden-campus'), pack: 'physical-layout' })
    const expand = (picture: ReadonlyArray<OperationalObject>) => physicalLayoutPack.scenario!.expandItem(item, {
      at: objects[0]!.timestamps.createdAt, objects: picture, objectById: id => picture.find(object => object.id === id), routing: createDirectRoutingAdapter(), packConfigs: {}, sides: [],
      physicalTargetsFor: async id => { const object = objectFor(picture, id); return await packs.find(pack => pack.descriptor.id === object.packId)!.physicalTargets!(object) },
    })
    const expanded = await expand(objects), layout = expanded.objects[0]!
    expect(layout.audience).toEqual(['blue'])
    const snapshot = { seq: 0, objects: [...objects.filter(object => object.id !== layout.id), layout] } as SimulationRunStateSnapshot
    expect(sideViewOfSnapshot(snapshot, ['red']).objects.some(object => object.id === layout.id)).toBe(false)
    expect(sideViewOfSnapshot(snapshot, ['blue']).objects.some(object => object.id === layout.id)).toBe(true)
    await expect(expand(objects.map(object => object.id !== 'plant:halden-2' ? object : { ...object, audience: ['red'] }))).rejects.toThrow('no shared audience')
  })
})

describe('Real full-plant and shared-yard acquisition', () => {
  test('a changed physical layout dependency is refused before owner observations', async () => withRun(async (registry, run) => {
    const originalSnapshot = run.snapshot.bind(run), originalObservations = run.observations.bind(run)
    const snapshotSpy = spyOn(run, 'snapshot').mockImplementation(() => { const snapshot = originalSnapshot(); return { ...snapshot, objects: snapshot.objects.map(object => {
      if (object.id !== 'layout:halden-1') return object
      const data = draftingLayoutDataSchema.parse(object.packData)
      return { ...object, packData: { ...data, placement: { ...data.placement, bearing: 90 } } }
    }) } })
    let reads = 0
    const observationSpy = spyOn(run, 'observations').mockImplementation(actor => { const port = originalObservations(actor); return { ...port, read: async input => { reads++; return port.read(input) } } })
    try {
      const result = await read(registry, run, 'layout:halden-campus', pwrShutdownCoolingCampusPhysicalDesignRef.digest)
      expect(result.status).toBe(409)
      expect(result.body).toMatchObject({ error: { code: 'layout_location_mismatch' } })
      expect(reads).toBe(0)
    } finally { observationSpy.mockRestore(); snapshotSpy.mockRestore() }
  }), 30_000)

  test('restore retains canonical topology and layout pins, while a mismatched loaded connection picture is refused before observation', async () => withRun(async (registry, run) => {
    const before = registry.loadedCompiledScenario(run.id).connections
    const sourceBefore = canonicalPhysicalJson(objectFor(run.snapshot().objects, 'layout:halden-campus').packData)
    await registry.close(run.id)
    const restored = await registry.load(run.id)
    await restored.setClock({ paused: true })
    expect(registry.loadedCompiledScenario(restored.id).connections).toEqual(before)
    expect(canonicalPhysicalJson(objectFor(restored.snapshot().objects, 'layout:halden-campus').packData)).toBe(sourceBefore)
    expect((await read(registry, restored, 'layout:halden-campus', pwrShutdownCoolingCampusPhysicalDesignRef.digest)).status).toBe(200)
    const originalScenario = registry.loadedCompiledScenario.bind(registry)
    const changed = before.map((connection, index) => ({ ...connection, network: { ...connection.network,
      portId: index === 0 ? before[1]!.network.portId : index === 1 ? before[0]!.network.portId : connection.network.portId } }))
    const scenarioSpy = spyOn(registry, 'loadedCompiledScenario').mockImplementation(id => ({ ...originalScenario(id), connections: changed }))
    const originalObservations = restored.observations.bind(restored)
    let reads = 0
    const observationSpy = spyOn(restored, 'observations').mockImplementation(actor => { const port = originalObservations(actor); return { ...port, read: async input => { reads++; return port.read(input) } } })
    try {
      const result = await read(registry, restored, 'layout:halden-campus', pwrShutdownCoolingCampusPhysicalDesignRef.digest)
      expect(result.status).toBe(409)
      expect(result.body).toMatchObject({ error: { code: 'layout_connection_mismatch' } })
      expect(reads).toBe(0)
    } finally { observationSpy.mockRestore(); scenarioSpy.mockRestore() }
  }), 30_000)

  test('full unit and Grid bindings read complete bounded owner samples, and internal core alarms locate at their housing', async () => withRun(async (registry, run) => {
    const elapsed: number[] = []
    const retainedSubjects = draftingLayoutDataSchema.parse(objectFor(run.snapshot().objects, 'layout:halden-1').packData).coverage.representedSubjectIds
    let sample = layoutLiveResponseSchema.parse((await read(registry, run, 'layout:halden-1', pwrShutdownCoolingUnitPhysicalDesignRef.digest)).body)
    for (let index = 0; index < 3; index++) {
      const started = performance.now(), response = await read(registry, run, 'layout:halden-1', pwrShutdownCoolingUnitPhysicalDesignRef.digest)
      elapsed.push(performance.now() - started)
      expect(response.status).toBe(200); sample = layoutLiveResponseSchema.parse(response.body)
      expect(new Set(sample.subjects.map(subject => subject.elementId))).toEqual(new Set(retainedSubjects))
      const acquired = new Set(sample.sample.observations.map(observation => observation.ref))
      expect(sample.subjects.every(subject => subject.values.length <= 8 && subject.values.every(value => acquired.has(value.ref)))).toBe(true)
    }
    console.log(`Full PWR owner layout acquisition, warm local milliseconds: ${elapsed.map(value => value.toFixed(1)).join(', ')}; ${sample.sample.observations.length} acquired observations`)
    const yard = await read(registry, run, 'layout:halden-campus', pwrShutdownCoolingCampusPhysicalDesignRef.digest)
    expect(yard.status).toBe(200)
    const grid = layoutLiveResponseSchema.parse(yard.body)
    expect(grid.subjects).toHaveLength(11)
    expect(grid.scope).toMatchObject({ objectId: 'grid:halden-four-unit', packId: 'electric-grid' })
    expect(grid.subjects.some(subject => subject.elementId === 'branch:curated-halden-pwr-hasle-1' && subject.values.length > 0)).toBe(true)

    const actor = { id: actorIdSchema.parse('actor:campus-proof'), label: 'Campus proof', role: 'operator' as const }
    const command = await run.invokeCapability(actor, { capabilityId: 'world.process-plant.action.invoke', input: { plantId: 'plant:halden-1', actionId: 'turbine-trip', parameters: {} } })
    expect(command.kind).toBe('command')
    const target = new Date(Date.parse(run.snapshot().clock!.currentTime) + 2_000).toISOString() as IsoTimestamp
    await run.runMaximumPace(target, { shouldStop: () => false, onProgress: () => undefined }); await run.setClock({ paused: true })
    const after = layoutLiveResponseSchema.parse((await read(registry, run, 'layout:halden-1', pwrShutdownCoolingUnitPhysicalDesignRef.digest)).body)
    const coreAlerts = after.sample.alerts.filter(row => subjectOf(row) === 'core')
    expect(coreAlerts.length).toBeGreaterThan(0)
    const layout = objectFor(run.snapshot().objects, 'layout:halden-1'), scene = await loadPhysicalLayoutScene(layout)
    const summary = physicalLayoutStatusSummary({ owners: [{ packId: 'process-plant', objectId: 'plant:halden-1' }], alerts: coreAlerts,
      occurrences: scene.objects.map(object => ({ id: object.id, disposition: 'installed', subjects: object.subjectIds.map(elementId => ({ packId: 'process-plant', objectId: 'plant:halden-1', elementId, label: elementId })) })), visibleOccurrenceIds: new Set(scene.objects.map(object => object.id)) })
    expect(summary.unlocatedAlerts).toBe(0)
    expect(summary.affectedLocations).toBe(1)
    expect(scene.objects.find(object => object.subjectIds.includes('core'))?.id).toBe('equipment/vessel')
  }), 30_000)

  test('a changed related owner model is refused before the shared Grid owner is observed', async () => withRun(async (registry, run) => {
    const realPacks = run.packs(), provider = liveProcessPlantPack.physicalTargets!
    const packSpy = spyOn(run, 'packs').mockImplementation(() => realPacks.map(pack => pack.descriptor.id !== 'process-plant' ? pack : { ...pack, physicalTargets: async (object: OperationalObject) => ({ ...await provider(object), modelDigest: '0'.repeat(64) }) }))
    const original = run.observations.bind(run)
    let reads = 0
    const observations = spyOn(run, 'observations').mockImplementation(actor => { const port = original(actor); return { ...port, read: async input => { reads++; return port.read(input) } } })
    try {
      const result = await read(registry, run, 'layout:halden-campus', pwrShutdownCoolingCampusPhysicalDesignRef.digest)
      expect(result.status).toBe(409)
      expect(result.body).toMatchObject({ error: { code: 'layout_member_mismatch' } })
      expect(reads).toBe(0)
    } finally { observations.mockRestore(); packSpy.mockRestore() }
  }), 30_000)
})
