import type { CompiledComponent } from '../../graph/index.ts'
import {
  componentVariablePath,
  type ComponentBehaviorDefinition,
  type ComponentInitialReconciliationDefinition,
  type ProcessPlantBehaviorContext,
} from '../behavior-contract.ts'
import { clamp, optionalParameterNumber, parameterNumber } from '../component-helpers.ts'
import type { CompiledProcessPlantSystem } from '../../process-systems.ts'

const sourcePowerForComponent = (
  source: CompiledComponent,
  context: ProcessPlantBehaviorContext,
): { readonly energized: boolean; readonly availablePowerMw: number } => {
  if (source.kind === 'turbineLoadSink') {
    const electricPath = componentVariablePath(source, 'electricMw')
    const electricMw = context.has(electricPath) ? context.readNumber(electricPath) : 0
    return {
      energized: electricMw > 0,
      availablePowerMw: Math.max(0, electricMw),
    }
  }

  const energizedPath = componentVariablePath(source, 'energized')
  const availablePath = componentVariablePath(source, 'availablePowerMw')
  return {
    energized: context.has(energizedPath) ? context.readBoolean(energizedPath) : false,
    availablePowerMw: context.has(availablePath) ? context.readNumber(availablePath) : 0,
  }
}

export const incomingElectricalPower = (
  system: CompiledProcessPlantSystem,
  component: CompiledComponent,
  context: ProcessPlantBehaviorContext,
): { readonly energized: boolean; readonly availablePowerMw: number } => {
  let availablePowerMw = 0
  for (const linkIndex of system.graph.incomingLinksByComponent[component.index] ?? []) {
    const link = system.graph.links[linkIndex]
    if (!link || link.kind !== 'electricalPower') continue
    const source = system.graph.components[link.fromComponentIndex]
    if (!source) continue
    const sourcePower = sourcePowerForComponent(source, context)
    if (!sourcePower.energized) continue
    availablePowerMw += sourcePower.availablePowerMw
  }
  return {
    energized: availablePowerMw > 0,
    availablePowerMw,
  }
}

const hasIncomingElectricalPowerPort = (
  system: CompiledProcessPlantSystem,
  component: CompiledComponent,
): boolean =>
  (system.graph.incomingLinksByComponent[component.index] ?? [])
    .some(linkIndex => system.graph.links[linkIndex]?.kind === 'electricalPower')

export const componentHasElectricalPower = (
  system: CompiledProcessPlantSystem,
  component: CompiledComponent,
  context: ProcessPlantBehaviorContext,
): boolean => {
  if (!hasIncomingElectricalPowerPort(system, component)) return true
  return incomingElectricalPower(system, component, context).energized
}

const outgoingLoadDemand = (
  system: CompiledProcessPlantSystem,
  component: CompiledComponent,
  context: ProcessPlantBehaviorContext,
): number => {
  let demand = 0
  for (const linkIndex of system.graph.outgoingLinksByComponent[component.index] ?? []) {
    const link = system.graph.links[linkIndex]
    if (!link || link.kind !== 'electricalPower') continue
    const target = system.graph.components[link.toComponentIndex]
    if (!target) continue
    if (target.kind === 'electricalLoad') {
      demand += parameterNumber(target, 'nominalLoadMw')
      continue
    }
    const demandPath = componentVariablePath(target, 'demandMw')
    if (context.has(demandPath)) demand += context.readNumber(demandPath)
  }
  return demand
}

const passThroughAvailablePower = (
  system: CompiledProcessPlantSystem,
  component: CompiledComponent,
  context: ProcessPlantBehaviorContext,
  capacityMw: number,
  efficiencyFraction = 1,
): { readonly energized: boolean; readonly availablePowerMw: number } => {
  const incoming = incomingElectricalPower(system, component, context)
  const availablePowerMw = incoming.energized ? Math.min(capacityMw, incoming.availablePowerMw * efficiencyFraction) : 0
  return {
    energized: availablePowerMw > 0,
    availablePowerMw,
  }
}

