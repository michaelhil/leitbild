import { primaryLoopIdForPump } from '../../graph/index.ts'
import { clamp, optionalParameterBoolean, optionalParameterNumber, parameterNumber } from '../component-helpers.ts'
import type { ComponentInitialValueDefinition } from './model.ts'

export const reactorInitialValueDefinitions: ReadonlyArray<ComponentInitialValueDefinition> = [
  {
    componentKind: 'reactorCore',
    initialValueFor: (component, localPath) => {
      const ratedPowerMw = parameterNumber(component, 'ratedPowerMw')
      const initialPowerFraction = parameterNumber(component, 'initialPowerFraction')
      const initialFissionPower = ratedPowerMw * initialPowerFraction
      const initialCoolantInlet = optionalParameterNumber(component, 'initialCoolantInletTemperatureC', 290)
      const initialCoolantOutlet = initialCoolantInlet + 32
      const initialFuelRise = optionalParameterNumber(component, 'fuelTemperatureRiseAtRatedPowerC', 140) * initialPowerFraction
      const initialFuelLower = initialCoolantOutlet + initialFuelRise * 0.88
      const initialFuelMid = initialCoolantOutlet + initialFuelRise * 1.08
      const initialFuelUpper = initialCoolantOutlet + initialFuelRise * 1.00
      const initialFuelAverage = (initialFuelLower + initialFuelMid + initialFuelUpper) / 3
      const initialDecayHeat = initialFissionPower * optionalParameterNumber(component, 'decayHeatFractionAtPower', 0.06)
      if (localPath === 'powerMw') return initialFissionPower
      if (localPath === 'fissionPowerMw') return initialFissionPower
      if (localPath === 'totalThermalPowerMw') return initialFissionPower + initialDecayHeat
      if (localPath === 'reactivityPcm') return 0
      if (localPath === 'promptReactivityPcm') return 0
      if (localPath === 'temperatureFeedbackPcm') return 0
      if (localPath === 'effectiveReactivityPcm') return 0
      if (localPath === 'rodInsertionFraction') return optionalParameterNumber(component, 'criticalRodInsertionFraction', clamp(1 - initialPowerFraction, 0, 1))
      if (localPath === 'coolantInletTemperatureC') return initialCoolantInlet
      if (localPath === 'coolantOutletTemperatureC') return initialCoolantOutlet
      if (localPath === 'fuelTemperatureC') return initialFuelAverage
      if (localPath === 'fuelLowerTemperatureC') return initialFuelLower
      if (localPath === 'fuelMidTemperatureC') return initialFuelMid
      if (localPath === 'fuelUpperTemperatureC') return initialFuelUpper
      if (localPath === 'fuelStoredEnergyMj') return Math.max(0, initialFuelAverage - initialCoolantOutlet) * parameterNumber(component, 'fuelThermalCapacityMjPerC')
      if (localPath === 'decayHeatMw') return initialDecayHeat
      if (localPath === 'heatToCoolantMw') return initialFissionPower + initialDecayHeat
      return undefined
    },
  },
  {
    componentKind: 'reactorVessel',
    initialValueFor: (component, localPath) => {
      const nominalInventory = parameterNumber(component, 'nominalPrimaryCoolantInventoryKg')
      const initialFraction = parameterNumber(component, 'initialPrimaryCoolantInventoryFraction')
      if (localPath === 'primaryCoolantInventoryKg') return nominalInventory * initialFraction
      if (localPath === 'primaryCoolantInventoryDeviationKg') return nominalInventory * (initialFraction - 1)
      if (localPath === 'meanPrimaryCoolantTemperatureC') return parameterNumber(component, 'referencePrimaryCoolantTemperatureC')
      if (localPath === 'compressibilityPressureBiasMPa') return 0
      if (localPath === 'thermalExpansionPressureBiasMPa') return 0
      if (localPath === 'primaryPressureBiasMPa') return 0
      if (localPath === 'chargingFlowKgPerS') return 0
      if (localPath === 'safetyInjectionFlowKgPerS') return 0
      if (localPath === 'letdownFlowKgPerS') return optionalParameterNumber(component, 'normalLetdownFlowKgPerS', 0)
      if (localPath === 'reliefOutflowKgPerS') return 0
      if (localPath === 'primaryLeakFlowKgPerS') return 0
      if (localPath === 'tubeLeakFlowKgPerS') return 0
      if (localPath === 'netInventoryFlowKgPerS') return -optionalParameterNumber(component, 'normalLetdownFlowKgPerS', 0)
      if (localPath === 'primaryReleaseRadiationMSvPerH') return optionalParameterNumber(component, 'primaryReleaseRadiationMSvPerH', 0.02)
      return undefined
    },
  },
  {
    componentKind: 'centrifugalPump',
    initialValueFor: (component, localPath) => {
      const running = optionalParameterBoolean(component, 'initialRunning', true)
      const primaryLoopId = primaryLoopIdForPump(component)
      if (localPath === 'running') return running
      if (localPath === 'speedFraction') return 1
      if (localPath === 'flowKgPerS') return running ? parameterNumber(component, 'nominalFlowKgPerS') : 0
      if (localPath === 'developedHeadPa') return running ? parameterNumber(component, 'nominalHeadPa') : 0
      if (localPath === 'loopFlowTargetKgPerS') return primaryLoopId === null ? 0 : running ? parameterNumber(component, 'nominalFlowKgPerS') : optionalParameterNumber(component, 'minimumNaturalCirculationFlowKgPerS', 0)
      if (localPath === 'loopFlowKgPerS') return primaryLoopId === null ? 0 : running ? parameterNumber(component, 'nominalFlowKgPerS') : optionalParameterNumber(component, 'minimumNaturalCirculationFlowKgPerS', 0)
      return undefined
    },
  },
]
