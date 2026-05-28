import type { IsoTimestamp, ObjectId, OperationalObject } from '../../../core/model/index.ts'
import {
  electricGridPackDataSchema,
  type ElectricGridPackData,
  type GridBranchData,
  type GridBusState,
  type GridGeneratorData,
  type GridLoadData,
  type GridStorageData,
  type GridSubstationData,
  type GridSystemData,
} from '../model.ts'

export interface GridRuntimeState {
  readonly tick: number
  readonly frequencyHz: number
  readonly busStates: ReadonlyMap<string, GridBusState>
}

export interface SolvedGridState {
  readonly objects: ReadonlyArray<OperationalObject>
  readonly runtimeState: GridRuntimeState
  readonly summary: GridSystemData
}

interface ParsedGridObject {
  readonly object: OperationalObject
  readonly data: ElectricGridPackData
}

interface Island {
  readonly id: string
  readonly buses: ReadonlyArray<string>
}

const nominalFrequencyHz = 50
const defaultBusVoltagePu = 1
const defaultFrequencyHz = 50

const parseGridObjects = (objects: ReadonlyArray<OperationalObject>): ReadonlyArray<ParsedGridObject> =>
  objects.flatMap(object => {
    const parsed = electricGridPackDataSchema.safeParse(object.packData)
    return parsed.success ? [{ object, data: parsed.data }] : []
  })

const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, value))

const ramp = (current: number, target: number, maxDelta: number): number => {
  if (target > current) return Math.min(target, current + maxDelta)
  return Math.max(target, current - maxDelta)
}

const solveLinear = (
  matrix: number[][],
  rhs: number[],
): number[] => {
  const n = rhs.length
  const a = matrix.map((row, index) => [...row, rhs[index] ?? 0])
  for (let col = 0; col < n; col += 1) {
    let pivot = col
    for (let row = col + 1; row < n; row += 1) {
      if (Math.abs(a[row]?.[col] ?? 0) > Math.abs(a[pivot]?.[col] ?? 0)) pivot = row
    }
    if (Math.abs(a[pivot]?.[col] ?? 0) < 1e-9) continue
    if (pivot !== col) {
      const tmp = a[pivot]
      a[pivot] = a[col]!
      a[col] = tmp!
    }
    const pivotValue = a[col]?.[col] ?? 1
    for (let k = col; k <= n; k += 1) a[col]![k] = (a[col]?.[k] ?? 0) / pivotValue
    for (let row = 0; row < n; row += 1) {
      if (row === col) continue
      const factor = a[row]?.[col] ?? 0
      if (Math.abs(factor) < 1e-12) continue
      for (let k = col; k <= n; k += 1) {
        a[row]![k] = (a[row]?.[k] ?? 0) - factor * (a[col]?.[k] ?? 0)
      }
    }
  }
  return a.map(row => row[n] ?? 0)
}

const activeBranch = (branch: GridBranchData): boolean =>
  branch.state === 'closed' || branch.state === 'derated'

const islandsFor = (
  buses: ReadonlyArray<string>,
  branches: ReadonlyArray<GridBranchData>,
): ReadonlyArray<Island> => {
  const adjacency = new Map<string, Set<string>>()
  for (const bus of buses) adjacency.set(bus, new Set())
  for (const branch of branches) {
    if (!activeBranch(branch)) continue
    adjacency.get(branch.fromBusId)?.add(branch.toBusId)
    adjacency.get(branch.toBusId)?.add(branch.fromBusId)
  }
  const seen = new Set<string>()
  const islands: Island[] = []
  for (const bus of buses) {
    if (seen.has(bus)) continue
    const queue = [bus]
    const islandBuses: string[] = []
    seen.add(bus)
    while (queue.length > 0) {
      const current = queue.shift()!
      islandBuses.push(current)
      for (const next of adjacency.get(current) ?? []) {
        if (seen.has(next)) continue
        seen.add(next)
        queue.push(next)
      }
    }
    islands.push({ id: `island-${islands.length + 1}`, buses: islandBuses })
  }
  return islands
}

