import { componentVariablePath, type ComponentBehaviorDefinition } from '../behavior-contract.ts'
import { approach, clamp, optionalParameterNumber, parameterNumber, relaxToward } from '../component-helpers.ts'
import {
  averageIncomingComponentLinkValue as averageIncomingLinkValue,
  sumIncomingComponentLinkValue as sumIncomingLinkValue,
  sumOutgoingComponentLinkValue as sumOutgoingLinkValue,
} from '../component-link-helpers.ts'
import { inventoryBalanceStep } from '../physics.ts'

export const balanceOfPlantBehaviorDefinitions: ReadonlyArray<ComponentBehaviorDefinition> = [
  {
    id: 'turbine-electrical-output',
    phase: 'solveElectrical',
    componentKind: 'turbineLoadSink',
    reads: ['loadFraction', 'steamFlowKgPerS', 'incoming:flowKgPerS', 'incoming:pressureMPa'],
    writes: ['electricMw', 'steamFlowKgPerS'],
    update: ({ system, component, context }): void => {
      const inletSteamFlow = averageIncomingLinkValue(system, component, 'flowKgPerS', context) ?? 0
      const averageSteamPressure = averageIncomingLinkValue(system, component, 'pressureMPa', context)
      const nominalSteamFlow = parameterNumber(component, 'nominalSteamFlowKgPerS')
      const load = clamp(context.readNumber(componentVariablePath(component, 'loadFraction')), 0, 1)
      const steamAvailability = clamp(inletSteamFlow / nominalSteamFlow, 0, 1.2)
      const pressureAvailability = clamp((averageSteamPressure ?? 6.9) / 6.9, 0, 1.2)
      const target = parameterNumber(component, 'nominalElectricMw') * load * Math.min(steamAvailability, pressureAvailability)
      const current = context.readNumber(componentVariablePath(component, 'electricMw'))
      context.write(componentVariablePath(component, 'steamFlowKgPerS'), inletSteamFlow)
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
    reads: ['steamFlowKgPerS', 'condensateTemperatureC', 'backPressurePa', 'incoming:flowKgPerS'],
    writes: [
      'steamFlowKgPerS',
      'condensateProductionKgPerS',
      'condensateInventoryKg',
      'condensateLevelPercent',
      'availableCondensateOutletFlowKgPerS',
      'condensateTemperatureC',
      'backPressurePa',
    ],
    update: ({ system, component, context }): void => {
      const steamFlow = averageIncomingLinkValue(system, component, 'flowKgPerS', context) ?? 0
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
      const targetBackPressure = 7_000 + clamp(steamFlow / nominalSteamFlow, 0, 1.5) * 5_000
      context.write(componentVariablePath(component, 'steamFlowKgPerS'), steamFlow)
      context.write(componentVariablePath(component, 'condensateProductionKgPerS'), condensateProduction)
      context.write(componentVariablePath(component, 'condensateInventoryKg'), nextInventory)
      context.write(componentVariablePath(component, 'condensateLevelPercent'), clamp((nextInventory / nominalInventory) * 100, 0, 100))
      context.write(componentVariablePath(component, 'availableCondensateOutletFlowKgPerS'), Math.min(maxOutletFlow, inventoryLimitedOutlet))
      context.write(componentVariablePath(component, 'condensateTemperatureC'), relaxToward(context.readNumber(componentVariablePath(component, 'condensateTemperatureC')), targetCondensateTemperature, context.dtSeconds, optionalParameterNumber(component, 'condenserThermalTimeConstantS', 12)))
      context.write(componentVariablePath(component, 'backPressurePa'), approach(context.readNumber(componentVariablePath(component, 'backPressurePa')), targetBackPressure, 500 * context.dtSeconds))
    },
  },
]
