import { describe, expect, test } from 'bun:test'
import type { ActorId, CommandEnvelope, CommandId, IsoTimestamp, ObjectId, SimulationRunId } from '../src/core/model/index.ts'
import { nowIso } from '../src/core/model/index.ts'
import { createScenarioCatalog } from '../src/core/scenarios/catalog.ts'
import {
  gridDerateBranchCommandKind,
  gridDispatchGeneratorCommandKind,
  gridReturnGeneratorToServiceCommandKind,
  gridSetGeneratorAvailabilityCommandKind,
  gridTripGeneratorCommandKind,
} from '../src/packs/electric-grid/commands.ts'
import { gridDefinitionSchema } from '../src/packs/electric-grid/config.ts'
import { compileGridDefinition, compileGridModelIndex } from '../src/packs/electric-grid/definitions.ts'
import { electricGridPackDataSchema } from '../src/packs/electric-grid/model.ts'
import { electricGridPack } from '../src/packs/electric-grid/pack.ts'
import { createGridRuntimeInstance } from '../src/packs/electric-grid/runtime/instance.ts'
import { advanceGrid } from '../src/packs/electric-grid/runtime/solver.ts'
import { createLocalElectricGridPackRuntimeAdapter } from '../src/packs/electric-grid/sim/adapter.ts'
import { electricGridRuntimeId } from '../src/packs/electric-grid/sim/constants.ts'
import { weatherPack } from '../src/packs/weather/pack.ts'
import { scenarios } from '../src/scenarios/index.ts'
import type { PackRuntimeConnection, PackRuntimeEvent, PackRuntimeStateStore } from '../src/simulation/protocol.ts'

const simulationRunId = 'run-electric-grid-test' as SimulationRunId
const actorId = 'actor:electric-grid-test' as ActorId

const command = (config: {
  readonly kind: string
  readonly gridId: string
  readonly payload: unknown
}): CommandEnvelope => ({
  id: `command:${crypto.randomUUID()}` as CommandId,
  simulationRunId,
  actorId,
  kind: config.kind,
  targetObjectIds: [config.gridId as ObjectId],
  payload: config.payload,
  issuedAt: nowIso(),
})

const gridScenario = () => {
  const scenario = scenarios.find(candidate => candidate.id === 'norway-electric-grid')
  if (!scenario) throw new Error('missing built-in norway-electric-grid scenario')
  return scenario
}

const connect = async (runtimeStateStore?: PackRuntimeStateStore): Promise<PackRuntimeConnection> => {
  const scenario = gridScenario()
  return await createLocalElectricGridPackRuntimeAdapter().connect({
    simulationRunId,
    ...(runtimeStateStore === undefined ? {} : { runtimeStateStore }),
    scenario: {
      scenarioId: scenario.id,
      runtimeIds: [electricGridRuntimeId],
      world: scenario.world,
      initialObjects: scenario.initialObjects,
      runtimeConfigByRuntimeId: {},
      runtimeConfig: {},
    },
  })
}

const okResult = (response: Awaited<ReturnType<PackRuntimeConnection['query']>>): Record<string, unknown> => {
  if (!response.ok) throw new Error(response.reason)
  if (typeof response.result !== 'object' || response.result === null || Array.isArray(response.result)) throw new Error('malformed query result')
  return response.result as Record<string, unknown>
}