const busIdsFor = (items: ReadonlyArray<ParsedGridObject>): ReadonlyArray<string> => {
  const busIds = new Set<string>()
  for (const { data } of items) {
    if (data.type === 'grid_substation') busIds.add(data.busId)
    if (data.type === 'grid_generator') busIds.add(data.busId)
    if (data.type === 'grid_load') busIds.add(data.busId)
    if (data.type === 'grid_storage') busIds.add(data.busId)
    if (data.type === 'grid_branch') {
      busIds.add(data.fromBusId)
      busIds.add(data.toBusId)
    }
  }
  return [...busIds].sort()
}

const injectionByBus = (
  buses: ReadonlyArray<string>,
  generators: ReadonlyArray<GridGeneratorData>,
  loads: ReadonlyArray<GridLoadData>,
  storage: ReadonlyArray<GridStorageData>,
): Map<string, number> => {
  const injections = new Map(buses.map(bus => [bus, 0]))
  for (const generator of generators) {
    injections.set(generator.busId, (injections.get(generator.busId) ?? 0) + generator.dispatchMw)
  }
  for (const item of storage) {
    injections.set(item.busId, (injections.get(item.busId) ?? 0) + item.dispatchMw)
  }
  for (const load of loads) {
    injections.set(load.busId, (injections.get(load.busId) ?? 0) - load.servedMw)
  }
  return injections
}

const solveAngles = (
  island: Island,
  branches: ReadonlyArray<GridBranchData>,
  injections: ReadonlyMap<string, number>,
): Map<string, number> => {
  if (island.buses.length <= 1) return new Map(island.buses.map(bus => [bus, 0]))
  const slack = island.buses[0]!
  const nonSlack = island.buses.filter(bus => bus !== slack)
  const indexByBus = new Map(nonSlack.map((bus, index) => [bus, index]))
  const matrix = nonSlack.map(() => nonSlack.map(() => 0))
  const rhs = nonSlack.map(bus => injections.get(bus) ?? 0)
  for (const branch of branches) {
    if (!activeBranch(branch)) continue
    if (!island.buses.includes(branch.fromBusId) || !island.buses.includes(branch.toBusId)) continue
    const susceptance = 1 / Math.max(0.0001, branch.reactancePu)
    const i = indexByBus.get(branch.fromBusId)
    const j = indexByBus.get(branch.toBusId)
    if (i !== undefined) {
      const row = matrix[i]
      if (row) row[i] = (row[i] ?? 0) + susceptance
    }
    if (j !== undefined) {
      const row = matrix[j]
      if (row) row[j] = (row[j] ?? 0) + susceptance
    }
    if (i !== undefined && j !== undefined) {
      const iRow = matrix[i]
      const jRow = matrix[j]
      if (iRow) iRow[j] = (iRow[j] ?? 0) - susceptance
      if (jRow) jRow[i] = (jRow[i] ?? 0) - susceptance
    }
  }
  const solved = solveLinear(matrix, rhs)
  return new Map([
    [slack, 0],
    ...nonSlack.map((bus, index) => [bus, solved[index] ?? 0] as const),
  ])
}

const totalByBus = <T extends { readonly busId: string }>(
  items: ReadonlyArray<T>,
  amount: (item: T) => number,
): Map<string, number> => {
  const totals = new Map<string, number>()
  for (const item of items) totals.set(item.busId, (totals.get(item.busId) ?? 0) + amount(item))
  return totals
}

const islandIdForBus = (islands: ReadonlyArray<Island>, busId: string): string =>
  islands.find(island => island.buses.includes(busId))?.id ?? 'island-unknown'

