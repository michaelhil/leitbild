import { accessContextSchema, newRequestId, newWorkspaceId } from '@leitbild/contracts'
import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { scenarioDefinitionSchema } from '../src/core/scenarios/definition.ts'
import { compileScenarioDefinition } from '../src/core/scenarios/compiler.ts'
import { scenarioAuthoringCatalogFor } from '../src/core/scenarios/authoring.ts'
import { createScenarioRuntimeResolver } from '../src/core/scenarios/runtime-resolver.ts'
import { createSimulationRunRegistry } from '../src/core/simulation-runs/registry.ts'
import { handleSimulationRunApi } from '../src/core/api/simulation-run-routes.ts'
import { geoPointFromLonLat, objectIdSchema, type OperationalObject } from '../src/core/model/index.ts'
import { physicalLayoutPack } from '../src/packs/physical-layout/pack.ts'
import { pwrShutdownCoolingUnitPhysicalDesignRef, resolvePhysicalDesign } from '../src/packs/physical-layout/design.ts'
import { canonicalPhysicalJson, physicalLayoutDataSchema } from '../src/packs/physical-layout/model.ts'
import { describePhysicalLayoutScene, loadPhysicalLayoutScene } from '../src/packs/physical-layout/scene.ts'
import { physicalSourceSchema } from '../src/packs/physical-layout/native/drafting/source.ts'
import { processPlantPack } from '../src/packs/process-plant/pack.ts'
import { describeProcessPlantPhysicalTargets } from '../src/packs/process-plant/physical-targets.ts'
import { createLocalProcessPlantPackRuntimeAdapter } from '../src/packs/process-plant/sim/adapter.ts'
import { createDirectRoutingAdapter } from '../src/routing/direct-adapter.ts'
import { draftingPhysicalCompilerFiles, draftingPhysicalCompilerRef } from '../src/packs/physical-layout/compiler-identity.ts'
import { sideViewOfSnapshot } from '../src/core/simulation-runs/side-view.ts'
import type { SimulationRunStateSnapshot } from '../src/core/simulation-runs/state-store.ts'

const packs = [physicalLayoutPack, processPlantPack]
const ownerItem = (id: string, location = [11.47, 59.087]) => ({ type: 'plant', id, label: 'Same unit label', location, model: { ref: 'process-plant.pwr.reference', parameters: { loopCount: 4 } }, operatingPoint: { ref: 'process-plant.pwr.full-power' }, automation: { ref: 'process-plant.pwr.standard' } })
const layoutItem = (id: string, owner: string) => ({ type: 'site-layout', id, label: 'Current unit layout', members: { unit: owner }, design: pwrShutdownCoolingUnitPhysicalDesignRef, bearing: 0 })
const source = () => scenarioDefinitionSchema.parse({
  id: 'physical-layout-test', title: 'Physical layout test',
  packs: [
    { id: 'physical-layout', config: {}, items: [layoutItem('layout:a', 'plant:a'), layoutItem('layout:b', 'plant:b')] },
    { id: 'process-plant', config: {}, items: [ownerItem('plant:a'), ownerItem('plant:b', [11.477, 59.085])] },
  ],
  world: { startsAt: '2026-10-24T00:00:00.000Z', environment: {} },
  view: { map: { center: [11.47, 59.087], zoom: 16 } },
})
const compile = (value: unknown) => compileScenarioDefinition(value, packs, { routing: createDirectRoutingAdapter() })
const find = (objects: ReadonlyArray<OperationalObject>, id: string): OperationalObject => {
  const object = objects.find(object => object.id === id)
  if (!object) throw new Error(`Missing test object: ${id}`)
  return object
}

