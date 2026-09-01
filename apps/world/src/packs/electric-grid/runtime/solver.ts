import type { IsoTimestamp } from '../../../core/model/index.ts'
import type { GridBranchDefinition, GridGeneratorDefinition, GridLoadDefinition } from '../grid-model.ts'
import type {
  GridLinearFactor,
  GridRuntimeInstance,
  GridTopologyIsland,
  GridTopologyPlan,
} from './instance.ts'

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value))

const ramp = (current: number, target: number, maxDelta: number): number =>
  target > current ? Math.min(target, current + maxDelta) : Math.max(target, current - maxDelta)

const stableUnitFor = (value: string): number => {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0) / 0xffffffff
}

const loadDailyFactor = (load: GridLoadDefinition, hour: number): number => {
  const phase = 2 * Math.PI * hour / 24
  if (load.kind === 'residential') return 1 + 0.055 * Math.sin(phase - 0.6) + 0.05 * Math.sin(2 * phase - 2.2)
  if (load.kind === 'commercial' || load.kind === 'airport') return 0.98 + 0.08 * Math.sin(phase - 1.35) + 0.025 * Math.sin(2 * phase - 1.8)
  if (load.kind === 'ev_charging') return 0.96 + 0.105 * Math.sin(phase - 2.35) + 0.035 * Math.sin(2 * phase - 2.9)
  if (load.kind === 'industry' || load.kind === 'data_center' || load.kind === 'process_plant') return 1 + 0.018 * Math.sin(phase - 0.9)
  if (load.kind === 'hospital') return 1 + 0.01 * Math.sin(phase - 0.4)
  return 1
}

const profiledDemand = (load: GridLoadDefinition, nominalDemandMw: number, at: IsoTimestamp): number => {
  const seconds = Date.parse(at) / 1_000
  const hour = (((seconds % 86_400) + 86_400) % 86_400) / 3_600
  const seed = stableUnitFor(`${load.id}:${load.kind}`)
  const regulation = 0.006 * Math.sin(seconds / 95 + 0.8) + 0.003 * Math.sin(seconds / 29 + 1.7)
  const local = 0.012 * Math.sin(seconds / (41 + seed * 23) + seed * Math.PI * 2)
    + 0.006 * Math.sin(seconds / (113 + seed * 31) + seed * Math.PI * 5)
  return Math.max(load.criticalMw, nominalDemandMw * clamp(loadDailyFactor(load, hour) + regulation + local, 0.78, 1.22))
}

const activeBranch = (grid: GridRuntimeInstance, branch: GridBranchDefinition): boolean => {
  const state = grid.branches.get(branch.id)?.state
  return state === 'closed' || state === 'derated'
}

const topologySignature = (grid: GridRuntimeInstance): string => grid.definition.model.branches
  .map(branch => `${branch.id}:${activeBranch(grid, branch) ? '1' : '0'}`)
  .join('|')

const islandsFor = (grid: GridRuntimeInstance): ReadonlyArray<GridTopologyIsland> => {
  const adjacency = new Map(grid.definition.model.buses.map(bus => [bus.id, new Set<string>()]))
  for (const branch of grid.definition.model.branches) {
    if (!activeBranch(grid, branch)) continue
    adjacency.get(branch.fromBusId)?.add(branch.toBusId)
    adjacency.get(branch.toBusId)?.add(branch.fromBusId)
  }
  const seen = new Set<string>()
  const islands: GridTopologyIsland[] = []
  for (const bus of grid.definition.model.buses) {
    if (seen.has(bus.id)) continue
    const queue = [bus.id]
    const buses: string[] = []
    seen.add(bus.id)
    while (queue.length > 0) {
      const current = queue.shift()!
      buses.push(current)
      for (const next of adjacency.get(current) ?? []) {
        if (seen.has(next)) continue
        seen.add(next)
        queue.push(next)
      }
    }
    const id = `island:${[...buses].sort()[0]}`
    islands.push({ id, buses, busSet: new Set(buses) })
  }
  return islands
}

