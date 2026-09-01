import type { IsoTimestamp } from '../../../core/model/index.ts'
import type { GridRuntimeInstance } from './instance.ts'
import { gridFrequencyStep, gridGeneratorIsOnline, profiledGridDemand } from './dynamics.ts'
import { gridBranchIsClosed, solveGridAngles, topologyPlanForGrid } from './topology.ts'

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value))

const ramp = (current: number, target: number, maxDelta: number): number =>
  target > current ? Math.min(target, current + maxDelta) : Math.max(target, current - maxDelta)

export const advanceGrid = (grid: GridRuntimeInstance, dtSeconds: number, at: IsoTimestamp): void => {
  const startedAtMs = performance.now()
  const model = grid.definition.model
  const plan = topologyPlanForGrid(grid)
  const dynamicSeconds = Math.max(0, dtSeconds)
  grid.elapsedMs += dynamicSeconds * 1_000
  grid.tick += 1

  for (const load of model.loads) {
    const state = grid.loads.get(load.id)!
    state.demandMw = grid.definition.automation.loadProfiles ? profiledGridDemand(load, state.nominalDemandMw, at) : state.nominalDemandMw
    state.servedMw = state.demandMw
    state.shedMw = 0
  }

  const frequencyByIsland = new Map<string, number>()
  for (const island of plan.islands) {
    const generators = island.generators
    const loads = island.loads
    const storage = island.storage
    const previousHz = grid.frequencyByIsland.get(island.id) ?? model.nominalFrequencyHz
    const reserveMw = generators.reduce((sum, generator) => {
      const state = grid.generators.get(generator.id)!
      return sum + (gridGeneratorIsOnline(state.state) ? Math.min(state.reserveMw, Math.max(0, state.availableMw - state.dispatchMw)) : 0)
    }, 0)
    const downwardMw = generators.reduce((sum, generator) => {
      const state = grid.generators.get(generator.id)!
      return sum + (gridGeneratorIsOnline(state.state) ? state.dispatchMw : 0)
    }, 0)
    const requestedResponseMw = clamp(
      (model.nominalFrequencyHz - previousHz) * grid.definition.automation.primaryFrequencyResponseMwPerHz,
      -downwardMw,
      reserveMw,
    )
    for (const generator of generators) {
      const state = grid.generators.get(generator.id)!
      if (!gridGeneratorIsOnline(state.state)) {
        state.dispatchMw = ramp(state.dispatchMw, 0, generator.rampRateMwPerMinute * dynamicSeconds / 60)
        continue
      }
      const responseBasis = requestedResponseMw >= 0
        ? Math.min(state.reserveMw, Math.max(0, state.availableMw - state.dispatchMw))
        : state.dispatchMw
      const responseTotal = requestedResponseMw >= 0 ? reserveMw : downwardMw
      const responseMw = responseTotal <= 0 ? 0 : requestedResponseMw * responseBasis / responseTotal
      const target = clamp(state.targetMw + responseMw, 0, state.availableMw)
      const primaryRampMw = Math.abs(responseMw) * dynamicSeconds / 5
      state.dispatchMw = ramp(state.dispatchMw, target, Math.max(generator.rampRateMwPerMinute * dynamicSeconds / 60, primaryRampMw))
    }
    const internalGenerationMw = generators.reduce((sum, generator) => sum + grid.generators.get(generator.id)!.dispatchMw, 0)
    const externalConnections = [...grid.externalConnections.values()].filter(connection => island.busSet.has(connection.busId) && connection.connected)
    const externalGenerationMw = externalConnections.reduce((sum, connection) => sum + connection.systemActivePowerMw, 0)
    const inertiaSeconds = generators.reduce((sum, generator) => {
      const state = grid.generators.get(generator.id)!
      return sum + (gridGeneratorIsOnline(state.state) ? generator.inertiaSeconds * Math.max(0.1, state.dispatchMw / Math.max(1, generator.capacityMw)) : 0)
    }, 0) + externalConnections.reduce((sum, connection) => sum
      + (connection.definition.systemInertiaSeconds ?? 0)
        * Math.max(0.1, Math.max(0, connection.systemActivePowerMw) / Math.max(1, connection.definition.maximumSystemExportMw)), 0)
    for (const item of storage) {
      const state = grid.storage.get(item.id)!
      const canDischarge = state.stateOfChargeFraction > 0.02
      const canCharge = state.stateOfChargeFraction < 0.98
      state.dispatchMw = !grid.definition.automation.storageFrequencyResponse
        ? 0
        : previousHz < model.nominalFrequencyHz - 0.15 && canDischarge
          ? item.maxDischargeMw
          : previousHz > model.nominalFrequencyHz + 0.08 && canCharge
            ? -item.maxChargeMw
            : 0
      const energyMwh = state.dispatchMw >= 0
        ? state.dispatchMw * dynamicSeconds / 3_600 / 0.92
        : state.dispatchMw * dynamicSeconds / 3_600 * 0.92
      state.stateOfChargeFraction = clamp(state.stateOfChargeFraction - energyMwh / item.capacityMwh, 0, 1)
      state.state = state.dispatchMw > 0 ? 'discharging' : state.dispatchMw < 0 ? 'charging' : 'idle'
    }
    const shedFraction = !grid.definition.automation.underFrequencyLoadShedding
      ? 0
      : previousHz < model.nominalFrequencyHz - 0.85
        ? 0.45
        : previousHz < model.nominalFrequencyHz - 0.65
          ? 0.28
          : previousHz < model.nominalFrequencyHz - 0.35
            ? 0.12
            : 0
    for (const load of loads) {
      const state = grid.loads.get(load.id)!
      const interruptibleMw = Math.max(0, state.demandMw - load.criticalMw)
      state.shedMw = interruptibleMw * shedFraction
      state.servedMw = Math.max(load.criticalMw, state.demandMw - state.shedMw)
    }
    const servedLoadMw = loads.reduce((sum, load) => sum + grid.loads.get(load.id)!.servedMw, 0)
    const storageGenerationMw = storage.reduce((sum, item) => sum + grid.storage.get(item.id)!.dispatchMw, 0)
    const frequencyHz = gridFrequencyStep({
      nominalHz: model.nominalFrequencyHz,
      previousHz,
      generationMw: internalGenerationMw + externalGenerationMw + storageGenerationMw,
      loadMw: servedLoadMw,
      inertiaSeconds,
      dtSeconds: dynamicSeconds,
    })
    frequencyByIsland.set(island.id, frequencyHz)
    for (const load of loads) {
      const state = grid.loads.get(load.id)!
      state.frequencyHz = frequencyHz
      state.serviceState = state.servedMw <= 0 ? 'outage' : state.shedMw > 0 ? 'shed' : Math.abs(frequencyHz - model.nominalFrequencyHz) >= 0.2 ? 'constrained' : 'normal'
    }
    for (const item of storage) {
      const state = grid.storage.get(item.id)!
      state.frequencyHz = frequencyHz
    }
    for (const generator of generators) grid.generators.get(generator.id)!.frequencyHz = frequencyHz
  }
  grid.frequencyByIsland = frequencyByIsland

  const injections = new Map(model.buses.map(bus => [bus.id, 0]))
  for (const generator of model.generators) injections.set(generator.busId, (injections.get(generator.busId) ?? 0) + grid.generators.get(generator.id)!.dispatchMw)
  for (const load of model.loads) injections.set(load.busId, (injections.get(load.busId) ?? 0) - grid.loads.get(load.id)!.servedMw)
  for (const item of model.storage) injections.set(item.busId, (injections.get(item.busId) ?? 0) + grid.storage.get(item.id)!.dispatchMw)
  for (const connection of grid.externalConnections.values()) {
    if (connection.connected) injections.set(connection.busId, (injections.get(connection.busId) ?? 0) + connection.systemActivePowerMw)
  }

  const angles = solveGridAngles(plan, injections)

  const branchLoadingByBus = new Map<string, number>()
  for (const branch of model.branches) {
    const state = grid.branches.get(branch.id)!
    const flowMw = gridBranchIsClosed(grid, branch)
      ? ((angles.get(branch.fromBusId) ?? 0) - (angles.get(branch.toBusId) ?? 0)) / Math.max(0.0001, branch.reactancePu)
      : 0
    const ratingMw = branch.ratingMw * state.availability
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
  for (const connection of grid.externalConnections.values()) {
    if (connection.connected) generationByBus.set(connection.busId, (generationByBus.get(connection.busId) ?? 0) + connection.systemActivePowerMw)
  }
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

  const externalSupplyMw = [...grid.externalConnections.values()]
    .reduce((sum, connection) => sum + (connection.connected ? Math.max(0, connection.systemActivePowerMw) : 0), 0)
  const externalDemandMw = [...grid.externalConnections.values()]
    .reduce((sum, connection) => sum + (connection.connected ? Math.max(0, -connection.systemActivePowerMw) : 0), 0)
  const totalGenerationMw = [...grid.generators.values()].reduce((sum, item) => sum + item.dispatchMw, 0) + externalSupplyMw
  const totalLoadMw = [...grid.loads.values()].reduce((sum, item) => sum + item.demandMw, 0) + externalDemandMw
  const servedLoadMw = [...grid.loads.values()].reduce((sum, item) => sum + item.servedMw, 0) + externalDemandMw
  const unservedLoadMw = totalLoadMw - servedLoadMw
  const reserveMarginMw = [...grid.generators.values()].reduce((sum, item) => sum + (gridGeneratorIsOnline(item.state) ? Math.min(item.reserveMw, Math.max(0, item.availableMw - item.dispatchMw)) : 0), 0)
  const highestBranchLoadingPercent = [...grid.branches.values()].reduce((highest, item) => Math.max(highest, item.loadingPercent), 0)
  const lowestVoltagePu = [...busStates.values()].reduce((lowest, item) => Math.min(lowest, item.voltagePu), 1)
  const islandFrequencyWeights = plan.islands.map(island => {
    const internalSupplyMw = island.generators.reduce((sum, generator) => sum + grid.generators.get(generator.id)!.dispatchMw, 0)
      + island.storage.reduce((sum, item) => sum + Math.max(0, grid.storage.get(item.id)!.dispatchMw), 0)
    const internalDemandMw = island.loads.reduce((sum, load) => sum + grid.loads.get(load.id)!.servedMw, 0)
      + island.storage.reduce((sum, item) => sum + Math.max(0, -grid.storage.get(item.id)!.dispatchMw), 0)
    const external = [...grid.externalConnections.values()]
      .filter(connection => connection.connected && island.busSet.has(connection.busId))
      .reduce((totals, connection) => ({
        supplyMw: totals.supplyMw + Math.max(0, connection.systemActivePowerMw),
        demandMw: totals.demandMw + Math.max(0, -connection.systemActivePowerMw),
      }), { supplyMw: 0, demandMw: 0 })
    return {
      frequencyHz: frequencyByIsland.get(island.id) ?? model.nominalFrequencyHz,
      weightMw: Math.max(internalSupplyMw + external.supplyMw, internalDemandMw + external.demandMw),
    }
  })
  const totalFrequencyWeight = islandFrequencyWeights.reduce((sum, island) => sum + island.weightMw, 0)
  const frequencyHz = totalFrequencyWeight <= 0
    ? model.nominalFrequencyHz
    : islandFrequencyWeights.reduce((sum, island) => sum + island.frequencyHz * island.weightMw, 0) / totalFrequencyWeight
  const activeAlarmCount = [
    Math.abs(frequencyHz - model.nominalFrequencyHz) >= 0.15,
    highestBranchLoadingPercent >= 85,
    lowestVoltagePu < 0.95,
    unservedLoadMw > 0.1,
  ].filter(Boolean).length
  const activeIslandCount = islandFrequencyWeights.filter(island => island.weightMw > 0).length
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
  const tickDurationMs = performance.now() - startedAtMs
  grid.diagnostics.lastSuccessfulTickAt = at
  grid.diagnostics.lastTickDurationMs = tickDurationMs
  grid.diagnostics.maximumTickDurationMs = Math.max(grid.diagnostics.maximumTickDurationMs, tickDurationMs)
}
