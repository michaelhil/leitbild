import type { GridBranchDefinition } from '../grid-model.ts'
import type { GridLinearFactor, GridRuntimeInstance, GridTopologyIsland, GridTopologyPlan } from './instance.ts'

export const gridBranchIsClosed = (grid: GridRuntimeInstance, branch: GridBranchDefinition): boolean =>
  grid.branches.get(branch.id)?.state === 'closed'

const topologySignature = (grid: GridRuntimeInstance): string => grid.definition.model.branches
  .map(branch => `${branch.id}:${gridBranchIsClosed(grid, branch) ? '1' : '0'}`)
  .join('|')

const islandsFor = (grid: GridRuntimeInstance): ReadonlyArray<GridTopologyIsland> => {
  const adjacency = new Map(grid.definition.model.buses.map(bus => [bus.id, new Set<string>()]))
  for (const branch of grid.definition.model.branches) {
    if (!gridBranchIsClosed(grid, branch)) continue
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
    const busSet = new Set(buses)
    islands.push({
      id,
      buses,
      busSet,
      branches: grid.definition.model.branches.filter(branch => gridBranchIsClosed(grid, branch) && busSet.has(branch.fromBusId) && busSet.has(branch.toBusId)),
      generators: buses.flatMap(busId => grid.definition.index.generatorsByBus.get(busId) ?? []),
      loads: buses.flatMap(busId => grid.definition.index.loadsByBus.get(busId) ?? []),
      storage: buses.flatMap(busId => grid.definition.index.storageByBus.get(busId) ?? []),
    })
  }
  return islands
}

const factorFor = (island: GridTopologyIsland): GridLinearFactor => {
  const buses = island.buses.slice(1)
  const indexByBus = new Map(buses.map((bus, index) => [bus, index]))
  const matrix = buses.map(() => buses.map(() => 0))
  for (const branch of island.branches) {
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

export const topologyPlanForGrid = (grid: GridRuntimeInstance): GridTopologyPlan => {
  const signature = topologySignature(grid)
  if (grid.topologyPlan?.signature === signature) return grid.topologyPlan
  const startedAtMs = performance.now()
  const islands = islandsFor(grid)
  const factors = new Map(islands.map(island => [island.id, factorFor(island)]))
  const islandIdByBus = new Map(islands.flatMap(island => island.buses.map(bus => [bus, island.id] as const)))
  const plan = { signature, islands, factors, islandIdByBus }
  grid.topologyPlan = plan
  grid.diagnostics.topologyRebuildCount += 1
  grid.diagnostics.lastTopologyRebuildDurationMs = performance.now() - startedAtMs
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

export const solveGridAngles = (plan: GridTopologyPlan, injections: ReadonlyMap<string, number>): ReadonlyMap<string, number> => {
  const angles = new Map<string, number>()
  for (const island of plan.islands) {
    const factor = plan.factors.get(island.id)!
    const solved = solveFactor(factor, factor.buses.map(bus => injections.get(bus) ?? 0))
    angles.set(island.buses[0]!, 0)
    for (let index = 0; index < factor.buses.length; index += 1) angles.set(factor.buses[index]!, solved[index] ?? 0)
  }
  return angles
}
