import { optionalParameterNumber, parameterNumber } from '../component-helpers.ts'
import type { ComponentInitialValueDefinition } from './model.ts'

export const balanceOfPlantInitialValueDefinitions: ReadonlyArray<ComponentInitialValueDefinition> = [
  {
    componentKind: 'processTank',
    initialValueFor: (component, localPath) => {
      const nominalInventory = parameterNumber(component, 'nominalInventoryKg')
      const initialFraction = parameterNumber(component, 'initialInventoryFraction')
      if (localPath === 'inventoryKg') return nominalInventory * initialFraction
      if (localPath === 'levelPercent') return initialFraction * 100
      if (localPath === 'temperatureC') return parameterNumber(component, 'initialTemperatureC')
      if (localPath === 'makeupFlowKgPerS') return parameterNumber(component, 'makeupFlowKgPerS')
      if (localPath === 'availableOutletFlowKgPerS') return parameterNumber(component, 'maxOutletFlowKgPerS')
      return undefined
    },
  },
  {
    componentKind: 'turbineLoadSink',
    initialValueFor: (component, localPath) => {
      const initialLoadFraction = parameterNumber(component, 'initialLoadFraction')
      if (localPath === 'electricMw') return parameterNumber(component, 'nominalElectricMw') * initialLoadFraction
      if (localPath === 'loadFraction') return initialLoadFraction
      if (localPath === 'steamFlowKgPerS') return parameterNumber(component, 'nominalSteamFlowKgPerS') * initialLoadFraction
      if (localPath === 'steamDemandKgPerS') return parameterNumber(component, 'nominalSteamFlowKgPerS') * initialLoadFraction
      if (localPath === 'steamAvailabilityFraction') return 1
      if (localPath === 'exhaustTemperatureC') {
        const noLoad = optionalParameterNumber(component, 'exhaustTemperatureAtNoLoadC', 105)
        const fullLoad = optionalParameterNumber(component, 'exhaustTemperatureAtFullLoadC', 145)
        return noLoad + (fullLoad - noLoad) * initialLoadFraction
      }
      return undefined
    },
  },
  {
    componentKind: 'condenserSink',
    initialValueFor: (component, localPath) => {
      if (localPath === 'steamFlowKgPerS') return 0
      if (localPath === 'condensateProductionKgPerS') return 0
      if (localPath === 'heatRejectedMw') return 0
      if (localPath === 'condensateInventoryKg') return parameterNumber(component, 'nominalCondensateInventoryKg') * parameterNumber(component, 'initialCondensateInventoryFraction')
      if (localPath === 'condensateLevelPercent') return parameterNumber(component, 'initialCondensateInventoryFraction') * 100
      if (localPath === 'availableCondensateOutletFlowKgPerS') return parameterNumber(component, 'maxCondensateOutletFlowKgPerS')
      if (localPath === 'condensateTemperatureC') return parameterNumber(component, 'coolingWaterTemperatureC') + parameterNumber(component, 'condensateApproachTemperatureK')
      if (localPath === 'backPressurePa') return 8_000
      if (localPath === 'coolingWaterFlowKgPerS') return parameterNumber(component, 'nominalCoolingWaterFlowKgPerS')
      if (localPath === 'coolingWaterInletTemperatureC') return parameterNumber(component, 'coolingWaterTemperatureC')
      if (localPath === 'coolingWaterOutletTemperatureC') return parameterNumber(component, 'coolingWaterTemperatureC') + parameterNumber(component, 'coolingWaterDesignDeltaTK')
      if (localPath === 'coolingWaterHeatCapacityMw') {
        return parameterNumber(component, 'nominalCoolingWaterFlowKgPerS') * 4.186 * parameterNumber(component, 'coolingWaterDesignDeltaTK') / 1_000
      }
      if (localPath === 'coolingWaterAvailabilityFraction') return 1
      return undefined
    },
  },
]
