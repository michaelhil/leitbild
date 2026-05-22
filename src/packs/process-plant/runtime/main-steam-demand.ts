import type { CompiledComponent, CompiledProcessLink, ConnectionService } from '../graph/index.ts'
import type { CompiledProcessPlantSystem } from '../process-systems.ts'
import { componentVariablePath } from './behavior-contract.ts'
import { parameterNumber } from './component-helpers.ts'
import { combinedValveFactorForLink, serviceMatches, type LinkBehaviorReadContext } from './link-flow-helpers.ts'

const isMainSteamFlowLink = (link: CompiledProcessLink): boolean =>
  link.kind === 'fluidFlow' && serviceMatches(link, 'mainSteam' as ConnectionService)

const mainSteamSourceLinks = (system: CompiledProcessPlantSystem): ReadonlyArray<CompiledProcessLink> =>
  system.graph.links.filter(link => {
    const fromComponent = system.graph.components[link.fromComponentIndex]
    return fromComponent?.kind === 'steamGenerator' && isMainSteamFlowLink(link)
  })

const turbineSteamDemandKgPerS = (
  turbine: CompiledComponent,
  context: LinkBehaviorReadContext,
): number => context.readNumber(componentVariablePath(turbine, 'loadFraction')) * parameterNumber(turbine, 'nominalSteamFlowKgPerS')

const pathAvailabilityToComponent = (
  system: CompiledProcessPlantSystem,
  fromComponentIndex: number,
  targetComponentIndex: number,
  context: LinkBehaviorReadContext,
  visited: ReadonlySet<number>,
): number => {
  if (fromComponentIndex === targetComponentIndex) return 1
  if (visited.has(fromComponentIndex)) return 0
  const nextVisited = new Set(visited)
  nextVisited.add(fromComponentIndex)
  let best = 0
  for (const linkIndex of system.graph.outgoingLinksByComponent[fromComponentIndex] ?? []) {
    const link = system.graph.links[linkIndex]
    if (!link || !isMainSteamFlowLink(link)) continue
    const downstreamAvailability = pathAvailabilityToComponent(system, link.toComponentIndex, targetComponentIndex, context, nextVisited)
    if (downstreamAvailability <= 0) continue
    best = Math.max(best, combinedValveFactorForLink(system, link, context) * downstreamAvailability)
  }
  return best
}

const sourceAvailabilityToTurbine = (
  system: CompiledProcessPlantSystem,
  sourceLink: CompiledProcessLink,
  turbine: CompiledComponent,
  context: LinkBehaviorReadContext,
): number => {
  if (!isMainSteamFlowLink(sourceLink)) return 0
  return combinedValveFactorForLink(system, sourceLink, context)
    * pathAvailabilityToComponent(system, sourceLink.toComponentIndex, turbine.index, context, new Set())
}

export const topologyAwareMainSteamDemandForSourceLink = (
  system: CompiledProcessPlantSystem,
  sourceLink: CompiledProcessLink,
  context: LinkBehaviorReadContext,
): number => {
  let demand = 0
  const sources = mainSteamSourceLinks(system)
  for (const turbine of system.graph.components) {
    if (turbine.kind !== 'turbineLoadSink') continue
    const sourceAvailability = sourceAvailabilityToTurbine(system, sourceLink, turbine, context)
    if (sourceAvailability <= 0) continue
    let totalAvailability = 0
    for (const candidateSource of sources) {
      totalAvailability += sourceAvailabilityToTurbine(system, candidateSource, turbine, context)
    }
    if (totalAvailability <= 0) continue
    demand += turbineSteamDemandKgPerS(turbine, context) * sourceAvailability / totalAvailability
  }
  return demand
}
