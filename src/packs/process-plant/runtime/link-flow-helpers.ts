import type { CompiledProcessLink } from '../graph/index.ts'
import type { CompiledProcessPlantSystem } from '../process-systems.ts'
import { processLinkVariablePath } from './behavior-contract.ts'
import { clamp } from './component-helpers.ts'

export type LinkBehaviorReadContext = {
  readonly has: (path: ReturnType<typeof processLinkVariablePath>) => boolean
  readonly readNumber: (path: ReturnType<typeof processLinkVariablePath>) => number
  readonly readOptionalNumber: (path: ReturnType<typeof processLinkVariablePath>, defaultValue: number) => number
}

export const hasProcessLinkVariable = (link: CompiledProcessLink, localPath: string): boolean =>
  link.variables.some(variable => variable.path === processLinkVariablePath(link, localPath))

export const serviceMatches = (link: CompiledProcessLink, service: CompiledProcessLink['service']): boolean =>
  service !== undefined && link.service === service

export const sumIncomingLinkValue = (
  system: CompiledProcessPlantSystem,
  componentIndex: number,
  localPath: string,
  context: Pick<LinkBehaviorReadContext, 'has' | 'readNumber'>,
  linkMatches: (link: CompiledProcessLink) => boolean,
): number => {
  let total = 0
  for (const linkIndex of system.graph.incomingLinksByComponent[componentIndex] ?? []) {
    const link = system.graph.links[linkIndex]
    if (!link || !linkMatches(link)) continue
    const path = processLinkVariablePath(link, localPath)
    if (!context.has(path)) continue
    total += context.readNumber(path)
  }
  return total
}

export const incomingLinkValueStats = (
  system: CompiledProcessPlantSystem,
  componentIndex: number,
  localPath: string,
  context: Pick<LinkBehaviorReadContext, 'has' | 'readNumber'>,
  linkMatches: (link: CompiledProcessLink) => boolean,
): { readonly matchingLinks: number; readonly valuedLinks: number; readonly total: number } => {
  let matchingLinks = 0
  let valuedLinks = 0
  let total = 0
  for (const linkIndex of system.graph.incomingLinksByComponent[componentIndex] ?? []) {
    const link = system.graph.links[linkIndex]
    if (!link || !linkMatches(link)) continue
    matchingLinks += 1
    const path = processLinkVariablePath(link, localPath)
    if (!context.has(path)) continue
    total += context.readNumber(path)
    valuedLinks += 1
  }
  return { matchingLinks, valuedLinks, total }
}

export const averageIncomingLinkValue = (
  system: CompiledProcessPlantSystem,
  componentIndex: number,
  localPath: string,
  context: Pick<LinkBehaviorReadContext, 'has' | 'readNumber'>,
  linkMatches: (link: CompiledProcessLink) => boolean,
): number | null => {
  let total = 0
  let count = 0
  for (const linkIndex of system.graph.incomingLinksByComponent[componentIndex] ?? []) {
    const link = system.graph.links[linkIndex]
    if (!link || !linkMatches(link)) continue
    const path = processLinkVariablePath(link, localPath)
    if (!context.has(path)) continue
    total += context.readNumber(path)
    count += 1
  }
  return count === 0 ? null : total / count
}

const downstreamValveDemandWeight = (
  system: CompiledProcessPlantSystem,
  link: CompiledProcessLink,
  context: LinkBehaviorReadContext,
): number | null => {
  const toComponent = system.graph.components[link.toComponentIndex]
  if (toComponent?.kind !== 'processValve') return null
  let demandWeight = 0
  let hasDemandSignal = false
  for (const outgoingLinkIndex of system.graph.outgoingLinksByComponent[toComponent.index] ?? []) {
    const outgoingLink = system.graph.links[outgoingLinkIndex]
    if (!outgoingLink || outgoingLink.kind !== 'fluidFlow' || !serviceMatches(outgoingLink, link.service)) continue
    if (!hasProcessLinkVariable(outgoingLink, 'valve.positionFraction')) {
      demandWeight += 1
      continue
    }
    hasDemandSignal = true
    demandWeight += clamp(context.readOptionalNumber(processLinkVariablePath(outgoingLink, 'valve.positionFraction'), 1), 0, 1)
  }
  if (!hasDemandSignal && demandWeight === 0) return null
  return demandWeight
}

const outgoingDemandWeight = (
  system: CompiledProcessPlantSystem,
  link: CompiledProcessLink,
  context: LinkBehaviorReadContext,
): number =>
  downstreamValveDemandWeight(system, link, context) ?? 1

export const outgoingDemandWeightTotal = (
  system: CompiledProcessPlantSystem,
  componentIndex: number,
  service: CompiledProcessLink['service'],
  context: LinkBehaviorReadContext,
): number => {
  let total = 0
  for (const linkIndex of system.graph.outgoingLinksByComponent[componentIndex] ?? []) {
    const link = system.graph.links[linkIndex]
    if (!link || link.kind !== 'fluidFlow' || !serviceMatches(link, service)) continue
    total += outgoingDemandWeight(system, link, context)
  }
  return total
}

export const distributeFlowFromComponent = (
  system: CompiledProcessPlantSystem,
  link: CompiledProcessLink,
  context: LinkBehaviorReadContext,
  availableFlowKgPerS: number,
): number => {
  const totalDemandWeight = outgoingDemandWeightTotal(system, link.fromComponentIndex, link.service, context)
  if (totalDemandWeight <= 0) return 0
  return availableFlowKgPerS * outgoingDemandWeight(system, link, context) / totalDemandWeight
}

export const passiveFlowFromIncomingService = (
  system: CompiledProcessPlantSystem,
  link: CompiledProcessLink,
  context: LinkBehaviorReadContext,
): number => {
  const service = link.service
  const matchingService = (candidate: CompiledProcessLink): boolean => candidate.kind === 'fluidFlow' && serviceMatches(candidate, service)
  const incomingFlow = sumIncomingLinkValue(system, link.fromComponentIndex, 'flowKgPerS', context, matchingService)
  return distributeFlowFromComponent(system, link, context, incomingFlow)
}

export const sourceLimitedPumpFlow = (
  system: CompiledProcessPlantSystem,
  link: CompiledProcessLink,
  context: Pick<LinkBehaviorReadContext, 'has' | 'readNumber'>,
  pumpFlow: number,
): number => {
  const incomingFlow = incomingLinkValueStats(
    system,
    link.fromComponentIndex,
    'flowKgPerS',
    context,
    candidate => candidate.kind === 'fluidFlow' && serviceMatches(candidate, link.service),
  )
  if (incomingFlow.matchingLinks === 0) return pumpFlow
  if (incomingFlow.valuedLinks === 0) return 0
  return Math.min(pumpFlow, incomingFlow.total)
}