const voltageForBus = (config: {
  readonly busId: string
  readonly generationMw: number
  readonly servedLoadMw: number
  readonly reactiveDemandMvar: number
  readonly branchLoadingPercent: number
}): number => {
  const loadStress = config.servedLoadMw <= 0 ? 0 : Math.min(0.055, config.reactiveDemandMvar / Math.max(1, config.servedLoadMw) * 0.035)
  const flowStress = Math.max(0, config.branchLoadingPercent - 82) * 0.0015
  const generationSupport = Math.min(0.018, config.generationMw / Math.max(1, config.servedLoadMw + 100) * 0.01)
  return clamp(defaultBusVoltagePu - loadStress - flowStress + generationSupport, 0.88, 1.06)
}

const frequencyStep = (config: {
  readonly previousHz: number
  readonly generationMw: number
  readonly loadMw: number
  readonly reserveMw: number
  readonly inertiaSeconds: number
  readonly dtSeconds: number
}): number => {
  const imbalanceMw = config.generationMw - config.loadMw
  const droopMw = clamp((nominalFrequencyHz - config.previousHz) * 1800, -config.reserveMw, config.reserveMw)
  const dampingMw = (config.previousHz - nominalFrequencyHz) * 240
  const denominator = Math.max(500, 2 * Math.max(1, config.inertiaSeconds) * 900)
  const df = (nominalFrequencyHz / denominator) * (imbalanceMw + droopMw - dampingMw) * config.dtSeconds
  return clamp(config.previousHz + df, 48.4, 50.6)
}

const updateObject = (
  object: OperationalObject,
  data: ElectricGridPackData,
  at: IsoTimestamp,
): OperationalObject => {
  const previous = JSON.stringify(object.packData)
  const next = JSON.stringify(data)
  if (previous === next) return object
  return {
    ...object,
    revision: object.revision + 1,
    operational: {
      ...object.operational,
      status: statusForData(data),
      priority: priorityForData(data),
    },
    alerts: alertsForData(object.id, data, at),
    timestamps: { ...object.timestamps, updatedAt: at },
    packData: data,
  }
}

const statusForData = (data: ElectricGridPackData): string => {
  if (data.type === 'grid_system') return data.activeAlarmCount > 0 ? 'constrained' : 'normal'
  if (data.type === 'grid_branch') {
    if (data.state === 'open' || data.state === 'faulted') return data.state
    if (data.loadingPercent >= 100) return 'overloaded'
    if (data.loadingPercent >= 85) return 'high_loading'
    return 'normal'
  }
  if (data.type === 'grid_generator') return data.state
  if (data.type === 'grid_load') return data.serviceState
  if (data.type === 'grid_substation') return data.state
  if (data.type === 'grid_storage') return data.state
  if (data.type === 'grid_market_area') return data.constrained ? 'constrained' : 'normal'
  return 'normal'
}

const priorityForData = (data: ElectricGridPackData): NonNullable<OperationalObject['operational']['priority']> => {
  if (data.type === 'grid_system') return data.activeAlarmCount > 0 ? 'high' : 'normal'
  if (data.type === 'grid_branch' && data.loadingPercent >= 100) return 'critical'
  if (data.type === 'grid_branch' && data.loadingPercent >= 85) return 'high'
  if (data.type === 'grid_load' && data.serviceState === 'outage') return 'critical'
  if (data.type === 'grid_load' && data.serviceState !== 'normal') return data.priority === 'critical' ? 'critical' : 'high'
  if (data.type === 'grid_substation' && data.state !== 'normal') return data.state === 'outage' ? 'critical' : 'high'
  return 'normal'
}

