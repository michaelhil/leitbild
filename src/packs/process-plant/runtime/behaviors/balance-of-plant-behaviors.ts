import type { CompiledComponent } from '../../graph/index.ts'
import type { CompiledProcessPlantSystem } from '../../process-systems.ts'
import { componentVariablePath, type ComponentBehaviorDefinition, type ProcessPlantBehaviorContext } from '../behavior-contract.ts'
import { approach, clamp, optionalParameterNumber, parameterNumber, relaxToward } from '../component-helpers.ts'
import {
  averageIncomingComponentLinkValue as averageIncomingLinkValue,
  sumIncomingComponentLinkValue as sumIncomingLinkValue,
  sumOutgoingComponentLinkValue as sumOutgoingLinkValue,
} from '../component-link-helpers.ts'
import { inventoryBalanceStep } from '../physics.ts'
import { heatMwFromWaterFlowAndDeltaT, latentHeatSteamMjPerKg } from '../thermophysics.ts'

const downstreamCondenserBackPressurePa = (
  system: CompiledProcessPlantSystem,
  component: CompiledComponent,
  context: ProcessPlantBehaviorContext,
): number | null => {
  for (const linkIndex of system.graph.outgoingLinksByComponent[component.index] ?? []) {
    const link = system.graph.links[linkIndex]
    if (!link || link.kind !== 'fluidFlow') continue
    const toComponent = system.graph.components[link.toComponentIndex]
    if (toComponent?.kind !== 'condenserSink') continue
    return context.readNumber(componentVariablePath(toComponent, 'backPressurePa'))
  }
  return null
}

const condenserBackPressureAvailability = (backPressurePa: number | null): number => {
  if (backPressurePa === null) return 1
  return clamp(1 - Math.max(0, backPressurePa - 12_000) / 55_000, 0.25, 1)
}