describe('electric grid Pack', () => {
  test('compiles a Scenario to one Grid object with discoverable selections', () => {
    const scenario = gridScenario()
    const catalog = createScenarioCatalog({ packs: [electricGridPack, weatherPack], scenarios: [scenario], defaultScenarioId: scenario.id })
    const runtime = catalog.runtimeFor(scenario.id)
    const gridObjects = scenario.initialObjects.filter(object => object.packId === 'electric-grid')

    expect(runtime?.runtimes).toContainEqual({ packId: 'electric-grid', runtimeId: electricGridRuntimeId, runtimeConfig: {} })
    expect(gridObjects).toHaveLength(1)
    expect(String(gridObjects[0]?.id)).toBe('grid:norway')
    expect(electricGridPack.authoring?.itemTypes.map(item => item.id)).toEqual(['grid'])
    expect(electricGridPack.presentation.categories.map(category => category.id)).toEqual(['electric-grids'])
    expect(electricGridPack.presentation.mapLayerGroups?.map(group => group.id)).toContain('electric-grid:reference-lines')
    expect(createLocalElectricGridPackRuntimeAdapter().operations.every(operation => operation.inputSchema !== undefined && operation.outputSchema !== undefined)).toBe(true)
    expect(electricGridPackDataSchema.parse(gridObjects[0]?.packData)).toMatchObject({
      model: { ref: 'electric-grid.norway.transmission' },
      operatingPoint: { ref: 'electric-grid.norway.normal' },
      automation: { ref: 'electric-grid.norway.standard' },
    })
  })

  test('keeps the shared snapshot compact while exposing private Grid Assets through bounded queries', async () => {
    const connection = await connect()
    try {
      const snapshot = await connection.getSnapshot()
      expect(snapshot.objects).toHaveLength(1)
      expect(JSON.stringify(snapshot).length).toBeLessThan(5_000)
      const data = electricGridPackDataSchema.parse(snapshot.objects[0]?.packData)
      expect(data.projection.tick).toBeGreaterThanOrEqual(1)
      expect(data.projection.totalGenerationMw).toBeGreaterThan(0)
      expect(data.projection.servedLoadMw).toBeGreaterThan(0)

      const search = okResult(await connection.query({
        packId: 'electric-grid',
        kind: 'electric-grid.assets.search',
        payload: { gridId: 'grid:norway', kinds: ['branch'], limit: 10 },
      }))
      expect(search.total).toBeGreaterThan(250)
      expect((search.assets as unknown[]).length).toBe(10)
      expect((search.assets as ReadonlyArray<Record<string, unknown>>)[0]).toMatchObject({
        kind: 'branch',
        status: { tone: expect.any(String), label: expect.any(String) },
        applicableOperationIds: expect.any(Array),
        mapTarget: { kind: 'bounds' },
      })
      const firstBranch = (search.assets as ReadonlyArray<{ readonly id: string }>)[0]!
      const branchDetail = okResult(await connection.query({
        packId: 'electric-grid', kind: 'electric-grid.asset.get', payload: { gridId: 'grid:norway', assetId: firstBranch.id },
      }))
      expect(branchDetail.asset).toMatchObject({ definition: { sourceId: expect.any(String), sourceFeatureId: expect.any(String) } })

      const summary = okResult(await connection.query({
        packId: 'electric-grid',
        kind: 'electric-grid.grid.summary',
        payload: { gridId: 'grid:norway' },
      }))
      expect(summary.assetCounts).toMatchObject({ bus: 255, generator: 70, load: 22, storage: 1 })
      expect((summary.constrainedBranches as unknown[]).length).toBeLessThanOrEqual(8)
      const connections = okResult(await connection.query({
        packId: 'electric-grid',
        kind: 'electric-grid.connection-points.list',
        payload: { gridId: 'grid:norway' },
      })).connectionPoints as ReadonlyArray<{ readonly assetId: string; readonly role: string }>
      expect(connections.length).toBeGreaterThan(0)
      expect(connections.every(connectionPoint => connectionPoint.assetId.startsWith('load:') && connectionPoint.role === 'demand')).toBe(true)
    } finally {
      await connection.close()
    }
  })

  test('targets private assets explicitly and persists command consequences on the Grid', async () => {
    const connection = await connect()
    try {
      const generators = okResult(await connection.query({
        packId: 'electric-grid', kind: 'electric-grid.assets.search', payload: { gridId: 'grid:norway', kinds: ['generator'], limit: 1 },
      })).assets as ReadonlyArray<{ readonly id: string }>
      const branches = okResult(await connection.query({
        packId: 'electric-grid', kind: 'electric-grid.assets.search', payload: { gridId: 'grid:norway', kinds: ['branch'], limit: 1 },
      })).assets as ReadonlyArray<{ readonly id: string }>
      const generatorId = generators[0]!.id
      const branchId = branches[0]!.id
      const before = okResult(await connection.query({ packId: 'electric-grid', kind: 'electric-grid.grid.summary', payload: { gridId: 'grid:norway' } }))
      const beforeReserve = (before.projection as { readonly reserveMarginMw: number }).reserveMarginMw

      const dispatch = await connection.sendCommand(command({ kind: gridDispatchGeneratorCommandKind, gridId: 'grid:norway', payload: { assetId: generatorId, targetMw: 0 } }))
      const trip = await connection.sendCommand(command({ kind: gridTripGeneratorCommandKind, gridId: 'grid:norway', payload: { assetId: generatorId } }))
      const derate = await connection.sendCommand(command({ kind: gridDerateBranchCommandKind, gridId: 'grid:norway', payload: { assetId: branchId, availability: 0.6 } }))
      expect(dispatch.ok).toBe(true)
      expect(trip.ok).toBe(true)
      expect(derate.ok).toBe(true)

      const generator = okResult(await connection.query({ packId: 'electric-grid', kind: 'electric-grid.asset.get', payload: { gridId: 'grid:norway', assetId: generatorId } }))
      const branch = okResult(await connection.query({ packId: 'electric-grid', kind: 'electric-grid.asset.get', payload: { gridId: 'grid:norway', assetId: branchId } }))
      const after = okResult(await connection.query({ packId: 'electric-grid', kind: 'electric-grid.grid.summary', payload: { gridId: 'grid:norway' } }))
      expect(generator.asset).toMatchObject({ state: { state: 'tripped', dispatchMw: 0, targetMw: 0 } })
      expect(branch.asset).toMatchObject({ state: { state: 'closed', availability: 0.6 }, status: { label: 'Derated 60%' } })
      expect((after.projection as { readonly reserveMarginMw: number }).reserveMarginMw).toBeLessThanOrEqual(beforeReserve)
    } finally {
      await connection.close()
    }
  })

  test('keeps generator availability separate from lifecycle state', async () => {
    const connection = await connect()
    try {
      const generators = okResult(await connection.query({
        packId: 'electric-grid', kind: 'electric-grid.assets.search', payload: { gridId: 'grid:norway', kinds: ['generator'], limit: 1 },
      })).assets as ReadonlyArray<{ readonly id: string }>
      const generatorId = generators[0]!.id
      expect((await connection.sendCommand(command({ kind: gridTripGeneratorCommandKind, gridId: 'grid:norway', payload: { assetId: generatorId } }))).ok).toBe(true)
      expect((await connection.sendCommand(command({ kind: gridSetGeneratorAvailabilityCommandKind, gridId: 'grid:norway', payload: { assetId: generatorId, availableMw: 50 } }))).ok).toBe(true)
      const tripped = okResult(await connection.query({ packId: 'electric-grid', kind: 'electric-grid.asset.get', payload: { gridId: 'grid:norway', assetId: generatorId } }))
      expect(tripped.asset).toMatchObject({ state: { state: 'tripped', availableMw: 50 } })
      expect((await connection.sendCommand(command({ kind: gridDispatchGeneratorCommandKind, gridId: 'grid:norway', payload: { assetId: generatorId, targetMw: 20 } }))).ok).toBe(false)
      expect((await connection.sendCommand(command({ kind: gridReturnGeneratorToServiceCommandKind, gridId: 'grid:norway', payload: { assetId: generatorId } }))).ok).toBe(true)
      expect((await connection.sendCommand(command({ kind: gridDispatchGeneratorCommandKind, gridId: 'grid:norway', payload: { assetId: generatorId, targetMw: 20 } }))).ok).toBe(true)
    } finally {
      await connection.close()
    }
  })

  test('applies typed Operating Point overrides with exact generation semantics', () => {
    const data = electricGridPackDataSchema.parse(gridScenario().initialObjects.find(object => object.id === 'grid:norway')?.packData)
    const definition = compileGridDefinition(gridDefinitionSchema.parse({
      id: 'grid:scaled',
      model: data.model,
      operatingPoint: { ...data.operatingPoint, overrides: { loadScale: 0.8, generationAvailabilityScale: 0.5, storageStateOfCharge: 0.25 } },
      automation: data.automation,
    }))
    const grid = createGridRuntimeInstance({ definition, at: '2026-01-01T10:00:00.000Z' })
    const generator = definition.model.generators[0]!
    expect(grid.generators.get(generator.id)?.availableMw).toBeCloseTo(Math.min(generator.capacityMw, generator.availableMw * 0.5))
    const load = definition.model.loads[0]!
    expect(grid.loads.get(load.id)?.nominalDemandMw).toBeCloseTo(load.demandMw * 0.8)
    expect([...grid.storage.values()][0]?.stateOfChargeFraction).toBeCloseTo(0.25)
  })

  test('rejects invalid Model identity and references during compilation', () => {
    const data = electricGridPackDataSchema.parse(gridScenario().initialObjects.find(object => object.id === 'grid:norway')?.packData)
    const definition = compileGridDefinition(gridDefinitionSchema.parse({ id: 'grid:norway', model: data.model, operatingPoint: data.operatingPoint, automation: data.automation }))
    expect(() => compileGridModelIndex({ ...definition.model, buses: [...definition.model.buses, definition.model.buses[0]!] })).toThrow('duplicate bus ids')
    expect(() => compileGridModelIndex({
      ...definition.model,
      branches: [{ ...definition.model.branches[0]!, fromBusId: 'missing:bus' }, ...definition.model.branches.slice(1)],
    })).toThrow('references unknown bus')
  })

  test('tracks storage energy, island frequency, and cached topology in private runtime state', () => {
    const data = electricGridPackDataSchema.parse(gridScenario().initialObjects.find(object => object.id === 'grid:norway')?.packData)
    const definition = compileGridDefinition(gridDefinitionSchema.parse({ id: 'grid:norway', model: data.model, operatingPoint: data.operatingPoint, automation: data.automation }))
    const grid = createGridRuntimeInstance({ definition, at: '2026-01-01T10:00:00.000Z' })
    advanceGrid(grid, 0, '2026-01-01T10:00:00.000Z' as IsoTimestamp)
    const firstPlan = grid.topologyPlan
    const storage = [...grid.storage.values()][0]!
    const initialCharge = storage.stateOfChargeFraction
    for (const generator of grid.generators.values()) {
      generator.state = 'tripped'
      generator.dispatchMw = 0
      generator.targetMw = 0
    }
    advanceGrid(grid, 3_600, '2026-01-01T11:00:00.000Z' as IsoTimestamp)
    expect(grid.topologyPlan).toBe(firstPlan)
    expect(new Set([...grid.busStates.values()].map(state => state.islandId)).size).toBeGreaterThanOrEqual(grid.projection.activeIslandCount)
    expect(grid.projection.activeIslandCount).toBeGreaterThan(0)
    expect(storage.dispatchMw).toBeGreaterThan(0)
    expect(storage.stateOfChargeFraction).toBeLessThan(initialCharge)

    const branchId = definition.model.branches[0]!.id
    grid.branches.get(branchId)!.state = 'open'
    advanceGrid(grid, 1, '2026-01-01T11:00:01.000Z' as IsoTimestamp)
    expect(grid.topologyPlan).not.toBe(firstPlan)
  })

  test('keeps steady-topology Grid ticks within the lightweight runtime budget', () => {
    const data = electricGridPackDataSchema.parse(gridScenario().initialObjects.find(object => object.id === 'grid:norway')?.packData)
    const definition = compileGridDefinition(gridDefinitionSchema.parse({ id: 'grid:norway', model: data.model, operatingPoint: data.operatingPoint, automation: data.automation }))
    const grid = createGridRuntimeInstance({ definition, at: '2026-01-01T10:00:00.000Z' })
    advanceGrid(grid, 0, '2026-01-01T10:00:00.000Z' as IsoTimestamp)
    const startedAtMs = performance.now()
    for (let index = 1; index <= 40; index += 1) {
      advanceGrid(grid, 2, new Date(Date.parse('2026-01-01T10:00:00.000Z') + index * 2_000).toISOString() as IsoTimestamp)
    }
    const averageTickMs = (performance.now() - startedAtMs) / 40
    expect(averageTickMs).toBeLessThan(5)
    expect(grid.diagnostics.topologyRebuildCount).toBe(1)
    expect(grid.diagnostics.lastSuccessfulTickAt).not.toBeNull()
  })

  test('records a compact Grid projection when an operator changes a private asset', async () => {
    const connection = await connect()
    try {
      const emitted: ReadonlyArray<PackRuntimeEvent>[] = []
      const unsubscribe = connection.subscribe(emission => emitted.push(emission.events))
      const generators = okResult(await connection.query({
        packId: 'electric-grid', kind: 'electric-grid.assets.search', payload: { gridId: 'grid:norway', kinds: ['generator'], limit: 1 },
      })).assets as ReadonlyArray<{ readonly id: string }>
      const result = await connection.sendCommand(command({ kind: gridTripGeneratorCommandKind, gridId: 'grid:norway', payload: { assetId: generators[0]!.id } }))
      unsubscribe()
      expect(result.ok).toBe(true)
      const objectEvents = emitted.flat().filter(event => event.type === 'object.upserted')
      expect(objectEvents).toHaveLength(1)
      expect(objectEvents[0]).toMatchObject({ history: 'record', object: { id: 'grid:norway' } })
    } finally {
      await connection.close()
    }
  })

  test('restores private asset controls only against the exact resolved Grid definition', async () => {
    let stored: unknown = null
    const store: PackRuntimeStateStore = {
      load: async () => stored,
      save: async state => { stored = state },
    }
    const first = await connect(store)
    const generators = okResult(await first.query({
      packId: 'electric-grid', kind: 'electric-grid.assets.search', payload: { gridId: 'grid:norway', kinds: ['generator'], limit: 1 },
    })).assets as ReadonlyArray<{ readonly id: string }>
    const generatorId = generators[0]!.id
    expect((await first.sendCommand(command({ kind: gridTripGeneratorCommandKind, gridId: 'grid:norway', payload: { assetId: generatorId } }))).ok).toBe(true)
    await first.close()

    const restored = await connect(store)
    try {
      const generator = okResult(await restored.query({
        packId: 'electric-grid', kind: 'electric-grid.asset.get', payload: { gridId: 'grid:norway', assetId: generatorId },
      }))
      expect(generator.asset).toMatchObject({ state: { state: 'tripped', dispatchMw: 0, targetMw: 0 } })
    } finally {
      await restored.close()
    }

    const invalid = structuredClone(stored) as { grids: Array<{ definitionDigest: string }> }
    invalid.grids[0]!.definitionDigest = '0'.repeat(64)
    stored = invalid
    await expect(connect(store)).rejects.toThrow('does not match its resolved Model, Operating Point, and Automation definition')
  })
})
