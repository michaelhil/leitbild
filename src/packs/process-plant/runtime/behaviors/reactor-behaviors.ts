import type { ComponentBehaviorDefinition } from '../behavior-contract.ts'
import { componentVariablePath } from '../behavior-contract.ts'
import {
  approach,
  clamp,
  findFirstComponentByKind,
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
import {
  inventoryBalanceStep,
  primaryCoolantCompressibilityPressureBiasMPa,
  primaryCoolantThermalExpansionPressureBiasMPa,
  reactorKineticsPowerStep,
} from '../physics.ts'
import { waterDeltaTFromHeatMw } from '../thermophysics.ts'

export const reactorBehaviorDefinitions: ReadonlyArray<ComponentBehaviorDefinition> = [
  {
    id: 'reactor-core-reactivity-control',
    phase: 'updateControlLogic',
    componentKind: 'reactorCore',
    reads: ['rodInsertionFraction', 'reactivityPcm'],
    writes: ['promptReactivityPcm', 'reactivityPcm'],
    update: ({ component, context }): void => {
      if (!hasComponentVariable(component, 'rodInsertionFraction') || !hasComponentVariable(component, 'reactivityPcm')) return
      const rodInsertion = clamp(context.readNumber(componentVariablePath(component, 'rodInsertionFraction')), 0, 1)
      const criticalRodInsertion = optionalParameterNumber(component, 'criticalRodInsertionFraction', clamp(1 - parameterNumber(component, 'initialPowerFraction'), 0, 1))
      const targetReactivity = (criticalRodInsertion - rodInsertion) * optionalParameterNumber(component, 'rodWorthPcm', 1_200)
      const reactivity = context.readNumber(componentVariablePath(component, 'reactivityPcm'))
      context.write(componentVariablePath(component, 'promptReactivityPcm'), targetReactivity)
      context.write(componentVariablePath(component, 'reactivityPcm'), approach(reactivity, targetReactivity, 500 * context.dtSeconds))
    },
  },
  {
    id: 'reactor-core-heat-to-coolant',
    phase: 'solveThermalTransfer',
    componentKind: 'reactorCore',
    reads: ['totalThermalPowerMw'],
    writes: ['heatToCoolantMw'],
    update: ({ component, context }): void => {
      context.write(componentVariablePath(component, 'heatToCoolantMw'), Math.max(0, context.readNumber(componentVariablePath(component, 'totalThermalPowerMw'))))
    },
  },
  {
    id: 'reactor-core-power-state',
    phase: 'updateComponentState',
    componentKind: 'reactorCore',
    reads: [
      'reactivityPcm',
      'powerMw',
      'coolantOutletTemperatureC',
      'fuelTemperatureC',
      'fuelLowerTemperatureC',
      'fuelMidTemperatureC',
      'fuelUpperTemperatureC',
      'decayHeatMw',
    ],
    writes: [
      'powerMw',
      'fissionPowerMw',
      'totalThermalPowerMw',
      'temperatureFeedbackPcm',
      'effectiveReactivityPcm',
      'fuelTemperatureC',
      'fuelLowerTemperatureC',
      'fuelMidTemperatureC',
      'fuelUpperTemperatureC',
      'fuelStoredEnergyMj',
      'decayHeatMw',
    ],
    update: ({ component, context }): void => {
      const ratedPower = parameterNumber(component, 'ratedPowerMw')
      const reactivity = context.readNumber(componentVariablePath(component, 'reactivityPcm'))
      const coolantOutlet = context.readNumber(componentVariablePath(component, 'coolantOutletTemperatureC'))
      const currentFuelTemperature = context.readNumber(componentVariablePath(component, 'fuelTemperatureC'))
      const referenceCoolantOutlet = optionalParameterNumber(component, 'referenceCoolantOutletTemperatureC', optionalParameterNumber(component, 'initialCoolantInletTemperatureC', 290) + 32)
      const referenceFuelTemperature = optionalParameterNumber(component, 'referenceFuelTemperatureC', referenceCoolantOutlet + optionalParameterNumber(component, 'fuelTemperatureRiseAtRatedPowerC', 140) * parameterNumber(component, 'initialPowerFraction'))
      const temperatureFeedbackPcm =
        (coolantOutlet - referenceCoolantOutlet) * optionalParameterNumber(component, 'coolantTemperatureFeedbackPcmPerC', 0)
        + (currentFuelTemperature - referenceFuelTemperature) * optionalParameterNumber(component, 'fuelTemperatureFeedbackPcmPerC', 0)
      const effectiveReactivity = reactivity + temperatureFeedbackPcm
      const currentPower = context.readNumber(componentVariablePath(component, 'powerMw'))
      const nextPower = reactorKineticsPowerStep({
        currentPowerMw: currentPower,
        ratedPowerMw: ratedPower,
        nominalCriticalPowerMw: ratedPower * parameterNumber(component, 'initialPowerFraction'),
        effectiveReactivityPcm: effectiveReactivity,
        dtSeconds: context.dtSeconds,
        pcmPerEfoldPerSecond: optionalParameterNumber(component, 'kineticsPcmPerEfoldPerSecond', 600),
        maxPowerRampFractionPerS: optionalParameterNumber(component, 'maxPowerRampFractionPerS', 0.18),
        maxPowerFraction: 1.2,
      })
      context.write(componentVariablePath(component, 'powerMw'), nextPower)
      context.write(componentVariablePath(component, 'fissionPowerMw'), nextPower)
      context.write(componentVariablePath(component, 'temperatureFeedbackPcm'), temperatureFeedbackPcm)
      context.write(componentVariablePath(component, 'effectiveReactivityPcm'), effectiveReactivity)

      const decayTarget = Math.max(currentPower, nextPower) * optionalParameterNumber(component, 'decayHeatFractionAtPower', 0.06)
      const decayHeat = context.readNumber(componentVariablePath(component, 'decayHeatMw'))
      const nextDecayHeat = relaxToward(decayHeat, decayTarget, context.dtSeconds, optionalParameterNumber(component, 'decayHeatTimeConstantS', 900))
      context.write(componentVariablePath(component, 'decayHeatMw'), nextDecayHeat)
      context.write(componentVariablePath(component, 'totalThermalPowerMw'), nextPower + nextDecayHeat)

      const thermalFraction = clamp((nextPower + nextDecayHeat) / ratedPower, 0, 1.25)
      const fuelRise = optionalParameterNumber(component, 'fuelTemperatureRiseAtRatedPowerC', 140) * thermalFraction
      const fuelTimeConstant = optionalParameterNumber(component, 'fuelThermalTimeConstantS', 20)
      const nextLower = relaxToward(context.readNumber(componentVariablePath(component, 'fuelLowerTemperatureC')), coolantOutlet + fuelRise * 0.88, context.dtSeconds, fuelTimeConstant)
      const nextMid = relaxToward(context.readNumber(componentVariablePath(component, 'fuelMidTemperatureC')), coolantOutlet + fuelRise * 1.08, context.dtSeconds, fuelTimeConstant)
      const nextUpper = relaxToward(context.readNumber(componentVariablePath(component, 'fuelUpperTemperatureC')), coolantOutlet + fuelRise * 1.00, context.dtSeconds, fuelTimeConstant)
      const nextAverageFuelTemperature = (nextLower + nextMid + nextUpper) / 3
      context.write(componentVariablePath(component, 'fuelLowerTemperatureC'), nextLower)
      context.write(componentVariablePath(component, 'fuelMidTemperatureC'), nextMid)
      context.write(componentVariablePath(component, 'fuelUpperTemperatureC'), nextUpper)
      context.write(componentVariablePath(component, 'fuelTemperatureC'), nextAverageFuelTemperature)
      context.write(componentVariablePath(component, 'fuelStoredEnergyMj'), Math.max(0, nextAverageFuelTemperature - coolantOutlet) * parameterNumber(component, 'fuelThermalCapacityMjPerC'))
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
      'meanPrimaryCoolantTemperatureC',
      'compressibilityPressureBiasMPa',
      'thermalExpansionPressureBiasMPa',
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
      const core = findFirstComponentByKind(system, 'reactorCore')
      const meanPrimaryCoolantTemperature = core === null
        ? parameterNumber(component, 'referencePrimaryCoolantTemperatureC')
        : (
          context.readNumber(componentVariablePath(core, 'coolantInletTemperatureC'))
          + context.readNumber(componentVariablePath(core, 'coolantOutletTemperatureC'))
        ) / 2
      const compressibilityPressureBias = primaryCoolantCompressibilityPressureBiasMPa({
        inventoryKg: nextInventory,
        referenceVolumeM3: parameterNumber(component, 'primaryCoolantVolumeM3'),
        densityKgPerM3: parameterNumber(component, 'nominalPrimaryCoolantDensityKgPerM3'),
        effectiveBulkModulusMPa: parameterNumber(component, 'effectiveBulkModulusMPa'),
      })
      const thermalExpansionPressureBias = primaryCoolantThermalExpansionPressureBiasMPa({
        meanTemperatureC: meanPrimaryCoolantTemperature,
        referenceTemperatureC: parameterNumber(component, 'referencePrimaryCoolantTemperatureC'),
        thermalExpansionCoefficientPerC: parameterNumber(component, 'thermalExpansionCoefficientPerC'),
        effectiveBulkModulusMPa: parameterNumber(component, 'effectiveBulkModulusMPa'),
      })
      context.write(componentVariablePath(component, 'chargingFlowKgPerS'), chargingFlow)
      context.write(componentVariablePath(component, 'letdownFlowKgPerS'), letdownFlow)
      context.write(componentVariablePath(component, 'reliefOutflowKgPerS'), reliefFlow)
      context.write(componentVariablePath(component, 'primaryLeakFlowKgPerS'), primaryLeakFlow)
      context.write(componentVariablePath(component, 'tubeLeakFlowKgPerS'), tubeLeakFlow)
      context.write(componentVariablePath(component, 'netInventoryFlowKgPerS'), netInventoryFlow)
      context.write(componentVariablePath(component, 'primaryCoolantInventoryKg'), nextInventory)
      context.write(componentVariablePath(component, 'primaryCoolantInventoryDeviationKg'), deviation)
      context.write(componentVariablePath(component, 'meanPrimaryCoolantTemperatureC'), meanPrimaryCoolantTemperature)
      context.write(componentVariablePath(component, 'compressibilityPressureBiasMPa'), compressibilityPressureBias)
      context.write(componentVariablePath(component, 'thermalExpansionPressureBiasMPa'), thermalExpansionPressureBias)
      context.write(componentVariablePath(component, 'primaryPressureBiasMPa'), compressibilityPressureBias + thermalExpansionPressureBias)
    },
  },
]
