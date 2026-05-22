import type { CompiledComponent, CompiledPlantGraph, CompiledProcessLink, ConnectionService } from '../graph/index.ts'
import { primaryLoopIdForLink, primaryLoopIdForPump } from '../graph/index.ts'
import type { CompiledProcessPlantSystem } from '../process-systems.ts'
import { physicalNumber } from './process-link-physical.ts'

export type ProcessLinkPath = ReadonlyArray<CompiledProcessLink>

export interface MainSteamPathSet {
  readonly sourceLink: CompiledProcessLink
  readonly turbine: CompiledComponent
  readonly paths: ReadonlyArray<ProcessLinkPath>
}

export interface MainSteamTopology {
  readonly sourceLinks: ReadonlyArray<CompiledProcessLink>
  readonly turbines: ReadonlyArray<CompiledComponent>
  readonly pathSets: ReadonlyArray<MainSteamPathSet>
}

const downstreamDemandPathCache = new WeakMap<CompiledProcessPlantSystem, Map<number, ReadonlyArray<ProcessLinkPath>>>()
const mainSteamTopologyCache = new WeakMap<CompiledProcessPlantSystem, MainSteamTopology>()
const primaryLoopResistanceCache = new WeakMap<CompiledPlantGraph, ReadonlyMap<number, number>>()

const serviceMatches = (link: CompiledProcessLink, service: CompiledProcessLink['service']): boolean =>
  service !== undefined && link.service === service

const isFluidDemandTerminal = (
  system: CompiledProcessPlantSystem,
  componentIndex: number,
  service: CompiledProcessLink['service'],
): boolean => {
  const component = system.graph.components[componentIndex]
  if (!component) return false
  if ((service === 'feedwater' || service === 'auxFeedwater') && component.kind === 'steamGenerator') return true
  if (service === 'condensate' && component.kind === 'processTank') return true
  return false
}

const collectDownstreamDemandPaths = (
  system: CompiledProcessPlantSystem,
  componentIndex: number,
  service: CompiledProcessLink['service'],
  visited: ReadonlySet<number>,
): ReadonlyArray<ProcessLinkPath> => {
  if (service === undefined) return []
  if (isFluidDemandTerminal(system, componentIndex, service)) return [[]]
  if (visited.has(componentIndex)) return []

  const nextVisited = new Set(visited)
  nextVisited.add(componentIndex)
  const paths: ProcessLinkPath[] = []
  for (const linkIndex of system.graph.outgoingLinksByComponent[componentIndex] ?? []) {
    const link = system.graph.links[linkIndex]
    if (!link || link.kind !== 'fluidFlow' || !serviceMatches(link, service)) continue
    for (const downstreamPath of collectDownstreamDemandPaths(system, link.toComponentIndex, service, nextVisited)) {
      paths.push([link, ...downstreamPath])
    }
  }
  return paths
}

export const downstreamDemandPathsForLink = (
  system: CompiledProcessPlantSystem,
  link: CompiledProcessLink,
): ReadonlyArray<ProcessLinkPath> => {
  let cachedForSystem = downstreamDemandPathCache.get(system)
  if (!cachedForSystem) {
    cachedForSystem = new Map()
    downstreamDemandPathCache.set(system, cachedForSystem)
  }
  const cached = cachedForSystem.get(link.index)
  if (cached !== undefined) return cached
  const paths = collectDownstreamDemandPaths(system, link.toComponentIndex, link.service, new Set())
  cachedForSystem.set(link.index, paths)
  return paths
}

const isMainSteamFlowLink = (link: CompiledProcessLink): boolean =>
  link.kind === 'fluidFlow' && serviceMatches(link, 'mainSteam' as ConnectionService)

const collectMainSteamPaths = (
  system: CompiledProcessPlantSystem,
  fromComponentIndex: number,
  targetComponentIndex: number,
  visited: ReadonlySet<number>,
): ReadonlyArray<ProcessLinkPath> => {
  if (fromComponentIndex === targetComponentIndex) return [[]]
  if (visited.has(fromComponentIndex)) return []

  const nextVisited = new Set(visited)
  nextVisited.add(fromComponentIndex)
  const paths: ProcessLinkPath[] = []
  for (const linkIndex of system.graph.outgoingLinksByComponent[fromComponentIndex] ?? []) {
    const link = system.graph.links[linkIndex]
    if (!link || !isMainSteamFlowLink(link)) continue
    for (const downstreamPath of collectMainSteamPaths(system, link.toComponentIndex, targetComponentIndex, nextVisited)) {
      paths.push([link, ...downstreamPath])
    }
  }
  return paths
}

export const mainSteamTopologyForSystem = (
  system: CompiledProcessPlantSystem,
): MainSteamTopology => {
  const cached = mainSteamTopologyCache.get(system)
  if (cached) return cached

  const sourceLinks = system.graph.links.filter(link => {
    const fromComponent = system.graph.components[link.fromComponentIndex]
    return fromComponent?.kind === 'steamGenerator' && isMainSteamFlowLink(link)
  })
  const turbines = system.graph.components.filter(component => component.kind === 'turbineLoadSink')
  const pathSets: MainSteamPathSet[] = []
  for (const sourceLink of sourceLinks) {
    for (const turbine of turbines) {
      const paths = collectMainSteamPaths(system, sourceLink.toComponentIndex, turbine.index, new Set())
      if (paths.length === 0) continue
      pathSets.push({ sourceLink, turbine, paths })
    }
  }

  const topology = { sourceLinks, turbines, pathSets }
  mainSteamTopologyCache.set(system, topology)
  return topology
}

const primaryLoopResistanceByPumpIndex = (
  graph: CompiledPlantGraph,
): ReadonlyMap<number, number> => {
  const cached = primaryLoopResistanceCache.get(graph)
  if (cached) return cached

  const resistanceByPumpIndex = new Map<number, number>()
  for (const component of graph.components) {
    const loopId = primaryLoopIdForPump(component)
    if (loopId === null) continue
    let nominalPressureDropMPa = 0
    for (const link of graph.links) {
      if (primaryLoopIdForLink(graph, link) !== loopId) continue
      nominalPressureDropMPa += Math.max(0, physicalNumber(link, 'nominalResistance', 0))
    }
    resistanceByPumpIndex.set(component.index, nominalPressureDropMPa / 0.5)
  }

  primaryLoopResistanceCache.set(graph, resistanceByPumpIndex)
  return resistanceByPumpIndex
}

export const primaryLoopLinkResistanceCoefficient = (
  component: CompiledComponent,
  graph: CompiledPlantGraph,
): number => primaryLoopResistanceByPumpIndex(graph).get(component.index) ?? 0