const alertsForData = (
  objectId: ObjectId,
  data: ElectricGridPackData,
  at: IsoTimestamp,
): OperationalObject['alerts'] => {
  if (data.type === 'grid_branch' && data.loadingPercent >= 100) {
    return [{ id: `${objectId}:overload`, kind: 'grid_branch_overload', severity: 'critical', message: `Branch overloaded at ${Math.round(data.loadingPercent)}%`, raisedAt: at, acknowledged: false }]
  }
  if (data.type === 'grid_branch' && data.loadingPercent >= 85) {
    return [{ id: `${objectId}:high-loading`, kind: 'grid_branch_loading', severity: 'warning', message: `High branch loading at ${Math.round(data.loadingPercent)}%`, raisedAt: at, acknowledged: false }]
  }
  if (data.type === 'grid_system' && (data.frequencyHz < 49.85 || data.frequencyHz > 50.15)) {
    return [{ id: `${objectId}:frequency`, kind: 'grid_frequency', severity: data.frequencyHz < 49.5 ? 'critical' : 'warning', message: `Frequency ${data.frequencyHz.toFixed(2)} Hz`, raisedAt: at, acknowledged: false }]
  }
  if (data.type === 'grid_load' && data.serviceState !== 'normal') {
    return [{ id: `${objectId}:service`, kind: 'grid_supply', severity: data.serviceState === 'outage' ? 'critical' : 'warning', message: `${data.serviceState.replaceAll('_', ' ')}: ${Math.round(data.shedMw)} MW shed`, raisedAt: at, acknowledged: false }]
  }
  if (data.type === 'grid_substation' && data.voltagePu < 0.94) {
    return [{ id: `${objectId}:voltage`, kind: 'grid_voltage', severity: data.voltagePu < 0.9 ? 'critical' : 'warning', message: `Voltage ${data.voltagePu.toFixed(2)} pu`, raisedAt: at, acknowledged: false }]
  }
  return []
}

