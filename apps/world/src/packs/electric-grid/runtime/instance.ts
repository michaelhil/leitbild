import type {
  CompiledGridDefinition,
  GridAssetDefinition,
  GridAssetKind,
  GridBranchDefinition,
  GridGeneratorDefinition,
  GridLoadDefinition,
  GridStorageDefinition,
} from '../grid-model.ts'
import type { GridProjection } from '../model.ts'

export interface GridBusState {
  readonly busId: string
  readonly voltagePu: number
  readonly frequencyHz: number
  readonly angleRad: number
  readonly islandId: string
  readonly netInjectionMw: number
}

export interface GridBranchState {
  state: 'closed' | 'open'
  availability: number
  flowMw: number
  loadingPercent: number
  voltageFromPu: number
  voltageToPu: number
  frequencyHz: number
  lossesMw: number
}

export interface GridGeneratorState {
  state: 'online' | 'offline' | 'tripped'
  availableMw: number
  dispatchMw: number
  targetMw: number
  reserveMw: number
  frequencyHz: number
}

export interface GridLoadState {
  nominalDemandMw: number
  demandMw: number
  servedMw: number
  shedMw: number
  frequencyHz: number
  voltagePu: number
  serviceState: 'normal' | 'constrained' | 'shed' | 'outage'
}

export interface GridStorageState {
  stateOfChargeFraction: number
  dispatchMw: number
  frequencyHz: number
  voltagePu: number
  state: 'idle' | 'charging' | 'discharging' | 'unavailable'
}

export interface GridTopologyIsland {
  readonly id: string
  readonly buses: ReadonlyArray<string>
  readonly busSet: ReadonlySet<string>
  readonly branches: ReadonlyArray<GridBranchDefinition>
  readonly generators: ReadonlyArray<GridGeneratorDefinition>
  readonly loads: ReadonlyArray<GridLoadDefinition>
  readonly storage: ReadonlyArray<GridStorageDefinition>
}

export interface GridLinearFactor {
  readonly buses: ReadonlyArray<string>
  readonly lower: ReadonlyArray<ReadonlyArray<number>>
  readonly upper: ReadonlyArray<ReadonlyArray<number>>
}

export interface GridTopologyPlan {
  readonly signature: string
  readonly islands: ReadonlyArray<GridTopologyIsland>
  readonly islandIdByBus: ReadonlyMap<string, string>
  readonly factors: ReadonlyMap<string, GridLinearFactor>
}

export interface GridRuntimeDiagnostics {
  lastSuccessfulTickAt: string | null
  lastTickDurationMs: number
  maximumTickDurationMs: number
  topologyRebuildCount: number
  lastTopologyRebuildDurationMs: number
  queryCount: number
  lastQueryDurationMs: number
  persistenceFailureCount: number
  lastPersistenceFailure: string | null
}

export interface GridRuntimeInstance {
  readonly definition: CompiledGridDefinition
  elapsedMs: number
  tick: number
  readonly branches: Map<string, GridBranchState>
  readonly generators: Map<string, GridGeneratorState>
  readonly loads: Map<string, GridLoadState>
  readonly storage: Map<string, GridStorageState>
  busStates: Map<string, GridBusState>
  frequencyByIsland: Map<string, number>
  topologyPlan: GridTopologyPlan | null
  readonly diagnostics: GridRuntimeDiagnostics
  projection: GridProjection
}

export interface GridAssetSnapshot {
  readonly id: string
  readonly label: string
  readonly kind: GridAssetKind
  readonly definition: GridAssetDefinition
  readonly state?: GridBusState | GridBranchState | GridGeneratorState | GridLoadState | GridStorageState
}

export interface RestoredGridRuntimeState {
  readonly elapsedMs: number
  readonly tick: number
  readonly frequencies: ReadonlyArray<{ readonly islandId: string; readonly frequencyHz: number }>
  readonly branches: ReadonlyArray<{ readonly id: string; readonly state: GridBranchState['state']; readonly availability: number }>
  readonly generators: ReadonlyArray<{ readonly id: string; readonly state: GridGeneratorState['state']; readonly availableMw: number; readonly dispatchMw: number; readonly targetMw: number }>
  readonly loads: ReadonlyArray<{ readonly id: string; readonly nominalDemandMw: number }>
  readonly storage: ReadonlyArray<{ readonly id: string; readonly stateOfChargeFraction: number; readonly dispatchMw: number }>
}

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value))

const initialGenerationTargets = (definition: CompiledGridDefinition): Map<string, number> => {
  const loadByComponent = new Map<string, number>()
  const availableByComponent = new Map<string, number>()
  for (const load of definition.model.loads) {
    const componentId = definition.index.staticComponentByBus.get(load.busId)!
    loadByComponent.set(componentId, (loadByComponent.get(componentId) ?? 0) + load.demandMw * definition.operatingPoint.loadScale)
  }
  for (const generator of definition.model.generators) {
    const componentId = definition.index.staticComponentByBus.get(generator.busId)!
    const availableMw = Math.min(generator.capacityMw, generator.availableMw * definition.operatingPoint.generationAvailabilityScale)
    availableByComponent.set(componentId, (availableByComponent.get(componentId) ?? 0) + availableMw)
  }
  return new Map(definition.model.generators.map(generator => {
    const componentId = definition.index.staticComponentByBus.get(generator.busId)!
    const demandMw = loadByComponent.get(componentId) ?? 0
    const availableMw = availableByComponent.get(componentId) ?? 0
    const generatorAvailableMw = Math.min(generator.capacityMw, generator.availableMw * definition.operatingPoint.generationAvailabilityScale)
    return [generator.id, availableMw <= 0 ? 0 : Math.min(generatorAvailableMw, demandMw * generatorAvailableMw / availableMw)]
  }))
}