const gridSourceBehavior: ComponentBehaviorDefinition = {
  id: 'electrical-grid-source',
  phase: 'solveElectrical',
  componentKind: 'electricalGridSource',
  reads: ['available'],
  writes: ['energized', 'availablePowerMw'],
  update: ({ component, context }): void => {
    const available = context.readBoolean(componentVariablePath(component, 'available'))
    context.write(componentVariablePath(component, 'energized'), available)
    context.write(componentVariablePath(component, 'availablePowerMw'), available ? parameterNumber(component, 'nominalPowerMw') : 0)
  },
}

const busBehavior: ComponentBehaviorDefinition = {
  id: 'electrical-bus-propagation',
  phase: 'solveElectrical',
  componentKind: 'electricalBus',
  reads: ['incoming electrical availablePowerMw', 'outgoing electrical demandMw'],
  writes: ['energized', 'availablePowerMw', 'servedLoadMw', 'marginMw'],
  update: ({ system, component, context }): void => {
    const incoming = incomingElectricalPower(system, component, context)
    const capacity = parameterNumber(component, 'nominalPowerMw')
    const availablePower = incoming.energized ? Math.min(capacity, incoming.availablePowerMw) : 0
    const servedLoad = Math.min(availablePower, outgoingLoadDemand(system, component, context))
    context.write(componentVariablePath(component, 'energized'), availablePower > 0)
    context.write(componentVariablePath(component, 'availablePowerMw'), availablePower)
    context.write(componentVariablePath(component, 'servedLoadMw'), servedLoad)
    context.write(componentVariablePath(component, 'marginMw'), availablePower - servedLoad)
  },
}

const breakerBehavior: ComponentBehaviorDefinition = {
  id: 'electrical-breaker-propagation',
  phase: 'solveElectrical',
  componentKind: 'electricalBreaker',
  reads: ['closed', 'tripped', 'incoming electrical availablePowerMw'],
  writes: ['energized', 'availablePowerMw'],
  update: ({ system, component, context }): void => {
    const incoming = incomingElectricalPower(system, component, context)
    const closed = context.readBoolean(componentVariablePath(component, 'closed'))
    const tripped = context.readBoolean(componentVariablePath(component, 'tripped'))
    const conductive = incoming.energized && closed && !tripped
    context.write(componentVariablePath(component, 'energized'), conductive)
    context.write(componentVariablePath(component, 'availablePowerMw'), conductive ? Math.min(parameterNumber(component, 'nominalPowerMw'), incoming.availablePowerMw) : 0)
  },
}

const transformerBehavior: ComponentBehaviorDefinition = {
  id: 'electrical-transformer-propagation',
  phase: 'solveElectrical',
  componentKind: 'electricalTransformer',
  reads: ['incoming electrical availablePowerMw', 'outgoing electrical demandMw'],
  writes: ['energized', 'availablePowerMw', 'loadMw'],
  update: ({ system, component, context }): void => {
    const result = passThroughAvailablePower(system, component, context, parameterNumber(component, 'nominalPowerMw'), optionalParameterNumber(component, 'efficiencyFraction', 0.99))
    context.write(componentVariablePath(component, 'energized'), result.energized)
    context.write(componentVariablePath(component, 'availablePowerMw'), result.availablePowerMw)
    context.write(componentVariablePath(component, 'loadMw'), Math.min(result.availablePowerMw, outgoingLoadDemand(system, component, context)))
  },
}

const dieselGeneratorBehavior: ComponentBehaviorDefinition = {
  id: 'diesel-generator-start-and-power',
  phase: 'solveElectrical',
  componentKind: 'dieselGenerator',
  reads: ['startCommand', 'available', 'running', 'startElapsedS'],
  writes: ['running', 'startElapsedS', 'energized', 'availablePowerMw'],
  update: ({ component, context }): void => {
    const startCommand = context.readBoolean(componentVariablePath(component, 'startCommand'))
    const available = context.readBoolean(componentVariablePath(component, 'available'))
    const startDelay = optionalParameterNumber(component, 'startDelayS', 10)
    const elapsed = startCommand && available
      ? Math.min(startDelay, context.readNumber(componentVariablePath(component, 'startElapsedS')) + context.dtSeconds)
      : 0
    const running = available && startCommand && elapsed >= startDelay
    context.write(componentVariablePath(component, 'startElapsedS'), elapsed)
    context.write(componentVariablePath(component, 'running'), running)
    context.write(componentVariablePath(component, 'energized'), running)
    context.write(componentVariablePath(component, 'availablePowerMw'), running ? parameterNumber(component, 'nominalPowerMw') : 0)
  },
}

