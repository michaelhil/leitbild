import type { ComponentBehaviorDefinition } from '../behavior-contract.ts'
import { componentVariablePath } from '../behavior-contract.ts'
import {
  approach,
  clamp,
  hasComponentVariable,
  optionalParameterNumber,
  parameterNumber,
  relaxToward,
  sumComponentValueByKind,
} from '../component-helpers.ts'
import {
  averageIncomingComponentLinkValue as averageIncomingLinkValue,
  sumProcessLinkValueByService as sumLinkValueByService,
} from '../component-link-helpers.ts'
import { inventoryBalanceStep } from '../physics.ts'
import { waterDeltaTFromHeatMw } from '../thermophysics.ts'

export const reactorBehaviorDefinitions: ReadonlyArray<ComponentBehaviorDefinition> = [
  {
    id: 'reactor-core-reactivity-control',
    phase: 'updateControlLogic',
    componentKind: 'reactorCore',
    reads: ['rodInsertionFraction', 'reactivityPcm'],
    writes: ['reactivityPcm'],
    update: ({ component, context }): void => {
      if (!hasComponentVariable(component, 'rodInsertionFraction') || !hasComponentVariable(component, 'reactivityPcm')) return
      const rodInsertion = clamp(context.readNumber(componentVariablePath(component, 'rodInsertionFraction')), 0, 1)
      const targetReactivity = (0.5 - rodInsertion) * 1_200
      const reactivity = context.readNumber(componentVariablePath(component, 'reactivityPcm'))
      context.write(componentVariablePath(component, 'reactivityPcm'), approach(reactivity, targetReactivity, 500 * context.dtSeconds))
    },
  },
  {
    id: 'reactor-core-heat-to-coolant',
    phase: 'solveThermalTransfer',
    componentKind: 'reactorCore',
    reads: ['powerMw', 'decayHeatMw'],
    writes: ['heatToCoolantMw'],
    update: ({ component, context }): void => {
      const fissionPower = context.readNumber(componentVariablePath(component, 'powerMw'))
      const decayHeat = context.readNumber(componentVariablePath(component, 'decayHeatMw'))
      context.write(componentVariablePath(component, 'heatToCoolantMw'), Math.max(0, fissionPower + decayHeat))
    },
  },
  {
    id: 'reactor-core-power-state',
    phase: 'updateComponentState',
    componentKind: 'reactorCore',
    reads: ['rodInsertionFraction', 'reactivityPcm', 'powerMw', 'coolantOutletTemperatureC', 'fuelTemperatureC', 'decayHeatMw'],
    writes: ['powerMw', 'fuelTemperatureC', 'decayHeatMw'],
    update: ({ component, context }): void => {
      const ratedPower = parameterNumber(component, 'ratedPowerMw')
      const rodInsertion = clamp(context.readNumber(componentVariablePath(component, 'rodInsertionFraction')), 0, 1)
      const reactivity = context.readNumber(componentVariablePath(component, 'reactivityPcm'))
      const coolantOutlet = context.readNumber(componentVariablePath(component, 'coolantOutletTemperatureC'))
      const currentFuelTemperature = context.readNumber(componentVariablePath(component, 'fuelTemperatureC'))
      const referenceCoolantOutlet = optionalParameterNumber(component, 'referenceCoolantOutletTemperatureC', optionalParameterNumber(component, 'initialCoolantInletTemperatureC', 290) + 32)
      const referenceFuelTemperature = optionalParameterNumber(component, 'referenceFuelTemperatureC', referenceCoolantOutlet + optionalParameterNumber(component, 'fuelTemperatureRiseAtRatedPowerC', 140) * parameterNumber(component, 'initialPowerFraction'))
      const temperatureFeedbackPcm =
        (coolantOutlet - referenceCoolantOutlet) * optionalParameterNumber(component, 'coolantTemperatureFeedbackPcmPerC', 0)
        + (currentFuelTemperature - referenceFuelTemperature) * optionalParameterNumber(component, 'fuelTemperatureFeedbackPcmPerC', 0)
      const targetPower = ratedPower * clamp(1 - rodInsertion + (reactivity + temperatureFeedbackPcm) / 10_000, 0, 1.15)
      const currentPower = context.readNumber(componentVariablePath(component, 'powerMw'))
      const nextPower = approach(currentPower, targetPower, ratedPower * 0.08 * context.dtSeconds)
      context.write(componentVariablePath(component, 'powerMw'), nextPower)

      const decayTarget = Math.max(currentPower, nextPower) * optionalParameterNumber(component, 'decayHeatFractionAtPower', 0.06)
      const decayHeat = context.readNumber(componentVariablePath(component, 'decayHeatMw'))
      context.write(
        componentVariablePath(component, 'decayHeatMw'),
        relaxToward(decayHeat, decayTarget, context.dtSeconds, optionalParameterNumber(component, 'decayHeatTimeConstantS', 900)),
      )

      const fuelTemperatureTarget = coolantOutlet + optionalParameterNumber(component, 'fuelTemperatureRiseAtRatedPowerC', 140) * clamp(nextPower / ratedPower, 0, 1.2)
      context.write(
        componentVariablePath(component, 'fuelTemperatureC'),
        relaxToward(context.readNumber(componentVariablePath(component, 'fuelTemperatureC')), fuelTemperatureTarget, context.dtSeconds, optionalParameterNumber(component, 'fuelThermalTimeConstantS', 20)),
      )
    },
  },
  {
    id: 'reactor-core-coolant-temperature-state',
    phase: 'updateComponentState',
    componentKind: 'reactorCore',
    reads: ['coolantInletTemperatureC', 'coolantOutletTemperatureC', 'heatToCoolantMw', 'incoming:temperatureC', 'incoming:flowKgPerS'],
    writes: ['coolantInletTemperatureC', 'coolantOutletTemperatureC'],
    update: ({ system, component, context }): void => {
      const inletTemperature = averageIncomingLinkValue(system, component, 'temperatureC', context)
        ?? context.readNumber(componentVariablePath(component, 'coolantInletTemperatureC'))
      const flow = Math.max(1, averageIncomingLinkValue(system, component, 'flowKgPerS', context) ?? 1)
      const heatToCoolant = context.readNumber(componentVariablePath(component, 'heatToCoolantMw'))
      const outletTarget = clamp(inletTemperature + waterDeltaTFromHeatMw(heatToCoolant, flow), 220, 360)
      const currentOutlet = context.readNumber(componentVariablePath(component, 'coolantOutletTemperatureC'))
      const timeConstantSeconds = optionalParameterNumber(component, 'coolantThermalTimeConstantS', 8)
      context.write(componentVariablePath(component, 'coolantInletTemperatureC'), relaxToward(context.readNumber(componentVariablePath(component, 'coolantInletTemperatureC')), inletTemperature, context.dtSeconds, timeConstantSeconds))
      context.write(componentVariablePath(component, 'coolantOutletTemperatureC'), relaxToward(currentOutlet, outletTarget, context.dtSeconds, timeConstantSeconds))
    },
  },
  {
    id: 'reactor-vessel-primary-inventory-state',
    phase: 'updateComponentState',
    componentKind: 'reactorVessel',
    reads: ['primaryCoolantInventoryKg', 'charging:flowKgPerS', 'letdown:flowKgPerS', 'primaryRelief:flowKgPerS', 'primaryCoolant:leakFlowKgPerS', 'steamGenerator.primaryToSecondaryLeakKgPerS'],
    writes: [
      'primaryCoolantInventoryKg',
      'primaryCoolantInventoryDeviationKg',
      'primaryPressureBiasMPa',
      'chargingFlowKgPerS',
      'letdownFlowKgPerS',
      'reliefOutflowKgPerS',
      'primaryLeakFlowKgPerS',
      'tubeLeakFlowKgPerS',
      'netInventoryFlowKgPerS',
    ],
    update: ({ system, component, context }): void => {
      const nominalInventory = parameterNumber(component, 'nominalPrimaryCoolantInventoryKg')
      const currentInventory = context.readNumber(componentVariablePath(component, 'primaryCoolantInventoryKg'))
      const chargingFlow = sumLinkValueByService(system, 'flowKgPerS', context, 'charging', link => {
        const toComponent = system.graph.components[link.toComponentIndex]
        return toComponent?.kind === 'reactorCore' || toComponent?.kind === 'reactorVessel' || toComponent?.kind === 'pressurizer'
      })
      const letdownFlow = Math.max(
        sumLinkValueByService(system, 'flowKgPerS', context, 'letdown'),
        optionalParameterNumber(component, 'normalLetdownFlowKgPerS', 0),
      )
      const reliefFlow = sumLinkValueByService(system, 'flowKgPerS', context, 'primaryRelief')
      const primaryLeakFlow = sumLinkValueByService(system, 'leakFlowKgPerS', context, 'primaryCoolant')
      const tubeLeakFlow = sumComponentValueByKind(system, 'steamGenerator', 'primaryToSecondaryLeakKgPerS', context)
      const netInventoryFlow = chargingFlow - letdownFlow - reliefFlow - primaryLeakFlow - tubeLeakFlow
      const nextInventory = inventoryBalanceStep({
        currentInventory,
        inflowKgPerS: chargingFlow,
        outflowKgPerS: letdownFlow + reliefFlow + primaryLeakFlow + tubeLeakFlow,
        dtSeconds: context.dtSeconds,
        minInventory: 0,
        maxInventory: nominalInventory * 1.15,
      })
      const deviation = nextInventory - nominalInventory
      context.write(componentVariablePath(component, 'chargingFlowKgPerS'), chargingFlow)
      context.write(componentVariablePath(component, 'letdownFlowKgPerS'), letdownFlow)
      context.write(componentVariablePath(component, 'reliefOutflowKgPerS'), reliefFlow)
      context.write(componentVariablePath(component, 'primaryLeakFlowKgPerS'), primaryLeakFlow)
      context.write(componentVariablePath(component, 'tubeLeakFlowKgPerS'), tubeLeakFlow)
      context.write(componentVariablePath(component, 'netInventoryFlowKgPerS'), netInventoryFlow)
      context.write(componentVariablePath(component, 'primaryCoolantInventoryKg'), nextInventory)
      context.write(componentVariablePath(component, 'primaryCoolantInventoryDeviationKg'), deviation)
      context.write(componentVariablePath(component, 'primaryPressureBiasMPa'), deviation * optionalParameterNumber(component, 'primaryInventoryPressureGainMPaPerKg', 0))
    },
  },
]