export const createGridRuntimeInstance = (config: {
  readonly definition: CompiledGridDefinition
  readonly at: string
  readonly restored?: RestoredGridRuntimeState
}): GridRuntimeInstance => {
  const targets = initialGenerationTargets(config.definition)
  const restoredBranches = new Map(config.restored?.branches.map(item => [item.id, item]))
  const restoredGenerators = new Map(config.restored?.generators.map(item => [item.id, item]))
  const restoredLoads = new Map(config.restored?.loads.map(item => [item.id, item]))
  const restoredStorage = new Map(config.restored?.storage.map(item => [item.id, item]))
  const branches = new Map(config.definition.model.branches.map(branch => {
    const restored = restoredBranches.get(branch.id)
    return [branch.id, {
      state: restored?.state ?? 'closed',
      availability: restored?.availability ?? 1,
      flowMw: 0,
      loadingPercent: 0,
      voltageFromPu: 1,
      voltageToPu: 1,
      frequencyHz: config.definition.model.nominalFrequencyHz,
      lossesMw: 0,
    } satisfies GridBranchState]
  }))
  const generators = new Map(config.definition.model.generators.map(generator => {
    const restored = restoredGenerators.get(generator.id)
    const targetMw = restored?.targetMw ?? targets.get(generator.id) ?? 0
    const initialAvailableMw = generator.availableMw * config.definition.operatingPoint.generationAvailabilityScale
    return [generator.id, {
      state: restored?.state ?? 'online',
      availableMw: clamp(restored?.availableMw ?? initialAvailableMw, 0, generator.capacityMw),
      dispatchMw: clamp(restored?.dispatchMw ?? targetMw, 0, generator.capacityMw),
      targetMw: clamp(targetMw, 0, generator.capacityMw),
      reserveMw: generator.reserveMw,
      frequencyHz: config.definition.model.nominalFrequencyHz,
    } satisfies GridGeneratorState]
  }))
  const loads = new Map(config.definition.model.loads.map(load => {
    const nominalDemandMw = restoredLoads.get(load.id)?.nominalDemandMw ?? load.demandMw * config.definition.operatingPoint.loadScale
    return [load.id, {
      nominalDemandMw,
      demandMw: nominalDemandMw,
      servedMw: nominalDemandMw,
      shedMw: 0,
      frequencyHz: config.definition.model.nominalFrequencyHz,
      voltagePu: 1,
      serviceState: 'normal',
    } satisfies GridLoadState]
  }))
  const storage = new Map(config.definition.model.storage.map(item => {
    const restored = restoredStorage.get(item.id)
    return [item.id, {
      stateOfChargeFraction: clamp(restored?.stateOfChargeFraction ?? config.definition.operatingPoint.storageStateOfCharge, 0, 1),
      dispatchMw: restored?.dispatchMw ?? 0,
      frequencyHz: config.definition.model.nominalFrequencyHz,
      voltagePu: 1,
      state: 'idle',
    } satisfies GridStorageState]
  }))
  return {
    definition: config.definition,
    elapsedMs: config.restored?.elapsedMs ?? 0,
    tick: config.restored?.tick ?? 0,
    branches,
    generators,
    loads,
    storage,
    busStates: new Map(),
    frequencyByIsland: new Map(config.restored?.frequencies.map(item => [item.islandId, item.frequencyHz])),
    topologyPlan: null,
    diagnostics: {
      lastSuccessfulTickAt: null,
      lastTickDurationMs: 0,
      maximumTickDurationMs: 0,
      topologyRebuildCount: 0,
      lastTopologyRebuildDurationMs: 0,
      queryCount: 0,
      lastQueryDurationMs: 0,
      persistenceFailureCount: 0,
      lastPersistenceFailure: null,
    },
    projection: {
      statusTone: 'idle',
      statusLabel: 'Initializing',
      summary: 'Grid runtime is initializing',
      nominalFrequencyHz: config.definition.model.nominalFrequencyHz,
      frequencyHz: config.definition.model.nominalFrequencyHz,
      totalGenerationMw: 0,
      totalLoadMw: 0,
      servedLoadMw: 0,
      unservedLoadMw: 0,
      reserveMarginMw: 0,
      highestBranchLoadingPercent: 0,
      lowestVoltagePu: 1,
      activeIslandCount: 1,
      activeAlarmCount: 0,
      tick: config.restored?.tick ?? 0,
      updatedAt: config.at,
    },
  }
}

export const gridAssetSnapshotFor = (grid: GridRuntimeInstance, assetId: string): GridAssetSnapshot | undefined => {
  const entry = grid.definition.index.assetById.get(assetId)
  if (!entry) return undefined
  const state = entry.kind === 'bus'
    ? grid.busStates.get(entry.id)
    : entry.kind === 'branch'
      ? grid.branches.get(entry.id)
      : entry.kind === 'generator'
        ? grid.generators.get(entry.id)
        : entry.kind === 'load'
          ? grid.loads.get(entry.id)
          : grid.storage.get(entry.id)
  return {
    ...entry,
    ...(state === undefined ? {} : { state }),
  }
}

export const gridAssetSnapshots = (grid: GridRuntimeInstance): ReadonlyArray<GridAssetSnapshot> =>
  grid.definition.index.assets.map(entry => gridAssetSnapshotFor(grid, entry.id)!)
