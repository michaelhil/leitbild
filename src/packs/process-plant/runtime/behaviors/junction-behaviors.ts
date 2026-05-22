import type { CompiledComponent, CompiledProcessLink } from '../../graph/index.ts'
import { componentVariablePath, type ComponentBehaviorDefinition } from '../behavior-contract.ts'
import { processLinkVariablePath } from '../behavior-contract.ts'
import { clamp, optionalParameterNumber, relaxToward } from '../component-helpers.ts'

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
  context.write(componentVariablePath(component, 'inletFlowKgPerS'), inletFlow)
  context.write(componentVariablePath(component, 'outletFlowKgPerS'), outletFlow)
  context.write(componentVariablePath(component, 'flowBalanceResidualKgPerS'), inletFlow - outletFlow)
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
  const mixedTemperature = weightedAverageLinkValue(incomingLinks, 'temperatureC', context)
    ?? weightedAverageLinkValue(outgoingLinks, 'temperatureC', context)
    ?? optionalParameterNumber(component, 'initialTemperatureC', 220)
  const mixedPressure = weightedAverageLinkValue(incomingLinks, 'pressureMPa', context)
    ?? weightedAverageLinkValue(outgoingLinks, 'pressureMPa', context)
    ?? optionalParameterNumber(component, 'initialPressureMPa', 1)
  context.write(componentVariablePath(component, 'inletFlowKgPerS'), inletFlow)
  context.write(componentVariablePath(component, 'outletFlowKgPerS'), outletFlow)
  context.write(componentVariablePath(component, 'flowBalanceResidualKgPerS'), inletFlow - outletFlow)
  context.write(componentVariablePath(component, 'mixedTemperatureC'), mixedTemperature)
  context.write(componentVariablePath(component, 'mixedPressureMPa'), mixedPressure)
}

const valveControlBehavior = (componentKind: 'processValve' | 'steamValve'): ComponentBehaviorDefinition => ({
  id: `${componentKind}-effective-position`,
  phase: 'solveFluidFlowComponents',
  componentKind,
  reads: ['positionFraction'],
  writes: ['effectivePositionFraction'],
  update: ({ component, context }): void => {
    const target = clamp(context.readNumber(componentVariablePath(component, 'positionFraction')), 0, 1)
    const current = context.readNumber(componentVariablePath(component, 'effectivePositionFraction'))
    context.write(
      componentVariablePath(component, 'effectivePositionFraction'),
      relaxToward(current, target, context.dtSeconds, optionalParameterNumber(component, 'strokeTimeConstantS', 0.1)),
    )
  },
})

const valveDiagnosticsBehavior = (componentKind: 'processValve' | 'steamValve'): ComponentBehaviorDefinition => ({
  id: `${componentKind}-flow-diagnostics`,
  phase: 'updateComponentState',
  componentKind,
  reads: ['incoming:flowKgPerS', 'outgoing:flowKgPerS'],
  writes: ['inletFlowKgPerS', 'outletFlowKgPerS', 'flowBalanceResidualKgPerS'],
  update: updateValveFlowDiagnostics,
})

const headerDiagnosticsBehavior = (componentKind: 'processHeader' | 'steamHeader'): ComponentBehaviorDefinition => ({
  id: `${componentKind}-mixing-diagnostics`,
  phase: 'updateComponentState',
  componentKind,
  reads: ['incoming:flowKgPerS', 'incoming:temperatureC', 'incoming:pressureMPa', 'outgoing:flowKgPerS'],
  writes: ['inletFlowKgPerS', 'outletFlowKgPerS', 'flowBalanceResidualKgPerS', 'mixedTemperatureC', 'mixedPressureMPa'],
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
