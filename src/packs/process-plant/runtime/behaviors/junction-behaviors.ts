import type { CompiledComponent, CompiledProcessLink } from '../../graph/index.ts'
import { componentVariablePath, type ComponentBehaviorDefinition } from '../behavior-contract.ts'
import { processLinkVariablePath } from '../behavior-contract.ts'
import { clamp, optionalParameterNumber, optionalParameterString, relaxToward } from '../component-helpers.ts'
import { inventoryBalanceStep } from '../physics.ts'

type ValveMode = 'control' | 'isolation' | 'check' | 'relief' | 'safety' | 'throttle'

const valveModes: ReadonlySet<ValveMode> = new Set(['control', 'isolation', 'check', 'relief', 'safety', 'throttle'])

const serviceLinksForComponent = (
  component: CompiledComponent,
  links: ReadonlyArray<CompiledProcessLink>,
): ReadonlyArray<CompiledProcessLink> => {
  const firstFluidService = links.find(link => link.kind === 'fluidFlow')?.service
  if (firstFluidService === undefined) return []
  return links.filter(link => link.kind === 'fluidFlow' && link.service === firstFluidService)
}

const weightedAverageLinkValue = (
  links: ReadonlyArray<CompiledProcessLink>,
  localPath: string,
  context: Parameters<ComponentBehaviorDefinition['update']>[0]['context'],
): number | null => {
  let weightedTotal = 0
  let weightTotal = 0
  for (const link of links) {
    const valuePath = processLinkVariablePath(link, localPath)
    if (!context.has(valuePath)) continue
    const flowPath = processLinkVariablePath(link, 'flowKgPerS')
    const weight = context.has(flowPath) ? Math.max(0, context.readNumber(flowPath)) : 1
    if (weight <= 0) continue
    weightedTotal += context.readNumber(valuePath) * weight
    weightTotal += weight
  }
  return weightTotal <= 0 ? null : weightedTotal / weightTotal
}

const sumLinkFlow = (
  links: ReadonlyArray<CompiledProcessLink>,
  context: Parameters<ComponentBehaviorDefinition['update']>[0]['context'],
): number => {
  let total = 0
  for (const link of links) {
    const path = processLinkVariablePath(link, 'flowKgPerS')
    if (context.has(path)) total += context.readNumber(path)
  }
  return total
}

const maxLinkValue = (
  links: ReadonlyArray<CompiledProcessLink>,
  localPath: string,
  context: Parameters<ComponentBehaviorDefinition['update']>[0]['context'],
): number | null => {
  let value: number | null = null
  for (const link of links) {
    const path = processLinkVariablePath(link, localPath)
    if (!context.has(path)) continue
    const current = context.readNumber(path)
    value = value === null ? current : Math.max(value, current)
  }
  return value
}

const minLinkValue = (
  links: ReadonlyArray<CompiledProcessLink>,
  localPath: string,
  context: Parameters<ComponentBehaviorDefinition['update']>[0]['context'],
): number | null => {
  let value: number | null = null
  for (const link of links) {
    const path = processLinkVariablePath(link, localPath)
    if (!context.has(path)) continue
    const current = context.readNumber(path)
    value = value === null ? current : Math.min(value, current)
  }
  return value
}

const linkService = (
  links: ReadonlyArray<CompiledProcessLink>,
): CompiledProcessLink['service'] | undefined => links.find(link => link.kind === 'fluidFlow')?.service

const matchingLinks = (
  links: ReadonlyArray<CompiledProcessLink>,
  service: CompiledProcessLink['service'],
): ReadonlyArray<CompiledProcessLink> =>
  links.filter(link => link.kind === 'fluidFlow' && service !== undefined && link.service === service)

