import type { CompiledProcessLink, VariablePath } from '../../graph/index.ts'
import type { CompiledProcessPlant } from '../../plant-compiler.ts'
import { componentVariablePath, processLinkVariablePath } from '../behavior-contract.ts'
import { isIncomingFluidForOutlet, sameComponentFluidCircuit } from '../fluid-circuits.ts'
import { reactorCoolantDeliveryFraction } from '../pump-delivery.ts'
import { serviceUsesDownstreamDemand } from '../service-profiles.ts'
import { clamp, parameterNumber } from '../component-helpers.ts'
import { downstreamDemandPathsForLink } from '../topology-cache.ts'
import { headerPressureBalance, isPressureBalancedHeader } from '../behaviors/junction/header-pressure-balance.ts'

export type LinkBehaviorReadContext = {
  readonly has: (path: VariablePath) => boolean
  readonly readNumber: (path: VariablePath) => number
  readonly readBoolean: (path: VariablePath) => boolean
  readonly readOptionalNumber: (path: VariablePath, defaultValue: number) => number
}

const processLinkVariableLocalPathCache = new WeakMap<CompiledProcessLink, ReadonlySet<string>>()

const processLinkVariableLocalPaths = (link: CompiledProcessLink): ReadonlySet<string> => {
  const cached = processLinkVariableLocalPathCache.get(link)
  if (cached) return cached
  const prefix = `${String(link.id)}.`
  const paths = new Set<string>()
  for (const variable of link.variables) {
    const fullPath = String(variable.path)
    if (fullPath.startsWith(prefix)) paths.add(fullPath.slice(prefix.length))
  }
  processLinkVariableLocalPathCache.set(link, paths)
  return paths
}

export const hasProcessLinkVariable = (link: CompiledProcessLink, localPath: string): boolean =>
  processLinkVariableLocalPaths(link).has(localPath)

export const serviceMatches = (link: CompiledProcessLink, service: CompiledProcessLink['service']): boolean =>
  service !== undefined && link.service === service

export const componentValveFactorForInboundLink = (
  system: CompiledProcessPlant,
  link: CompiledProcessLink,
  context: LinkBehaviorReadContext,
): number => {
  const toComponent = system.graph.components[link.toComponentIndex]
  if (toComponent?.kind !== 'processValve' && toComponent?.kind !== 'steamValve') return 1
  const effectivePositionPath = componentVariablePath(toComponent, 'effectivePositionFraction')
  if (context.has(effectivePositionPath)) return clamp(context.readNumber(effectivePositionPath), 0, 1)
  const positionPath = componentVariablePath(toComponent, 'positionFraction')
  return context.has(positionPath) ? clamp(context.readNumber(positionPath), 0, 1) : 1
}

export const componentValveCapacityForInboundLink = (
  system: CompiledProcessPlant,
  link: CompiledProcessLink,
  context: LinkBehaviorReadContext,
): number => {
  const toComponent = system.graph.components[link.toComponentIndex]
  if (toComponent?.kind !== 'processValve' && toComponent?.kind !== 'steamValve') return Number.POSITIVE_INFINITY
  // A pressure-balanced header's branch takes what the balance gives it, which its valve's coefficient already sets.
  if (isPressureBalancedHeader(system.graph.components[link.fromComponentIndex])) return Number.POSITIVE_INFINITY
  const parameters = toComponent.parameters
  if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) return Number.POSITIVE_INFINITY
  const cv = (parameters as Record<string, unknown>).cvKgPerSPerSqrtMPa
  if (cv === undefined) return Number.POSITIVE_INFINITY
  if (typeof cv !== 'number' || !Number.isFinite(cv) || cv < 0) throw new Error(`component ${toComponent.id} parameter cvKgPerSPerSqrtMPa must be nonnegative`)
  const upstreamPressurePath = processLinkVariablePath(link, 'pressureMPa')
  const upstreamPressure = context.has(upstreamPressurePath) ? context.readNumber(upstreamPressurePath) : 0
  return cv * Math.sqrt(Math.max(0, upstreamPressure))
}

export const componentValveAvailabilityForLink = (
  system: CompiledProcessPlant,
  link: CompiledProcessLink,
  context: LinkBehaviorReadContext,
): number => componentValveFactorForInboundLink(system, link, context)