export const solveGrid = (config: {
  readonly objects: ReadonlyArray<OperationalObject>
  readonly runtimeState: GridRuntimeState | null
  readonly dtSeconds: number
  readonly at: IsoTimestamp
}): SolvedGridState => {
  const parsed = parseGridObjects(config.objects)
  const buses = busIdsFor(parsed)
  const branches = parsed.flatMap(item => item.data.type === 'grid_branch' ? [item.data] : [])
  const generators = parsed.flatMap(item => item.data.type === 'grid_generator' ? [item.data] : [])
  const loads = parsed.flatMap(item => item.data.type === 'grid_load' ? [item.data] : [])
  const storage = parsed.flatMap(item => item.data.type === 'grid_storage' ? [item.data] : [])
  const islands = islandsFor(buses, branches)
  const availableReserveMw = generators.reduce((sum, generator) => sum + generator.reserveMw, 0)
  const previousFrequency = config.runtimeState?.frequencyHz ?? defaultFrequencyHz
  const generationBeforeRamp = generators.reduce((sum, generator) => sum + generator.dispatchMw, 0)
  const requestedLoadMw = loads.reduce((sum, load) => sum + load.demandMw, 0)
  const inertiaSeconds = generators.reduce((sum, generator) => sum + generator.inertiaSeconds * Math.max(0.1, generator.dispatchMw / Math.max(1, generator.capacityMw)), 0)
  const frequencyHz = frequencyStep({
    previousHz: previousFrequency,
    generationMw: generationBeforeRamp,
    loadMw: requestedLoadMw,
    reserveMw: availableReserveMw,
    inertiaSeconds,
    dtSeconds: config.dtSeconds,
  })
  const underFrequencyShedFraction = frequencyHz < 49.15 ? 0.45 : frequencyHz < 49.35 ? 0.28 : frequencyHz < 49.65 ? 0.12 : 0

  const solvedLoads = loads.map(load => {
    const maxShedMw = load.interruptibleMw * underFrequencyShedFraction
    const servedMw = Math.max(load.criticalMw, load.demandMw - maxShedMw)
    return {
      ...load,
      servedMw,
      shedMw: Math.max(0, load.demandMw - servedMw),
      frequencyHz,
      serviceState: servedMw <= 0 ? 'outage' : servedMw < load.demandMw ? 'shed' : frequencyHz < 49.8 ? 'constrained' : 'normal',
    } satisfies GridLoadData
  })

  const servedLoadMw = solvedLoads.reduce((sum, load) => sum + load.servedMw, 0)
  const generationTargetMw = servedLoadMw + Math.max(0, (nominalFrequencyHz - frequencyHz) * 140)
  const onlineGenerators = generators.filter(generator => generator.state === 'online' || generator.state === 'derated')
  const onlineCapacity = onlineGenerators.reduce((sum, generator) => sum + Math.min(generator.availableMw, generator.capacityMw), 0)
  const solvedGenerators = generators.map(generator => {
    const desired = generator.state === 'online' || generator.state === 'derated'
      ? Math.min(generator.availableMw, onlineCapacity > 0 ? generationTargetMw * Math.min(generator.availableMw, generator.capacityMw) / onlineCapacity : generator.targetMw)
      : 0
    const maxDelta = generator.rampRateMwPerMinute * config.dtSeconds / 60
    return {
      ...generator,
      dispatchMw: ramp(generator.dispatchMw, desired, maxDelta),
    } satisfies GridGeneratorData
  })

  const generationMw = solvedGenerators.reduce((sum, generator) => sum + generator.dispatchMw, 0)
  const solvedStorage = storage.map(item => {
    const dispatchMw = frequencyHz < 49.85
      ? Math.min(item.maxDischargeMw, (1 - item.stateOfChargeFraction) < 0.98 ? item.maxDischargeMw : 0)
      : frequencyHz > 50.08
        ? -Math.min(item.maxChargeMw, item.maxChargeMw)
        : 0
    return {
      ...item,
      dispatchMw,
      state: dispatchMw > 0 ? 'discharging' : dispatchMw < 0 ? 'charging' : 'idle',
    } satisfies GridStorageData
  })

  const injections = injectionByBus(buses, solvedGenerators, solvedLoads, solvedStorage)
  const angles = new Map<string, number>()
  for (const island of islands) {
    for (const [bus, angle] of solveAngles(island, branches, injections)) angles.set(bus, angle)
  }
  const generationByBus = totalByBus(solvedGenerators, generator => generator.dispatchMw)
  const loadByBus = totalByBus(solvedLoads, load => load.servedMw)
  const reactiveByBus = totalByBus(solvedLoads, load => load.reactiveDemandMvar)
  const roughBranchLoadingByBus = new Map<string, number>()
  const solvedBranches = branches.map(branch => {
    const flowMw = activeBranch(branch)
      ? (angles.get(branch.fromBusId) ?? 0) - (angles.get(branch.toBusId) ?? 0)
      : 0
    const scaledFlowMw = flowMw / Math.max(0.0001, branch.reactancePu)
    const ratingMw = branch.state === 'derated' ? branch.ratingMw * branch.availability : branch.ratingMw
    const loadingPercent = Math.abs(scaledFlowMw) / Math.max(1, ratingMw) * 100
    roughBranchLoadingByBus.set(branch.fromBusId, Math.max(roughBranchLoadingByBus.get(branch.fromBusId) ?? 0, loadingPercent))
    roughBranchLoadingByBus.set(branch.toBusId, Math.max(roughBranchLoadingByBus.get(branch.toBusId) ?? 0, loadingPercent))
    return {
      ...branch,
      flowMw: scaledFlowMw,
      loadingPercent,
      frequencyHz,
      lossesMw: Math.abs(scaledFlowMw) * branch.resistancePu * 0.006,
    } satisfies GridBranchData
  })

  const busStates = new Map<string, GridBusState>()
  for (const bus of buses) {
    const voltagePu = voltageForBus({
      busId: bus,
      generationMw: generationByBus.get(bus) ?? 0,
      servedLoadMw: loadByBus.get(bus) ?? 0,
      reactiveDemandMvar: reactiveByBus.get(bus) ?? 0,
      branchLoadingPercent: roughBranchLoadingByBus.get(bus) ?? 0,
    })
    busStates.set(bus, {
      busId: bus,
      nominalKv: parsed.flatMap(item => item.data.type === 'grid_substation' && item.data.busId === bus ? [item.data.nominalKv] : [])[0] ?? 132,
      voltagePu,
      frequencyHz,
      angleRad: angles.get(bus) ?? 0,
      islandId: islandIdForBus(islands, bus),
      netInjectionMw: injections.get(bus) ?? 0,
    })
  }

  const solvedSubstations = parsed.flatMap(item => {
    if (item.data.type !== 'grid_substation') return []
    const busId = item.data.busId
    const bus = busStates.get(busId)
    const connectedBranchCount = solvedBranches.filter(branch => branch.fromBusId === busId || branch.toBusId === busId).length
    const loadingPercent = Math.max(0, roughBranchLoadingByBus.get(busId) ?? 0)
    const voltagePu = bus?.voltagePu ?? defaultBusVoltagePu
    return [{
      ...item.data,
      voltagePu,
      frequencyHz,
      connectedBranchCount,
      loadingPercent,
      reactiveMarginMvar: Math.max(-200, 260 - (reactiveByBus.get(item.data.busId) ?? 0) - Math.max(0, loadingPercent - 80) * 2),
      state: voltagePu < 0.9 ? 'constrained' : voltagePu < 0.95 ? 'voltage_watch' : islands.length > 1 ? 'islanded' : 'normal',
    } satisfies GridSubstationData]
  })

  const highestBranchLoadingPercent = solvedBranches.reduce((highest, branch) => Math.max(highest, branch.loadingPercent), 0)
  const lowestVoltagePu = [...busStates.values()].reduce((lowest, bus) => Math.min(lowest, bus.voltagePu), 1)
  const totalShedMw = solvedLoads.reduce((sum, load) => sum + load.shedMw, 0)
  const activeAlarmCount = [
    frequencyHz < 49.85 || frequencyHz > 50.15,
    highestBranchLoadingPercent >= 85,
    lowestVoltagePu < 0.95,
    totalShedMw > 0,
  ].filter(Boolean).length
  const summary: GridSystemData = {
    type: 'grid_system',
    schemaVersion: 1,
    assetKind: 'system',
    nominalFrequencyHz,
    frequencyHz,
    totalGenerationMw: generationMw,
    totalLoadMw: requestedLoadMw,
    servedLoadMw,
    unservedLoadMw: totalShedMw,
    reserveMarginMw: availableReserveMw - Math.max(0, requestedLoadMw - generationMw),
    highestBranchLoadingPercent,
    lowestVoltagePu,
    activeIslandCount: islands.length,
    activeAlarmCount,
    tick: (config.runtimeState?.tick ?? 0) + 1,
    updatedAt: config.at,
    busStates: [...busStates.values()],
    provenance: {
      method: 'configured',
      sourceId: 'electric-grid-runtime',
      confidence: 'medium',
    },
  }

  const dataByObjectId = new Map<string, ElectricGridPackData>()
  let generatorIndex = 0
  let loadIndex = 0
  let storageIndex = 0
  let branchIndex = 0
  let substationIndex = 0
  for (const item of parsed) {
    if (item.data.type === 'grid_system') dataByObjectId.set(item.object.id, summary)
    if (item.data.type === 'grid_generator') dataByObjectId.set(item.object.id, solvedGenerators[generatorIndex++] ?? item.data)
    if (item.data.type === 'grid_load') dataByObjectId.set(item.object.id, solvedLoads[loadIndex++] ?? item.data)
    if (item.data.type === 'grid_storage') dataByObjectId.set(item.object.id, solvedStorage[storageIndex++] ?? item.data)
    if (item.data.type === 'grid_branch') dataByObjectId.set(item.object.id, solvedBranches[branchIndex++] ?? item.data)
    if (item.data.type === 'grid_substation') dataByObjectId.set(item.object.id, solvedSubstations[substationIndex++] ?? item.data)
    if (item.data.type === 'grid_market_area') {
      dataByObjectId.set(item.object.id, {
        ...item.data,
        generationMw,
        loadMw: servedLoadMw,
        netExportMw: generationMw - servedLoadMw,
        constrained: activeAlarmCount > 0,
      })
    }
  }

  return {
    objects: config.objects.map(object => {
      const data = dataByObjectId.get(object.id)
      return data ? updateObject(object, data, config.at) : object
    }),
    runtimeState: {
      tick: summary.tick,
      frequencyHz,
      busStates,
    },
    summary,
  }
}