const factorFor = (
  island: GridTopologyIsland,
  branches: ReadonlyArray<GridBranchDefinition>,
): GridLinearFactor => {
  const buses = island.buses.slice(1)
  const indexByBus = new Map(buses.map((bus, index) => [bus, index]))
  const matrix = buses.map(() => buses.map(() => 0))
  for (const branch of branches) {
    if (!island.busSet.has(branch.fromBusId) || !island.busSet.has(branch.toBusId)) continue
    const susceptance = 1 / Math.max(0.0001, branch.reactancePu)
    const i = indexByBus.get(branch.fromBusId)
    const j = indexByBus.get(branch.toBusId)
    if (i !== undefined) matrix[i]![i] = (matrix[i]![i] ?? 0) + susceptance
    if (j !== undefined) matrix[j]![j] = (matrix[j]![j] ?? 0) + susceptance
    if (i !== undefined && j !== undefined) {
      matrix[i]![j] = (matrix[i]![j] ?? 0) - susceptance
      matrix[j]![i] = (matrix[j]![i] ?? 0) - susceptance
    }
  }
  const lower = buses.map(() => buses.map(() => 0))
  for (let row = 0; row < buses.length; row += 1) {
    for (let col = 0; col <= row; col += 1) {
      let value = matrix[row]![col]!
      for (let k = 0; k < col; k += 1) value -= lower[row]![k]! * lower[col]![k]!
      lower[row]![col] = row === col
        ? Math.sqrt(Math.max(value, 1e-9))
        : value / Math.max(lower[col]![col]!, 1e-9)
    }
  }
  const upper = buses.map((_, row) => buses.map((__, col) => lower[col]?.[row] ?? 0))
  return { buses, lower, upper }
}

const topologyPlanFor = (grid: GridRuntimeInstance): GridTopologyPlan => {
  const signature = topologySignature(grid)
  if (grid.topologyPlan?.signature === signature) return grid.topologyPlan
  const islands = islandsFor(grid)
  const activeBranches = grid.definition.model.branches.filter(branch => activeBranch(grid, branch))
  const factors = new Map(islands.map(island => [island.id, factorFor(island, activeBranches)]))
  const islandIdByBus = new Map(islands.flatMap(island => island.buses.map(bus => [bus, island.id] as const)))
  const plan = { signature, islands, factors, islandIdByBus }
  grid.topologyPlan = plan
  return plan
}

const solveFactor = (factor: GridLinearFactor, rhs: ReadonlyArray<number>): ReadonlyArray<number> => {
  const y = rhs.map(() => 0)
  for (let row = 0; row < rhs.length; row += 1) {
    let value = rhs[row] ?? 0
    for (let col = 0; col < row; col += 1) value -= factor.lower[row]![col]! * y[col]!
    y[row] = value / Math.max(factor.lower[row]![row]!, 1e-9)
  }
  const result = rhs.map(() => 0)
  for (let row = rhs.length - 1; row >= 0; row -= 1) {
    let value = y[row] ?? 0
    for (let col = row + 1; col < rhs.length; col += 1) value -= factor.upper[row]![col]! * result[col]!
    result[row] = value / Math.max(factor.upper[row]![row]!, 1e-9)
  }
  return result
}

const frequencyStep = (config: {
  readonly nominalHz: number
  readonly previousHz: number
  readonly generationMw: number
  readonly loadMw: number
  readonly reserveMw: number
  readonly inertiaSeconds: number
  readonly dtSeconds: number
}): number => {
  const droopMw = clamp((config.nominalHz - config.previousHz) * 500, -config.reserveMw, config.reserveMw)
  const imbalanceMw = config.generationMw + droopMw - config.loadMw
  const equilibriumHz = config.nominalHz + clamp(imbalanceMw / Math.max(500, config.loadMw) * 2, -1.6, 0.6)
  const timeConstantSeconds = clamp(5 + config.inertiaSeconds / 100, 5, 20)
  const response = 1 - Math.exp(-Math.max(0, config.dtSeconds) / timeConstantSeconds)
  return clamp(
    config.previousHz + (equilibriumHz - config.previousHz) * response,
    config.nominalHz - 1.6,
    config.nominalHz + 0.6,
  )
}

const generatorsOn = (state: string): boolean => state === 'online' || state === 'derated'