export const balanceOfPlantBehaviorDefinitions: ReadonlyArray<ComponentBehaviorDefinition> = [
  {
    id: 'turbine-electrical-output',
    phase: 'solveElectrical',
    componentKind: 'turbineLoadSink',
    reads: ['loadFraction', 'steamFlowKgPerS', 'incoming:flowKgPerS', 'incoming:pressureMPa'],
    writes: ['electricMw', 'steamFlowKgPerS', 'steamDemandKgPerS', 'steamAvailabilityFraction', 'exhaustTemperatureC'],
    update: ({ system, component, context }): void => {
      const inletSteamFlow = averageIncomingLinkValue(system, component, 'flowKgPerS', context) ?? 0
      const averageSteamPressure = averageIncomingLinkValue(system, component, 'pressureMPa', context)
      const nominalSteamFlow = parameterNumber(component, 'nominalSteamFlowKgPerS')
      const load = clamp(context.readNumber(componentVariablePath(component, 'loadFraction')), 0, 1)
      const backPressurePa = downstreamCondenserBackPressurePa(system, component, context)
      const backPressureAvailability = condenserBackPressureAvailability(backPressurePa)
      const steamDemand = nominalSteamFlow * load * backPressureAvailability
      const steamAvailability = clamp(inletSteamFlow / nominalSteamFlow, 0, 1.2)
      const pressureAvailability = clamp((averageSteamPressure ?? 6.9) / 6.9, 0, 1.2)
      const target = parameterNumber(component, 'nominalElectricMw') * load * Math.min(steamAvailability, pressureAvailability, backPressureAvailability)
      const current = context.readNumber(componentVariablePath(component, 'electricMw'))
      const noLoadExhaust = optionalParameterNumber(component, 'exhaustTemperatureAtNoLoadC', 105)
      const fullLoadExhaust = optionalParameterNumber(component, 'exhaustTemperatureAtFullLoadC', 145)
      const exhaustTarget = noLoadExhaust + (fullLoadExhaust - noLoadExhaust) * clamp(Math.min(steamAvailability, load), 0, 1)
      context.write(componentVariablePath(component, 'steamDemandKgPerS'), steamDemand)
      context.write(componentVariablePath(component, 'steamAvailabilityFraction'), clamp(inletSteamFlow / Math.max(1, steamDemand), 0, 1))
      context.write(componentVariablePath(component, 'steamFlowKgPerS'), inletSteamFlow)
      context.write(componentVariablePath(component, 'exhaustTemperatureC'), relaxToward(context.readNumber(componentVariablePath(component, 'exhaustTemperatureC')), exhaustTarget, context.dtSeconds, optionalParameterNumber(component, 'electricalTimeConstantS', 5)))
      context.write(
        componentVariablePath(component, 'electricMw'),
        relaxToward(current, target, context.dtSeconds, optionalParameterNumber(component, 'electricalTimeConstantS', 5)),
      )
    },
  },
  {
    id: 'process-tank-inventory-state',
    phase: 'updateComponentState',
    componentKind: 'processTank',
    reads: [
      'inventoryKg',
      'levelPercent',
      'temperatureC',
      'makeupFlowKgPerS',
      'incoming:flowKgPerS',
      'incoming:temperatureC',
      'outgoing:flowKgPerS',
    ],
    writes: ['inventoryKg', 'levelPercent', 'temperatureC', 'availableOutletFlowKgPerS'],
    update: ({ system, component, context }): void => {
      const nominalInventory = parameterNumber(component, 'nominalInventoryKg')
      const currentInventory = context.readNumber(componentVariablePath(component, 'inventoryKg'))
      const incomingFlow = sumIncomingLinkValue(system, component, 'flowKgPerS', context)
      const outgoingFlow = sumOutgoingLinkValue(system, component, 'flowKgPerS', context)
      const makeupFlow = clamp(context.readNumber(componentVariablePath(component, 'makeupFlowKgPerS')), 0, parameterNumber(component, 'maxOutletFlowKgPerS'))
      const nextInventory = inventoryBalanceStep({
        currentInventory,
        inflowKgPerS: incomingFlow + makeupFlow,
        outflowKgPerS: outgoingFlow,
        dtSeconds: context.dtSeconds,
        minInventory: 0,
        maxInventory: nominalInventory,
      })
      const nextLevel = clamp((nextInventory / nominalInventory) * 100, 0, 100)
      const maxOutletFlow = parameterNumber(component, 'maxOutletFlowKgPerS')
      const inventoryLimitedOutlet = context.dtSeconds > 0 ? nextInventory / context.dtSeconds : maxOutletFlow
      const nextAvailableOutletFlow = Math.min(maxOutletFlow, inventoryLimitedOutlet)
      const incomingTemperature = averageIncomingLinkValue(system, component, 'temperatureC', context)
      const targetTemperature = incomingTemperature ?? parameterNumber(component, 'initialTemperatureC')
      context.write(componentVariablePath(component, 'inventoryKg'), nextInventory)
      context.write(componentVariablePath(component, 'levelPercent'), nextLevel)
      context.write(componentVariablePath(component, 'availableOutletFlowKgPerS'), nextAvailableOutletFlow)
      context.write(
        componentVariablePath(component, 'temperatureC'),
        relaxToward(
          context.readNumber(componentVariablePath(component, 'temperatureC')),
          targetTemperature,
          context.dtSeconds,
          optionalParameterNumber(component, 'thermalTimeConstantS', 30),
        ),
      )
    },
  },
  {
    id: 'condenser-steam-sink-state',
    phase: 'updateComponentState',
    componentKind: 'condenserSink',
    reads: ['steamFlowKgPerS', 'condensateTemperatureC', 'backPressurePa', 'incoming:flowKgPerS', 'incoming:temperatureC'],
    writes: [
      'steamFlowKgPerS',
      'condensateProductionKgPerS',
      'heatRejectedMw',
      'condensateInventoryKg',
      'condensateLevelPercent',
      'availableCondensateOutletFlowKgPerS',
      'condensateTemperatureC',
      'backPressurePa',
    ],
    update: ({ system, component, context }): void => {
      const steamFlow = averageIncomingLinkValue(system, component, 'flowKgPerS', context) ?? 0
      const steamTemperature = averageIncomingLinkValue(system, component, 'temperatureC', context)
        ?? optionalParameterNumber(component, 'exhaustCondensationTemperatureC', 120)
      const nominalSteamFlow = parameterNumber(component, 'nominalSteamFlowKgPerS')
      const condensateProduction = steamFlow
      const outgoingCondensateFlow = sumOutgoingLinkValue(system, component, 'flowKgPerS', context, link => link.service === 'condensate')
      const nominalInventory = parameterNumber(component, 'nominalCondensateInventoryKg')
      const currentInventory = context.readNumber(componentVariablePath(component, 'condensateInventoryKg'))
      const nextInventory = inventoryBalanceStep({
        currentInventory,
        inflowKgPerS: condensateProduction,
        outflowKgPerS: outgoingCondensateFlow,
        dtSeconds: context.dtSeconds,
        minInventory: 0,
        maxInventory: nominalInventory,
      })
      const maxOutletFlow = parameterNumber(component, 'maxCondensateOutletFlowKgPerS')
      const inventoryLimitedOutlet = context.dtSeconds > 0 ? nextInventory / context.dtSeconds : maxOutletFlow
      const targetCondensateTemperature = parameterNumber(component, 'coolingWaterTemperatureC')
        + parameterNumber(component, 'condensateApproachTemperatureK')
        + clamp(steamFlow / nominalSteamFlow, 0, 1.5) * 18
        + clamp((steamTemperature - 120) / 80, 0, 1) * 8
      const sensibleHeatMw = heatMwFromWaterFlowAndDeltaT(steamFlow, Math.max(0, steamTemperature - targetCondensateTemperature))
      const latentHeatMw = steamFlow * latentHeatSteamMjPerKg
      const heatRejected = latentHeatMw + sensibleHeatMw
      const targetBackPressure = 7_000
        + clamp(steamFlow / nominalSteamFlow, 0, 1.5) * 5_000
        + clamp((parameterNumber(component, 'coolingWaterTemperatureC') - 28) / 70, 0, 1) * 35_000
        + clamp((targetCondensateTemperature - (parameterNumber(component, 'coolingWaterTemperatureC') + parameterNumber(component, 'condensateApproachTemperatureK'))) / 30, 0, 1) * 2_000
      context.write(componentVariablePath(component, 'steamFlowKgPerS'), steamFlow)
      context.write(componentVariablePath(component, 'condensateProductionKgPerS'), condensateProduction)
      context.write(componentVariablePath(component, 'heatRejectedMw'), heatRejected)
      context.write(componentVariablePath(component, 'condensateInventoryKg'), nextInventory)
      context.write(componentVariablePath(component, 'condensateLevelPercent'), clamp((nextInventory / nominalInventory) * 100, 0, 100))
      context.write(componentVariablePath(component, 'availableCondensateOutletFlowKgPerS'), Math.min(maxOutletFlow, inventoryLimitedOutlet))
      context.write(componentVariablePath(component, 'condensateTemperatureC'), relaxToward(context.readNumber(componentVariablePath(component, 'condensateTemperatureC')), targetCondensateTemperature, context.dtSeconds, optionalParameterNumber(component, 'condenserThermalTimeConstantS', 12)))
      context.write(componentVariablePath(component, 'backPressurePa'), approach(context.readNumber(componentVariablePath(component, 'backPressurePa')), targetBackPressure, 500 * context.dtSeconds))
    },
  },
]
