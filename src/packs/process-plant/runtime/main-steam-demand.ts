import type { CompiledComponent, CompiledProcessLink } from '../graph/index.ts'
import type { CompiledProcessPlantSystem } from '../process-systems.ts'
import { componentVariablePath } from './behavior-contract.ts'
import { parameterNumber } from './component-helpers.ts'
import { combinedValveFactorForLink, type LinkBehaviorReadContext } from './link-flow-helpers.ts'
import { mainSteamTopologyForSystem, type ProcessLinkPath } from './topology-cache.ts'

const sourceLinkService = 'mainSteam' as CompiledProcessLink['service']

const turbineSteamDemandKgPerS = (
  turbine: CompiledComponent,
  context: LinkBehaviorReadContext,
): number => {
  const demandPath = componentVariablePath(turbine, 'steamDemandKgPerS')
  if (context.has(demandPath)) return context.readNumber(demandPath)
  return context.readNumber(componentVariablePath(turbine, 'loadFraction')) * parameterNumber(turbine, 'nominalSteamFlowKgPerS')
}

const pathAvailability = (
  system: CompiledProcessPlantSystem,
  paths: ReadonlyArray<ProcessLinkPath>,
  context: LinkBehaviorReadContext,
): number => {
  let best = 0
  for (const path of paths) {
    let availability = 1
    for (const link of path) {
      availability *= combinedValveFactorForLink(system, link, context)
      if (availability <= 0) break
    }
    best = Math.max(best, availability)
  }
  return best
}

const sourceAvailabilityToTurbine = (
  system: CompiledProcessPlantSystem,
  sourceLink: CompiledProcessLink,
  turbine: CompiledComponent,
  context: LinkBehaviorReadContext,
): number => {
  const topology = mainSteamTopologyForSystem(system)
  const paths = topology.pathSets.find(pathSet => pathSet.sourceLink.index === sourceLink.index && pathSet.turbine.index === turbine.index)?.paths
  if (!paths || paths.length === 0) return 0
  return combinedValveFactorForLink(system, sourceLink, context)
    * pathAvailability(system, paths, context)
}

export const topologyAwareMainSteamDemandForSourceLink = (
  system: CompiledProcessPlantSystem,
  sourceLink: CompiledProcessLink,
  context: LinkBehaviorReadContext,
): number => {
  let demand = 0
  const topology = mainSteamTopologyForSystem(system)
  for (const turbine of topology.turbines) {
    const sourceAvailability = sourceAvailabilityToTurbine(system, sourceLink, turbine, context)
    if (sourceAvailability <= 0) continue
    let totalAvailability = 0
    for (const candidateSource of topology.sourceLinks) {
      totalAvailability += sourceAvailabilityToTurbine(system, candidateSource, turbine, context)
    }
    if (totalAvailability <= 0) continue
    demand += turbineSteamDemandKgPerS(turbine, context) * sourceAvailability / totalAvailability
  }
  return demand
}

const isReliefOrSafetyValve = (component: CompiledComponent | undefined): boolean => {
  if (component?.kind !== 'steamValve') return false
  const mode = (component.parameters as Record<string, unknown>).valveMode
  return mode === 'relief' || mode === 'safety'
}

const collectReleasePaths = (
  system: CompiledProcessPlantSystem,
  fromComponentIndex: number,
  visited: ReadonlySet<number>,
  hasReleaseValve: boolean,
): ReadonlyArray<ProcessLinkPath> => {
  if (visited.has(fromComponentIndex)) return []
  const component = system.graph.components[fromComponentIndex]
  if (component?.kind === 'containmentVolume' && hasReleaseValve) return [[]]

  const nextVisited = new Set(visited)
  nextVisited.add(fromComponentIndex)
  const paths: ProcessLinkPath[] = []
  for (const linkIndex of system.graph.outgoingLinksByComponent[fromComponentIndex] ?? []) {
    const link = system.graph.links[linkIndex]
    if (!link || link.kind !== 'fluidFlow' || link.service !== sourceLinkService) continue
    const toComponent = system.graph.components[link.toComponentIndex]
    const nextHasReleaseValve = hasReleaseValve || isReliefOrSafetyValve(toComponent)
    for (const downstreamPath of collectReleasePaths(system, link.toComponentIndex, nextVisited, nextHasReleaseValve)) {
      paths.push([link, ...downstreamPath])
    }
  }
  return paths
}

export const topologyAwareMainSteamReleaseAvailabilityForSourceLink = (
  system: CompiledProcessPlantSystem,
  sourceLink: CompiledProcessLink,
  context: LinkBehaviorReadContext,
): number => {
  const paths = collectReleasePaths(system, sourceLink.toComponentIndex, new Set(), false)
  if (paths.length === 0) return 0
  return combinedValveFactorForLink(system, sourceLink, context) * pathAvailability(system, paths, context)
}