const batteryBehavior: ComponentBehaviorDefinition = {
  id: 'battery-discharge',
  phase: 'solveElectrical',
  componentKind: 'battery',
  reads: ['stateOfChargeFraction'],
  writes: ['stateOfChargeFraction', 'energized', 'availablePowerMw'],
  update: ({ system, component, context }): void => {
    const demand = outgoingLoadDemand(system, component, context)
    const dischargeTime = parameterNumber(component, 'dischargeTimeS')
    const nominalPower = parameterNumber(component, 'nominalPowerMw')
    const currentCharge = clamp(context.readNumber(componentVariablePath(component, 'stateOfChargeFraction')), 0, 1)
    const usedFraction = demand > 0 && nominalPower > 0
      ? (Math.min(demand, nominalPower) / nominalPower) * (context.dtSeconds / dischargeTime)
      : 0
    const nextCharge = clamp(currentCharge - usedFraction, 0, 1)
    context.write(componentVariablePath(component, 'stateOfChargeFraction'), nextCharge)
    context.write(componentVariablePath(component, 'energized'), nextCharge > 0)
    context.write(componentVariablePath(component, 'availablePowerMw'), nextCharge > 0 ? nominalPower : 0)
  },
}

const inverterBehavior: ComponentBehaviorDefinition = {
  id: 'inverter-propagation',
  phase: 'solveElectrical',
  componentKind: 'inverter',
  reads: ['incoming electrical availablePowerMw'],
  writes: ['energized', 'availablePowerMw'],
  update: ({ system, component, context }): void => {
    const result = passThroughAvailablePower(system, component, context, parameterNumber(component, 'nominalPowerMw'), optionalParameterNumber(component, 'efficiencyFraction', 0.95))
    context.write(componentVariablePath(component, 'energized'), result.energized)
    context.write(componentVariablePath(component, 'availablePowerMw'), result.availablePowerMw)
  },
}

const loadBehavior: ComponentBehaviorDefinition = {
  id: 'electrical-load-service',
  phase: 'solveElectrical',
  componentKind: 'electricalLoad',
  reads: ['incoming electrical availablePowerMw'],
  writes: ['demandMw', 'servedMw', 'servedFraction', 'energized'],
  update: ({ system, component, context }): void => {
    const demand = parameterNumber(component, 'nominalLoadMw')
    const incoming = incomingElectricalPower(system, component, context)
    const served = incoming.energized ? Math.min(demand, incoming.availablePowerMw) : 0
    context.write(componentVariablePath(component, 'demandMw'), demand)
    context.write(componentVariablePath(component, 'servedMw'), served)
    context.write(componentVariablePath(component, 'servedFraction'), demand <= 0 ? 1 : clamp(served / demand, 0, 1))
    context.write(componentVariablePath(component, 'energized'), served > 0 || demand <= 0)
  },
}

export const electricalBehaviorDefinitions: ReadonlyArray<ComponentBehaviorDefinition> = [
  gridSourceBehavior,
  dieselGeneratorBehavior,
  batteryBehavior,
  breakerBehavior,
  transformerBehavior,
  inverterBehavior,
  busBehavior,
  loadBehavior,
]

export const electricalInitialReconciliationDefinitions: ReadonlyArray<ComponentInitialReconciliationDefinition> = [
  {
    id: 'electrical-initial-state',
    componentKind: 'electricalBus',
    reads: ['incoming electrical availablePowerMw'],
    writes: ['energized', 'availablePowerMw', 'servedLoadMw', 'marginMw'],
    reconcile: busBehavior.update,
  },
]