export const sumIncomingLinkValue = (
  system: CompiledProcessPlant,
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
  system: CompiledProcessPlant,
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
  system: CompiledProcessPlant,
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

export const flowWeightedIncomingLinkValue = (
  system: CompiledProcessPlant,
  componentIndex: number,
  localPath: string,
  context: Pick<LinkBehaviorReadContext, 'has' | 'readNumber'>,
  linkMatches: (link: CompiledProcessLink) => boolean,
): number | null => {
  let weightedTotal = 0
  let flowTotal = 0
  for (const linkIndex of system.graph.incomingLinksByComponent[componentIndex] ?? []) {
    const link = system.graph.links[linkIndex]
    if (!link || !linkMatches(link)) continue
    const valuePath = processLinkVariablePath(link, localPath)
    const flowPath = processLinkVariablePath(link, 'flowKgPerS')
    if (!context.has(valuePath) || !context.has(flowPath)) continue
    const flow = Math.max(0, context.readNumber(flowPath))
    if (flow <= 0) continue
    weightedTotal += context.readNumber(valuePath) * flow
    flowTotal += flow
  }
  return flowTotal <= 0 ? null : weightedTotal / flowTotal
}

const downstreamValveDemandWeight = (
  system: CompiledProcessPlant,
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
    const downstreamComponentValveFactor = componentValveFactorForInboundLink(system, outgoingLink, context)
    if (downstreamComponentValveFactor < 1) hasDemandSignal = true
    demandWeight += downstreamComponentValveFactor
  }
  if (!hasDemandSignal && demandWeight === 0) return null
  return demandWeight
}

const outgoingDemandWeight = (
  system: CompiledProcessPlant,
  link: CompiledProcessLink,
  context: LinkBehaviorReadContext,
): number => {
  const target = system.graph.components[link.toComponentIndex]
  if (target?.kind === 'centrifugalPump') {
    const nominal = Number((target.parameters as Record<string, unknown>).nominalFlowKgPerS)
    return Math.max(0, pumpAvailableFlowKgPerS(system, target, context, link.service)) / nominal
  }
  return downstreamValveDemandWeight(system, link, context) ?? 1
}

export const outgoingDemandWeightTotal = (
  system: CompiledProcessPlant,
  componentIndex: number,
  service: CompiledProcessLink['service'],
  context: LinkBehaviorReadContext,
  outletPort: string,
): number => {
  let total = 0
  for (const linkIndex of system.graph.outgoingLinksByComponent[componentIndex] ?? []) {
    const link = system.graph.links[linkIndex]
    if (!link || link.kind !== 'fluidFlow' || !serviceMatches(link, service)) continue
    if (!sameComponentFluidCircuit(system.graph.components[componentIndex]!, outletPort, String(link.fromPortName))) continue
    total += outgoingDemandWeight(system, link, context)
  }
  return total
}

/** One physical inventory/outlet has one mass budget, even when its
 * downstream uses have different service labels or very different pump sizes. */
const storedFluidOutletFlow = (
  system: CompiledProcessPlant,
  requested: CompiledProcessLink,
  context: LinkBehaviorReadContext,
  availableFlowKgPerS: number,
): number => {
  let totalDemand = 0
  let requestedDemand = 0
  for (const index of system.graph.outgoingLinksByComponent[requested.fromComponentIndex] ?? []) {
    const sibling = system.graph.links[index]!
    if (sibling.kind !== 'fluidFlow' || sibling.fromPortName !== requested.fromPortName) continue
    const target = system.graph.components[sibling.toComponentIndex]!
    const demand = target.kind === 'centrifugalPump'
      ? pumpAvailableFlowKgPerS(system, target, context, sibling.service)
      : availableFlowKgPerS * componentValveFactorForInboundLink(system, sibling, context)
        * (serviceUsesDownstreamDemand(sibling.service) ? downstreamServiceDemandFraction(system, sibling, context) : 1)
    totalDemand += demand
    if (sibling.index === requested.index) requestedDemand = demand
  }
  return totalDemand > 0 ? requestedDemand * Math.min(1, availableFlowKgPerS / totalDemand) : 0
}

