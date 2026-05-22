import type { CompiledProcessLink, VariablePath } from '../graph/index.ts'
import type { CompiledProcessPlantSystem } from '../process-systems.ts'
import { componentVariablePath, processLinkVariablePath } from './behavior-contract.ts'
import { clamp } from './component-helpers.ts'

export type LinkBehaviorReadContext = {
  readonly has: (path: VariablePath) => boolean
  readonly readNumber: (path: VariablePath) => number
  readonly readOptionalNumber: (path: VariablePath, defaultValue: number) => number
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
  if (toComponent?.kind !== 'processValve' && toComponent?.kind !== 'steamValve') return null
  const effectivePositionPath = componentVariablePath(toComponent, 'effectivePositionFraction')
  if (context.has(effectivePositionPath)) {
    return clamp(context.readNumber(effectivePositionPath), 0, 1)
  }
  const positionPath = componentVariablePath(toComponent, 'positionFraction')
  if (context.has(positionPath)) {
    return clamp(context.readNumber(positionPath), 0, 1)
  }
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

export interface ComponentFlowBalance {
  readonly componentId: string
  readonly service: string
  readonly inflowKgPerS: number
  readonly outflowKgPerS: number
  readonly residualKgPerS: number
}

export const componentFlowBalanceForService = (
  system: CompiledProcessPlantSystem,
  componentIndex: number,
  service: CompiledProcessLink['service'],
  context: Pick<LinkBehaviorReadContext, 'has' | 'readNumber'>,
): ComponentFlowBalance => {
  const component = system.graph.components[componentIndex]
  if (!component) throw new Error(`process plant flow balance references missing component index: ${componentIndex}`)
  if (service === undefined) throw new Error(`process plant flow balance for component ${component.id} requires a service`)
  const matchesService = (candidate: CompiledProcessLink): boolean =>
    candidate.kind === 'fluidFlow' && serviceMatches(candidate, service)
  const inflowKgPerS = sumIncomingLinkValue(system, componentIndex, 'flowKgPerS', context, matchesService)
  let outflowKgPerS = 0
  for (const linkIndex of system.graph.outgoingLinksByComponent[componentIndex] ?? []) {
    const link = system.graph.links[linkIndex]
    if (!link || !matchesService(link)) continue
    const path = processLinkVariablePath(link, 'flowKgPerS')
    if (!context.has(path)) continue
    outflowKgPerS += context.readNumber(path)
  }
  return {
    componentId: String(component.id),
    service: String(service),
    inflowKgPerS,
    outflowKgPerS,
    residualKgPerS: inflowKgPerS - outflowKgPerS,
  }
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