const updateValveFlowDiagnostics = (
  input: Parameters<ComponentBehaviorDefinition['update']>[0],
): void => {
  const { system, component, context } = input
  const incomingLinks = system.graph.incomingLinksByComponent[component.index]?.map(index => system.graph.links[index]).filter(link => link !== undefined) ?? []
  const outgoingLinks = system.graph.outgoingLinksByComponent[component.index]?.map(index => system.graph.links[index]).filter(link => link !== undefined) ?? []
  const service = linkService([...incomingLinks, ...outgoingLinks])
  const inletFlow = sumLinkFlow(matchingLinks(incomingLinks, service), context)
  const outletFlow = sumLinkFlow(matchingLinks(outgoingLinks, service), context)
  const matchingIncoming = matchingLinks(incomingLinks, service)
  const matchingOutgoing = matchingLinks(outgoingLinks, service)
  const upstreamPressure = maxLinkValue(matchingIncoming, 'pressureMPa', context) ?? optionalParameterNumber(component, 'initialPressureMPa', component.kind === 'steamValve' ? 6.9 : 1)
  const downstreamPressure = minLinkValue(matchingOutgoing, 'pressureMPa', context) ?? upstreamPressure
  const pressureDrop = Math.max(0, upstreamPressure - downstreamPressure)
  const effectivePosition = clamp(context.readNumber(componentVariablePath(component, 'effectivePositionFraction')), 0, 1)
  const cv = optionalParameterNumber(component, 'cvKgPerSPerSqrtMPa', Number.POSITIVE_INFINITY)
  const capacityLimitedFlow = Number.isFinite(cv) ? cv * Math.sqrt(pressureDrop) * effectivePosition : outletFlow
  const leakageFraction = optionalParameterNumber(component, 'leakageFractionClosed', 0)
  const leakageFlow = inletFlow * leakageFraction * (1 - effectivePosition)
  const reverseFlowAllowed = optionalParameterString(component, 'valveMode', 'control', valveModes) !== 'check'
    && Boolean((component.parameters as Record<string, unknown>).reverseFlowAllowed ?? true)
  const reverseFlow = reverseFlowAllowed ? Math.max(0, outletFlow - inletFlow) : 0
  context.write(componentVariablePath(component, 'inletFlowKgPerS'), inletFlow)
  context.write(componentVariablePath(component, 'outletFlowKgPerS'), outletFlow)
  context.write(componentVariablePath(component, 'flowBalanceResidualKgPerS'), inletFlow - outletFlow)
  context.write(componentVariablePath(component, 'availablePressureDropMPa'), pressureDrop)
  context.write(componentVariablePath(component, 'capacityLimitedFlowKgPerS'), capacityLimitedFlow)
  context.write(componentVariablePath(component, 'leakageFlowKgPerS'), leakageFlow)
  context.write(componentVariablePath(component, 'reverseFlowKgPerS'), reverseFlow)
}

const updateHeaderDiagnostics = (
  input: Parameters<ComponentBehaviorDefinition['update']>[0],
): void => {
  const { system, component, context } = input
  const incomingLinks = serviceLinksForComponent(
    component,
    system.graph.incomingLinksByComponent[component.index]?.map(index => system.graph.links[index]).filter(link => link !== undefined) ?? [],
  )
  const outgoingLinks = serviceLinksForComponent(
    component,
    system.graph.outgoingLinksByComponent[component.index]?.map(index => system.graph.links[index]).filter(link => link !== undefined) ?? [],
  )
  const inletFlow = sumLinkFlow(incomingLinks, context)
  const outletFlow = sumLinkFlow(outgoingLinks, context)
  const previousMixedTemperature = context.readNumber(componentVariablePath(component, 'mixedTemperatureC'))
  const incomingMixedTemperature = weightedAverageLinkValue(incomingLinks, 'temperatureC', context)
    ?? weightedAverageLinkValue(outgoingLinks, 'temperatureC', context)
    ?? optionalParameterNumber(component, 'initialTemperatureC', 220)
  const mixedTemperature = relaxToward(
    previousMixedTemperature,
    incomingMixedTemperature,
    context.dtSeconds,
    optionalParameterNumber(component, 'mixingTimeConstantS', 1),
  )
  const previousPressure = context.readNumber(componentVariablePath(component, 'pressureNodeMPa'))
  const incomingMixedPressure = weightedAverageLinkValue(incomingLinks, 'pressureMPa', context)
    ?? weightedAverageLinkValue(outgoingLinks, 'pressureMPa', context)
    ?? optionalParameterNumber(component, 'initialPressureMPa', 1)
  const mixedPressure = relaxToward(
    previousPressure,
    incomingMixedPressure,
    context.dtSeconds,
    optionalParameterNumber(component, 'pressureTimeConstantS', 1),
  )
  const density = optionalParameterNumber(component, 'nominalDensityKgPerM3', component.kind === 'steamHeader' ? 35 : 950)
  const maxInventory = optionalParameterNumber(component, 'headerVolumeM3', 1) * density * 1.25
  const inventory = inventoryBalanceStep({
    currentInventory: context.readNumber(componentVariablePath(component, 'inventoryKg')),
    inflowKgPerS: inletFlow,
    outflowKgPerS: outletFlow,
    dtSeconds: context.dtSeconds,
    minInventory: 0,
    maxInventory,
  })
  context.write(componentVariablePath(component, 'inletFlowKgPerS'), inletFlow)
  context.write(componentVariablePath(component, 'outletFlowKgPerS'), outletFlow)
  context.write(componentVariablePath(component, 'flowBalanceResidualKgPerS'), inletFlow - outletFlow)
  context.write(componentVariablePath(component, 'mixedTemperatureC'), mixedTemperature)
  context.write(componentVariablePath(component, 'mixedPressureMPa'), mixedPressure)
  context.write(componentVariablePath(component, 'pressureNodeMPa'), mixedPressure)
  context.write(componentVariablePath(component, 'inventoryKg'), inventory)
  context.write(componentVariablePath(component, 'unmetDemandKgPerS'), Math.max(0, outletFlow - inletFlow))
}