export const distributeFlowFromComponent = (
  system: CompiledProcessPlant,
  link: CompiledProcessLink,
  context: LinkBehaviorReadContext,
  availableFlowKgPerS: number,
): number => {
  // A pressure-balanced header shares what its pumps deliver as its branches take it at its pressure.
  const fromComponent = system.graph.components[link.fromComponentIndex]
  if (fromComponent?.kind === 'processTank' || (fromComponent?.kind === 'containmentVolume' && String(link.fromPortName) === 'sumpOut')) {
    return storedFluidOutletFlow(system, link, context, availableFlowKgPerS)
  }
  if (isPressureBalancedHeader(fromComponent)) {
    const branchFlows = headerPressureBalance(system, fromComponent, context).branchFlowKgPerS
    const totalBranchFlow = [...branchFlows.values()].reduce((total, flow) => total + flow, 0)
    return totalBranchFlow <= 0 ? 0 : availableFlowKgPerS * (branchFlows.get(link.index) ?? 0) / totalBranchFlow
  }
  const totalDemandWeight = outgoingDemandWeightTotal(system, link.fromComponentIndex, link.service, context, String(link.fromPortName))
  if (totalDemandWeight <= 0) return 0
  return availableFlowKgPerS * outgoingDemandWeight(system, link, context) / totalDemandWeight
}

export const downstreamServiceDemandFraction = (
  system: CompiledProcessPlant,
  link: CompiledProcessLink,
  context: LinkBehaviorReadContext,
): number => {
  const downstreamPaths = downstreamDemandPathsForLink(system, link)
  if (downstreamPaths.length === 0) return 1
  let liveDemandWeight = 0
  for (const path of downstreamPaths) {
    // A tank at the end takes in what its inlet level controller lets in.
    const terminal = system.graph.components[(path.at(-1) ?? link).toComponentIndex]!
    const inletControlPath = componentVariablePath(terminal, 'inletControlFraction')
    let pathWeight = context.has(inletControlPath) ? clamp(context.readNumber(inletControlPath), 0, 1) : 1
    for (const pathLink of path) {
      pathWeight *= componentValveAvailabilityForLink(system, pathLink, context)
      if (pathWeight <= 0) break
    }
    liveDemandWeight += pathWeight
  }
  return clamp(liveDemandWeight / downstreamPaths.length, 0, 1)
}

export const passiveFlowFromIncomingService = (
  system: CompiledProcessPlant,
  link: CompiledProcessLink,
  context: LinkBehaviorReadContext,
): number => {
  const matchingService = (candidate: CompiledProcessLink): boolean => isIncomingFluidForOutlet(system, link, candidate)
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
  system: CompiledProcessPlant,
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

/** A solved pump state never defeats a presently closed path or an exceeded
 * shutoff head while its lagged flow state winds down. */
export const pumpAvailableFlowKgPerS = (
  system: CompiledProcessPlant,
  pump: CompiledProcessPlant['graph']['components'][number],
  context: LinkBehaviorReadContext,
  service: CompiledProcessLink['service'],
): number => {
  const currentFlow = Math.max(0, context.readNumber(componentVariablePath(pump, 'flowKgPerS')))
  const hasInjectionCurve = typeof (pump.parameters as Readonly<Record<string, unknown>>).reactorCoolantShutoffPressureMPa === 'number'
  // A pressure-balanced header may drive a pump above its nominal/rated
  // flow. Preserve that solved curve; a nominal rating is not a flow limit.
  if (!hasInjectionCurve && !serviceUsesDownstreamDemand(service)) return currentFlow
  const speed = Math.max(0, context.readNumber(componentVariablePath(pump, 'speedFraction')))
  let availability = reactorCoolantDeliveryFraction(system, pump, context, speed)
  if (serviceUsesDownstreamDemand(service)) {
    const outlets = (system.graph.outgoingLinksByComponent[pump.index] ?? [])
      .map(index => system.graph.links[index]!)
      .filter(link => link.kind === 'fluidFlow' && link.service === service)
    availability *= outlets.length === 0 ? 1 : Math.max(...outlets.map(link => downstreamServiceDemandFraction(system, link, context)))
  }
  return Math.min(currentFlow,
    parameterNumber(pump, 'nominalFlowKgPerS') * speed * availability)
}

export const sourceLimitedPumpFlow = (
  system: CompiledProcessPlant,
  link: CompiledProcessLink,
  context: LinkBehaviorReadContext,
  pumpFlow: number,
): number => {
  const incomingFlow = incomingLinkValueStats(
    system,
    link.fromComponentIndex,
    'flowKgPerS',
    context,
    candidate => candidate.kind === 'fluidFlow' && serviceMatches(candidate, link.service),
  )
  const pump = system.graph.components[link.fromComponentIndex]!
  const deliverable = Math.min(pumpFlow, pumpAvailableFlowKgPerS(system, pump, context, link.service))
  if (incomingFlow.matchingLinks === 0) return deliverable
  if (incomingFlow.valuedLinks === 0) return 0
  return Math.min(deliverable, incomingFlow.total)
}