describe('Physical layout admission and retained scene', () => {
  test('retained physical source inherits its owner audience before any side-view delivery', async () => {
    const compiled = await compile(source())
    const originalOwner = find(compiled.initialObjects, 'plant:a')
    const owner = { ...originalOwner, audience: ['blue'] }
    const expanded = await physicalLayoutPack.scenario!.expandItem({ ...layoutItem('layout:audience', owner.id), pack: 'physical-layout' }, {
      at: originalOwner.timestamps.createdAt, objects: [owner], objectById: id => id === owner.id ? owner : undefined,
      routing: createDirectRoutingAdapter(), packConfigs: {}, sides: [{ id: 'blue', label: 'Blue', colour: 'blue' }, { id: 'red', label: 'Red', colour: 'red' }],
      physicalTargetsFor: () => describeProcessPlantPhysicalTargets(owner),
    })
    const layout = expanded.objects[0]!
    expect(layout.audience).toEqual(owner.audience)
    const snapshot = { seq: 0, objects: [owner, layout] } as SimulationRunStateSnapshot
    expect(sideViewOfSnapshot(snapshot, ['red']).objects).toEqual([])
    expect(sideViewOfSnapshot(snapshot, ['blue']).objects.map(object => object.id)).toEqual([owner.id, layout.id])
    expect(sideViewOfSnapshot(snapshot, ['blue']).objects[1]!.packData).toEqual(layout.packData)
    expect(JSON.stringify(sideViewOfSnapshot(snapshot, ['red']))).not.toContain('pwr-full-unit')
  })
  test('pins the exact installed geometry compiler and rejects incompatible retained inputs', async () => {
    const hash = createHash('sha256')
    for (const name of draftingPhysicalCompilerFiles) {
      hash.update(name).update('\0').update(new Uint8Array(await Bun.file(new URL(`../src/packs/physical-layout/native/${name}`, import.meta.url)).arrayBuffer()))
    }
    expect(hash.digest('hex')).toBe(draftingPhysicalCompilerRef.digest)
    const compiled = await compile(source()), object = find(compiled.initialObjects, 'layout:a')
    const data = physicalLayoutDataSchema.parse(object.packData)
    expect(data.compiler).toEqual(draftingPhysicalCompilerRef)
    const incompatible = { ...object, packData: { ...data, compiler: { id: draftingPhysicalCompilerRef.id, digest: '0'.repeat(64) } } }
    await expect(loadPhysicalLayoutScene(incompatible)).rejects.toThrow()
  })
  test('compiles owner dependencies first and qualifies identical design identities by owner', async () => {
    const compiled = await compile(source())
    const a = find(compiled.initialObjects, 'layout:a'), b = find(compiled.initialObjects, 'layout:b')
    const da = describePhysicalLayoutScene(a, compiled.initialObjects)!, db = describePhysicalLayoutScene(b, compiled.initialObjects)!
    expect(da.locationValid).toBe(true)
    expect(da.id).not.toBe(db.id)
    expect(da.targetObjectId).toBe('plant:a')
    expect(db.targetObjectId).toBe('plant:b')
    expect(da.anchor).not.toEqual(db.anchor)
    expect(da.revision).toBe(db.revision)
    expect(da.subjectIds).toContain('condenser')
    expect(da.levels.map(level => level.elevation)).toEqual([0, 8, 15, 22])
    expect(physicalLayoutPack.runtime).toBeUndefined()
    const owner = describeProcessPlantPhysicalTargets(find(compiled.initialObjects, 'plant:a'))
    const data = physicalLayoutDataSchema.parse(a.packData)
    expect(data.owner.modelDigest).toBe(owner.modelDigest)
    expect(data.coverageEvidence.dispositions).toHaveLength(data.coverage.totalSubjects)
  })

  test('refuses stale design pins, changed owner model and missing correspondence', async () => {
    const stale = source()
    const item = stale.packs[0]!.items[0]!
    item.design = { ...pwrShutdownCoolingUnitPhysicalDesignRef, digest: '0'.repeat(64) }
    await expect(compile(stale)).rejects.toThrow('mismatched physical Design Revision')
    const changed = source()
    changed.packs[1]!.items[0]!.model = { ref: 'process-plant.pwr.reference', parameters: { loopCount: 3 } }
    await expect(compile(changed)).rejects.toThrow('owner model mismatch')
    const missingTarget = { ...processPlantPack, physicalTargets: (object: OperationalObject) => ({ ...describeProcessPlantPhysicalTargets(object), subjects: [] }) }
    await expect(compileScenarioDefinition(source(), [physicalLayoutPack, missingTarget], { routing: createDirectRoutingAdapter() })).rejects.toThrow('unknown owner subject')
  })

  test('source-only scene retains shaped machinery, actual wall openings, plan lines and palette roles', async () => {
    const compiled = await compile(source())
    const object = find(compiled.initialObjects, 'layout:a'), scene = await loadPhysicalLayoutScene(object)
    expect(scene.objects.length).toBeGreaterThan(800)
    expect(scene.objects.some(object => object.subjectIds.includes('mainFeedwaterPumpA'))).toBe(true)
    expect(scene.planDrawing?.views.map(view => view.levelId)).toEqual(scene.levels.map(level => level.id))
    const data = physicalLayoutDataSchema.parse(object.packData)
    expect(physicalSourceSchema.safeParse({ ...data.source, arbitraryCode: 'rejected' }).success).toBe(false)
    const damaged = structuredClone(object), damagedData = physicalLayoutDataSchema.parse(damaged.packData)
    damagedData.source.elements[0]!.pose.position[0] += 100
    await expect(loadPhysicalLayoutScene({ ...damaged, packData: damagedData })).rejects.toThrow('digest mismatch')
  })

  test('placement mismatch invalidates detail without moving the owner or source', async () => {
    const compiled = await compile(source()), layout = find(compiled.initialObjects, 'layout:a')
    const before = canonicalPhysicalJson(layout.packData)
    const moved = compiled.initialObjects.map(object => object.id !== 'plant:a' ? object : { ...object, spatial: { ...object.spatial, position: { ...object.spatial.position!, point: geoPointFromLonLat(11.48, 59.087) } } })
    const descriptor = describePhysicalLayoutScene(layout, moved)!
    expect(descriptor.locationValid).toBe(false)
    expect(descriptor.reason).toContain('Location mismatch')
    expect(describePhysicalLayoutScene(layout, compiled.initialObjects)!.locationValid).toBe(true)
    expect(canonicalPhysicalJson(layout.packData)).toBe(before)
    const retained = await resolvePhysicalDesign(pwrShutdownCoolingUnitPhysicalDesignRef)
    retained.source.elements[0]!.pose.position[0] += 10
    expect((await resolvePhysicalDesign(pwrShutdownCoolingUnitPhysicalDesignRef)).source).not.toEqual(retained.source)
  })

  test('real Run restore and newer Scenario publication retain exact admitted source and binding', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'leitbild-physical-layout-'))
    const workspaceId = newWorkspaceId(), definition = source()
    const config = { dataDir, workspaceId, scenarioDefinitions: [definition], compileScenarioDefinition: compile, scenarioAuthoringCatalog: scenarioAuthoringCatalogFor(packs), scenarioRuntimeResolver: createScenarioRuntimeResolver({ packs }), runtimeAdapters: [createLocalProcessPlantPackRuntimeAdapter()] }
    const registry = createSimulationRunRegistry(config)
    try {
      const run = await registry.create({ scenarioId: definition.id })
      await run.setClock({ paused: true })
      const first = find(run.snapshot().objects, 'layout:a'), firstText = canonicalPhysicalJson(first.packData)
      const revision = await registry.currentScenario(definition.id)
      if (!revision) throw new Error('Missing test Scenario revision')
      const replacement = source()
      replacement.packs[0]!.items[0]!.bearing = 30
      await registry.updateScenario(replacement, revision.id)
      expect(canonicalPhysicalJson(find(run.snapshot().objects, 'layout:a').packData)).toBe(firstText)
      await registry.close(run.id)
      const restored = await registry.load(run.id)
      const after = find(restored.snapshot().objects, 'layout:a')
      expect(canonicalPhysicalJson(after.packData)).toBe(firstText)
      const scene = await loadPhysicalLayoutScene(after)
      expect(scene.revision).toBe(pwrShutdownCoolingUnitPhysicalDesignRef.digest)
      expect(scene.targetObjectId).toBe(objectIdSchema.parse('plant:a'))
      expect(scene.bearing).toBe(0)
    } finally {
      await registry.shutdown()
      await rm(dataDir, { recursive: true, force: true })
    }
  })

  test('a stored retired layout refuses Run admission and Reset before deletion is needed', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'leitbild-retired-layout-'))
    const workspaceId = newWorkspaceId(), definition = source()
    const { validateRetainedObjects: _currentAdmission, ...historicalPack } = physicalLayoutPack
    const oldPacks = [historicalPack, processPlantPack]
    const config = { dataDir, workspaceId, scenarioDefinitions: [definition], runtimeAdapters: [createLocalProcessPlantPackRuntimeAdapter()] }
    const historicalRegistry = createSimulationRunRegistry({ ...config, scenarioAuthoringCatalog: scenarioAuthoringCatalogFor(oldPacks),
      scenarioRuntimeResolver: createScenarioRuntimeResolver({ packs: oldPacks }), compileScenarioDefinition: async value => {
        const compiled = await compile(value)
        return { ...compiled, initialObjects: compiled.initialObjects.map(object => {
          if (object.id !== 'layout:a') return object
          const data = physicalLayoutDataSchema.parse(object.packData)
          return { ...object, packData: { ...data, design: { ...data.design, revision: 'pwr-full-unit-20261030-r9' } } }
        }) }
      },
    })
    const registry = createSimulationRunRegistry({ ...config, scenarioAuthoringCatalog: scenarioAuthoringCatalogFor(packs),
      scenarioRuntimeResolver: createScenarioRuntimeResolver({ packs }), compileScenarioDefinition: compile,
    })
    try {
      const run = await historicalRegistry.create({ scenarioId: definition.id })
      await historicalRegistry.close(run.id)
      await historicalRegistry.shutdown()
      const request = async (method: string, suffix = '') => {
        const req = new Request(`http://leitbild.test/api/workspaces/${workspaceId}/world/simulation-runs/${run.id}${suffix}`, { method })
        const accessContext = accessContextSchema.parse({ workspaceId, requestId: newRequestId(), actor: { kind: 'anonymous' } })
        return (await handleSimulationRunApi(req, new URL(req.url), { registry, accessContext, roleHolders: () => ({}) }))!
      }
      const before = await registry.summary(run.id)
      for (const response of [await request('GET'), await request('POST', '/reset')]) {
        expect(response.status).toBe(409)
        expect(await response.json()).toMatchObject({ error: { code: 'simulation_run_failed', message: expect.stringContaining('Start a fresh Run from a current Physical Design') } })
      }
      expect(registry.get(run.id)).toBeUndefined()
      expect(await registry.summary(run.id)).toEqual(before)
      expect((await request('DELETE')).status).toBe(200)
      expect((await request('GET')).status).toBe(404)
    } finally {
      await historicalRegistry.shutdown()
      await registry.shutdown()
      await rm(dataDir, { recursive: true, force: true })
    }
  })
})