const valveControlBehavior = (componentKind: 'processValve' | 'steamValve'): ComponentBehaviorDefinition => ({
  id: `${componentKind}-effective-position`,
  phase: 'solveFluidFlowComponents',
  componentKind,
  reads: ['positionFraction', 'incoming:pressureMPa', 'availablePressureDropMPa', 'autoOpenActive'],
  writes: ['demandPositionFraction', 'effectivePositionFraction', 'autoOpenActive'],
  update: ({ system, component, context }): void => {
    const manualTarget = clamp(context.readNumber(componentVariablePath(component, 'positionFraction')), 0, 1)
    const mode = optionalParameterString(component, 'valveMode', 'control', valveModes)
    const incomingLinks = system.graph.incomingLinksByComponent[component.index]?.map(index => system.graph.links[index]).filter(link => link !== undefined) ?? []
    const upstreamPressure = maxLinkValue(
      matchingLinks(incomingLinks, linkService(incomingLinks)),
      'pressureMPa',
      context,
    )
    const pressureDrop = context.has(componentVariablePath(component, 'availablePressureDropMPa'))
      ? context.readNumber(componentVariablePath(component, 'availablePressureDropMPa'))
      : 0
    const setpoint = optionalParameterNumber(component, 'setpointMPa', Number.POSITIVE_INFINITY)
    const reseat = optionalParameterNumber(component, 'reseatMPa', setpoint * 0.98)
    const wasAutoOpen = context.readBoolean(componentVariablePath(component, 'autoOpenActive'))
    const automaticPressure = upstreamPressure ?? pressureDrop
    const autoOpen = (mode === 'relief' || mode === 'safety') && (automaticPressure >= setpoint || (wasAutoOpen && automaticPressure > reseat))
    const target = autoOpen ? 1 : manualTarget
    const current = context.readNumber(componentVariablePath(component, 'effectivePositionFraction'))
    const timeConstant = target >= current
      ? optionalParameterNumber(component, 'strokeOpenTimeS', optionalParameterNumber(component, 'strokeTimeConstantS', 0.1))
      : optionalParameterNumber(component, 'strokeCloseTimeS', optionalParameterNumber(component, 'strokeTimeConstantS', 0.1))
    const nextPosition = relaxToward(current, target, context.dtSeconds, timeConstant)
    const minimumPosition = optionalParameterNumber(component, 'leakageFractionClosed', 0)
    context.write(
      componentVariablePath(component, 'effectivePositionFraction'),
      clamp(Math.max(nextPosition, minimumPosition), 0, 1),
    )
    context.write(componentVariablePath(component, 'demandPositionFraction'), target)
    context.write(componentVariablePath(component, 'autoOpenActive'), autoOpen)
  },
})

const valveDiagnosticsBehavior = (componentKind: 'processValve' | 'steamValve'): ComponentBehaviorDefinition => ({
  id: `${componentKind}-flow-diagnostics`,
  phase: 'updateComponentState',
  componentKind,
  reads: ['incoming:flowKgPerS', 'outgoing:flowKgPerS', 'incoming:pressureMPa', 'outgoing:pressureMPa', 'effectivePositionFraction'],
  writes: ['inletFlowKgPerS', 'outletFlowKgPerS', 'flowBalanceResidualKgPerS', 'availablePressureDropMPa', 'capacityLimitedFlowKgPerS', 'reverseFlowKgPerS', 'leakageFlowKgPerS'],
  update: updateValveFlowDiagnostics,
})

const headerDiagnosticsBehavior = (componentKind: 'processHeader' | 'steamHeader'): ComponentBehaviorDefinition => ({
  id: `${componentKind}-mixing-diagnostics`,
  phase: 'updateComponentState',
  componentKind,
  reads: ['incoming:flowKgPerS', 'incoming:temperatureC', 'incoming:pressureMPa', 'outgoing:flowKgPerS', 'mixedTemperatureC', 'pressureNodeMPa', 'inventoryKg'],
  writes: ['inventoryKg', 'inletFlowKgPerS', 'outletFlowKgPerS', 'flowBalanceResidualKgPerS', 'mixedTemperatureC', 'mixedPressureMPa', 'pressureNodeMPa', 'unmetDemandKgPerS'],
  update: updateHeaderDiagnostics,
})

export const junctionBehaviorDefinitions: ReadonlyArray<ComponentBehaviorDefinition> = [
  valveControlBehavior('processValve'),
  valveControlBehavior('steamValve'),
  valveDiagnosticsBehavior('processValve'),
  valveDiagnosticsBehavior('steamValve'),
  headerDiagnosticsBehavior('processHeader'),
  headerDiagnosticsBehavior('steamHeader'),
]