const generatorDefinitionsOnBus = (grid: GridRuntimeInstance, busSet: ReadonlySet<string>): ReadonlyArray<GridGeneratorDefinition> =>
  grid.definition.model.generators.filter(generator => busSet.has(generator.busId))

export const advanceGrid = (grid: GridRuntimeInstance, dtSeconds: number, at: IsoTimestamp): void => {
  const model = grid.definition.model
  const plan = topologyPlanFor(grid)
  const busById = new Map(model.buses.map(bus => [bus.id, bus]))
  const loadById = new Map(model.loads.map(load => [load.id, load]))
  const dynamicSeconds = Math.max(0, dtSeconds)
  grid.elapsedMs += dynamicSeconds * 1_000
  grid.tick += 1

  for (const generator of model.generators) {
    const state = grid.generators.get(generator.id)!
    const target = generatorsOn(state.state) ? Math.min(state.targetMw, state.availableMw) : 0
    state.dispatchMw = ramp(state.dispatchMw, target, generator.rampRateMwPerMinute * dynamicSeconds / 60)
  }
  for (const load of model.loads) {
    const state = grid.loads.get(load.id)!
    state.demandMw = grid.definition.automation.loadProfiles ? profiledDemand(load, state.nominalDemandMw, at) : state.nominalDemandMw
    state.servedMw = state.demandMw
    state.shedMw = 0
  }

  const frequencyByIsland = new Map<string, number>()
  for (const island of plan.islands) {
    const generators = generatorDefinitionsOnBus(grid, island.busSet)
    const loads = model.loads.filter(load => island.busSet.has(load.busId))
    const storage = model.storage.filter(item => island.busSet.has(item.busId))
    const generationMw = generators.reduce((sum, generator) => sum + grid.generators.get(generator.id)!.dispatchMw, 0)
    const loadMw = loads.reduce((sum, load) => sum + grid.loads.get(load.id)!.demandMw, 0)
    const reserveMw = generators.reduce((sum, generator) => {
      const state = grid.generators.get(generator.id)!
      return sum + (generatorsOn(state.state) ? Math.min(state.reserveMw, Math.max(0, state.availableMw - state.dispatchMw)) : 0)
    }, 0)
    const inertiaSeconds = generators.reduce((sum, generator) => {
      const state = grid.generators.get(generator.id)!
      return sum + (generatorsOn(state.state) ? generator.inertiaSeconds * Math.max(0.1, state.dispatchMw / Math.max(1, generator.capacityMw)) : 0)
    }, 0)
    const previousHz = grid.frequencyByIsland.get(island.id) ?? model.nominalFrequencyHz
    const frequencyHz = frequencyStep({
      nominalHz: model.nominalFrequencyHz,
      previousHz,
      generationMw,
      loadMw,
      reserveMw,
      inertiaSeconds,
      dtSeconds: dynamicSeconds,
    })
    frequencyByIsland.set(island.id, frequencyHz)
    const shedFraction = !grid.definition.automation.underFrequencyLoadShedding
      ? 0
      : frequencyHz < model.nominalFrequencyHz - 0.85
        ? 0.45
        : frequencyHz < model.nominalFrequencyHz - 0.65
          ? 0.28
          : frequencyHz < model.nominalFrequencyHz - 0.35
            ? 0.12
            : 0
    for (const load of loads) {
      const state = grid.loads.get(load.id)!
      const interruptibleMw = Math.max(0, state.demandMw - load.criticalMw)
      state.shedMw = interruptibleMw * shedFraction
      state.servedMw = Math.max(load.criticalMw, state.demandMw - state.shedMw)
      state.frequencyHz = frequencyHz
      state.serviceState = state.servedMw <= 0 ? 'outage' : state.shedMw > 0 ? 'shed' : Math.abs(frequencyHz - model.nominalFrequencyHz) >= 0.2 ? 'constrained' : 'normal'
    }
    for (const item of storage) {
      const state = grid.storage.get(item.id)!
      const canDischarge = state.stateOfChargeFraction > 0.02
      const canCharge = state.stateOfChargeFraction < 0.98
      state.dispatchMw = !grid.definition.automation.storageFrequencyResponse
        ? 0
        : frequencyHz < model.nominalFrequencyHz - 0.15 && canDischarge
          ? item.maxDischargeMw
          : frequencyHz > model.nominalFrequencyHz + 0.08 && canCharge
            ? -item.maxChargeMw
            : 0
      const energyMwh = state.dispatchMw >= 0
        ? state.dispatchMw * dynamicSeconds / 3_600 / 0.92
        : state.dispatchMw * dynamicSeconds / 3_600 * 0.92
      state.stateOfChargeFraction = clamp(state.stateOfChargeFraction - energyMwh / item.capacityMwh, 0, 1)
      state.frequencyHz = frequencyHz
      state.state = state.dispatchMw > 0 ? 'discharging' : state.dispatchMw < 0 ? 'charging' : 'idle'
    }
    for (const generator of generators) grid.generators.get(generator.id)!.frequencyHz = frequencyHz
  }
  grid.frequencyByIsland = frequencyByIsland

  const injections = new Map(model.buses.map(bus => [bus.id, 0]))
  for (const generator of model.generators) injections.set(generator.busId, (injections.get(generator.busId) ?? 0) + grid.generators.get(generator.id)!.dispatchMw)
  for (const load of model.loads) injections.set(load.busId, (injections.get(load.busId) ?? 0) - grid.loads.get(load.id)!.servedMw)
  for (const item of model.storage) injections.set(item.busId, (injections.get(item.busId) ?? 0) + grid.storage.get(item.id)!.dispatchMw)

  const angles = new Map<string, number>()
  for (const island of plan.islands) {
    const factor = plan.factors.get(island.id)!
    const solved = solveFactor(factor, factor.buses.map(bus => injections.get(bus) ?? 0))
    angles.set(island.buses[0]!, 0)
    for (let index = 0; index < factor.buses.length; index += 1) angles.set(factor.buses[index]!, solved[index] ?? 0)
  }

  const branchLoadingByBus = new Map<string, number>()
  for (const branch of model.branches) {
    const state = grid.branches.get(branch.id)!
    const flowMw = activeBranch(grid, branch)
      ? ((angles.get(branch.fromBusId) ?? 0) - (angles.get(branch.toBusId) ?? 0)) / Math.max(0.0001, branch.reactancePu)
      : 0
    const ratingMw = state.state === 'derated' ? branch.ratingMw * state.availability : branch.ratingMw
    state.flowMw = flowMw
    state.loadingPercent = Math.abs(flowMw) / Math.max(1, ratingMw) * 100
    state.frequencyHz = frequencyByIsland.get(plan.islandIdByBus.get(branch.fromBusId) ?? '') ?? model.nominalFrequencyHz
    state.lossesMw = Math.abs(flowMw) * branch.resistancePu * 0.006
    branchLoadingByBus.set(branch.fromBusId, Math.max(branchLoadingByBus.get(branch.fromBusId) ?? 0, state.loadingPercent))
    branchLoadingByBus.set(branch.toBusId, Math.max(branchLoadingByBus.get(branch.toBusId) ?? 0, state.loadingPercent))
  }

  const generationByBus = new Map<string, number>()
  const loadByBus = new Map<string, number>()
  const reactiveByBus = new Map<string, number>()
  for (const generator of model.generators) generationByBus.set(generator.busId, (generationByBus.get(generator.busId) ?? 0) + grid.generators.get(generator.id)!.dispatchMw)
  for (const load of model.loads) {
    loadByBus.set(load.busId, (loadByBus.get(load.busId) ?? 0) + grid.loads.get(load.id)!.servedMw)
    const state = grid.loads.get(load.id)!
    const reactive = load.demandMw <= 0 ? 0 : load.reactiveDemandMvar * state.demandMw / load.demandMw
    reactiveByBus.set(load.busId, (reactiveByBus.get(load.busId) ?? 0) + reactive)
  }
  const busStates = new Map<string, GridRuntimeInstance['busStates'] extends Map<string, infer T> ? T : never>()
  for (const bus of model.buses) {
    const servedLoadMw = loadByBus.get(bus.id) ?? 0
    const loadStress = servedLoadMw <= 0 ? 0 : Math.min(0.055, (reactiveByBus.get(bus.id) ?? 0) / Math.max(1, servedLoadMw) * 0.035)
    const flowStress = Math.max(0, (branchLoadingByBus.get(bus.id) ?? 0) - 82) * 0.0015
    const generationSupport = Math.min(0.018, (generationByBus.get(bus.id) ?? 0) / Math.max(1, servedLoadMw + 100) * 0.01)
    const islandId = plan.islandIdByBus.get(bus.id)!
    busStates.set(bus.id, {
      busId: bus.id,
      voltagePu: clamp(1 - loadStress - flowStress + generationSupport, 0.88, 1.06),
      frequencyHz: frequencyByIsland.get(islandId) ?? model.nominalFrequencyHz,
      angleRad: angles.get(bus.id) ?? 0,
      islandId,
      netInjectionMw: injections.get(bus.id) ?? 0,
    })
  }
  grid.busStates = busStates
  for (const branch of model.branches) {
    const state = grid.branches.get(branch.id)!
    state.voltageFromPu = busStates.get(branch.fromBusId)?.voltagePu ?? 1
    state.voltageToPu = busStates.get(branch.toBusId)?.voltagePu ?? 1
  }
  for (const load of model.loads) grid.loads.get(load.id)!.voltagePu = busStates.get(load.busId)?.voltagePu ?? 1
  for (const item of model.storage) grid.storage.get(item.id)!.voltagePu = busStates.get(item.busId)?.voltagePu ?? 1

  const totalGenerationMw = [...grid.generators.values()].reduce((sum, item) => sum + item.dispatchMw, 0)
  const totalLoadMw = [...grid.loads.values()].reduce((sum, item) => sum + item.demandMw, 0)
  const servedLoadMw = [...grid.loads.values()].reduce((sum, item) => sum + item.servedMw, 0)
  const unservedLoadMw = totalLoadMw - servedLoadMw
  const reserveMarginMw = [...grid.generators.values()].reduce((sum, item) => sum + (generatorsOn(item.state) ? Math.min(item.reserveMw, Math.max(0, item.availableMw - item.dispatchMw)) : 0), 0)
  const highestBranchLoadingPercent = [...grid.branches.values()].reduce((highest, item) => Math.max(highest, item.loadingPercent), 0)
  const lowestVoltagePu = [...busStates.values()].reduce((lowest, item) => Math.min(lowest, item.voltagePu), 1)
  const totalWeight = model.loads.reduce((sum, load) => sum + grid.loads.get(load.id)!.demandMw, 0)
  const frequencyHz = totalWeight <= 0
    ? model.nominalFrequencyHz
    : model.loads.reduce((sum, load) => sum + grid.loads.get(load.id)!.frequencyHz * grid.loads.get(load.id)!.demandMw, 0) / totalWeight
  const activeAlarmCount = [
    Math.abs(frequencyHz - model.nominalFrequencyHz) >= 0.15,
    highestBranchLoadingPercent >= 85,
    lowestVoltagePu < 0.95,
    unservedLoadMw > 0.1,
  ].filter(Boolean).length
  const activeIslandCount = plan.islands.filter(island =>
    model.generators.some(generator => island.busSet.has(generator.busId))
    || model.loads.some(load => island.busSet.has(load.busId))
    || model.storage.some(item => island.busSet.has(item.busId))).length
  const statusTone = activeAlarmCount > 0 ? 'error' as const : Math.abs(frequencyHz - model.nominalFrequencyHz) >= 0.05 ? 'working' as const : 'ready' as const
  grid.projection = {
    statusTone,
    statusLabel: activeAlarmCount > 0 ? `${activeAlarmCount} active alarm${activeAlarmCount === 1 ? '' : 's'}` : 'Normal',
    summary: `${frequencyHz.toFixed(2)} Hz · ${Math.round(servedLoadMw).toLocaleString()} MW served · ${activeAlarmCount} alarms`,
    nominalFrequencyHz: model.nominalFrequencyHz,
    frequencyHz,
    totalGenerationMw,
    totalLoadMw,
    servedLoadMw,
    unservedLoadMw,
    reserveMarginMw,
    highestBranchLoadingPercent,
    lowestVoltagePu,
    activeIslandCount: Math.max(1, activeIslandCount),
    activeAlarmCount,
    tick: grid.tick,
    updatedAt: at,
  }
}
