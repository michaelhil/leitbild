import type { CompiledComponent, VariablePath } from '../graph/index.ts'
import { primaryLoopIdForPump } from '../graph/index.ts'
import type { ProcessPlantValue } from './model.ts'
import {
  clamp,
  optionalParameterBoolean,
  optionalParameterNumber,
  parameterNumber,
} from './component-helpers.ts'
import { saturationTemperatureCFromPressureMPa } from './thermophysics.ts'

export const initialComponentValueFor = (component: CompiledComponent, path: VariablePath): ProcessPlantValue => {
  const localPath = String(path).slice(String(component.id).length + 1)
  if (component.kind === 'reactorCore') {
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
  }
  if (component.kind === 'steamGenerator') {
    if (localPath === 'levelPercent') return parameterNumber(component, 'nominalLevelPercent') * 100
    if (localPath === 'pressureMPa') return parameterNumber(component, 'nominalPressureMPa')
    if (localPath === 'heatTransferMw') return 0
    if (localPath === 'primaryInletTemperatureC') return optionalParameterNumber(component, 'initialPrimaryInletTemperatureC', 322)
    if (localPath === 'primaryOutletTemperatureC') return optionalParameterNumber(component, 'initialPrimaryInletTemperatureC', 322) - 32
    if (localPath === 'tubeMetalTemperatureC') {
      const primary = optionalParameterNumber(component, 'initialPrimaryInletTemperatureC', 322)
      const secondary = optionalParameterNumber(component, 'initialSecondaryTemperatureC', 285)
      return optionalParameterNumber(component, 'tubeMetalInitialTemperatureC', (primary + secondary) / 2)
    }
    if (localPath === 'secondaryTemperatureC') return optionalParameterNumber(component, 'initialSecondaryTemperatureC', 285)
    if (localPath === 'steamFlowKgPerS') return 0
    if (localPath === 'boilingRateKgPerS') return 0
    if (localPath === 'feedwaterFlowKgPerS') return 0
    if (localPath === 'steamOutflowKgPerS') return 0
    if (localPath === 'steamQualityFraction') return 0.99
    if (localPath === 'secondaryInventoryKg') return optionalParameterNumber(component, 'nominalSecondaryInventoryKg', 56_000) * parameterNumber(component, 'nominalLevelPercent')
    if (localPath === 'collapsedLevelPercent') return parameterNumber(component, 'nominalLevelPercent') * 100
    if (localPath === 'voidFraction') return 0
    if (localPath === 'swellLevelPercent') return 0
    if (localPath === 'steamMassKg') return optionalParameterNumber(component, 'nominalSteamMassKg', 12_000)
    if (localPath === 'pressureTargetMPa') return parameterNumber(component, 'nominalPressureMPa')
    if (localPath === 'steamMassPressureBiasMPa') return 0
    if (localPath === 'temperaturePressureBiasMPa') return 0
    if (localPath === 'inventoryPressureBiasMPa') return 0
    if (localPath === 'secondaryInventoryBalanceResidualKg') return 0
    if (localPath === 'steamMassBalanceResidualKg') return 0
    if (localPath === 'boilingEnergyResidualMw') return 0
    if (localPath === 'tubeLeakFraction') return 0
    if (localPath === 'primaryToSecondaryLeakKgPerS') return 0
    if (localPath === 'secondaryRadiationMSvPerH') return 0.02
  }
  if (component.kind === 'reactorVessel') {
    const nominalInventory = parameterNumber(component, 'nominalPrimaryCoolantInventoryKg')
    const initialFraction = parameterNumber(component, 'initialPrimaryCoolantInventoryFraction')
    if (localPath === 'primaryCoolantInventoryKg') return nominalInventory * initialFraction
    if (localPath === 'primaryCoolantInventoryDeviationKg') return nominalInventory * (initialFraction - 1)
    if (localPath === 'meanPrimaryCoolantTemperatureC') return parameterNumber(component, 'referencePrimaryCoolantTemperatureC')
    if (localPath === 'compressibilityPressureBiasMPa') return 0
    if (localPath === 'thermalExpansionPressureBiasMPa') return 0
    if (localPath === 'primaryPressureBiasMPa') return 0
    if (localPath === 'chargingFlowKgPerS') return 0
    if (localPath === 'letdownFlowKgPerS') return optionalParameterNumber(component, 'normalLetdownFlowKgPerS', 0)
    if (localPath === 'reliefOutflowKgPerS') return 0
    if (localPath === 'primaryLeakFlowKgPerS') return 0
    if (localPath === 'tubeLeakFlowKgPerS') return 0
    if (localPath === 'netInventoryFlowKgPerS') return -optionalParameterNumber(component, 'normalLetdownFlowKgPerS', 0)
  }
  if (component.kind === 'pressurizer') {
    const nominalPressure = parameterNumber(component, 'nominalPressureMPa')
    const nominalLevelFraction = parameterNumber(component, 'nominalLevelPercent')
    if (localPath === 'pressureMPa') return nominalPressure
    if (localPath === 'levelPercent') return nominalLevelFraction * 100
    if (localPath === 'waterInventoryKg') return parameterNumber(component, 'nominalWaterInventoryKg')
    if (localPath === 'steamMassKg') return optionalParameterNumber(component, 'nominalSteamMassKg', 1_800)
    if (localPath === 'steamMassFlowKgPerS') return 0
    if (localPath === 'steamVolumeM3') {
      const density = optionalParameterNumber(component, 'nominalWaterDensityKgPerM3', 700)
      const fullInventory = parameterNumber(component, 'nominalWaterInventoryKg') / Math.max(0.01, nominalLevelFraction)
      return Math.max(0.1, (fullInventory - parameterNumber(component, 'nominalWaterInventoryKg')) / density)
    }
    if (localPath === 'steamPressureMPa') return nominalPressure
    if (localPath === 'pressureTargetMPa') return nominalPressure
    if (localPath === 'waterInventoryBalanceResidualKg') return 0
    if (localPath === 'steamMassBalanceResidualKg') return 0
    if (localPath === 'waterTemperatureC') return optionalParameterNumber(component, 'initialWaterTemperatureC', 345)
    if (localPath === 'steamTemperatureC') return optionalParameterNumber(component, 'initialSteamTemperatureC', saturationTemperatureCFromPressureMPa(nominalPressure))
    if (localPath === 'heaterPowerMw') return 0
    if (localPath === 'sprayFlowKgPerS') return 0
    if (localPath === 'reliefValvePositionFraction') return 0
    if (localPath === 'reliefFlowKgPerS') return 0
  }
  if (component.kind === 'centrifugalPump') {
    const running = optionalParameterBoolean(component, 'initialRunning', true)
    const primaryLoopId = primaryLoopIdForPump(component)
    if (localPath === 'running') return optionalParameterBoolean(component, 'initialRunning', true)
    if (localPath === 'speedFraction') return 1
    if (localPath === 'flowKgPerS') return running ? parameterNumber(component, 'nominalFlowKgPerS') : 0
    if (localPath === 'developedHeadPa') return running ? parameterNumber(component, 'nominalHeadPa') : 0
    if (localPath === 'loopFlowTargetKgPerS') return primaryLoopId === null ? 0 : running ? parameterNumber(component, 'nominalFlowKgPerS') : optionalParameterNumber(component, 'minimumNaturalCirculationFlowKgPerS', 0)
    if (localPath === 'loopFlowKgPerS') return primaryLoopId === null ? 0 : running ? parameterNumber(component, 'nominalFlowKgPerS') : optionalParameterNumber(component, 'minimumNaturalCirculationFlowKgPerS', 0)
  }
  if (component.kind === 'processTank') {
    const nominalInventory = parameterNumber(component, 'nominalInventoryKg')
    const initialFraction = parameterNumber(component, 'initialInventoryFraction')
    if (localPath === 'inventoryKg') return nominalInventory * initialFraction
    if (localPath === 'levelPercent') return initialFraction * 100
    if (localPath === 'temperatureC') return parameterNumber(component, 'initialTemperatureC')
    if (localPath === 'makeupFlowKgPerS') return parameterNumber(component, 'makeupFlowKgPerS')
    if (localPath === 'availableOutletFlowKgPerS') return parameterNumber(component, 'maxOutletFlowKgPerS')
  }
  if (component.kind === 'processHeader' || component.kind === 'steamHeader') {
    if (localPath === 'inletFlowKgPerS') return 0
    if (localPath === 'outletFlowKgPerS') return 0
    if (localPath === 'flowBalanceResidualKgPerS') return 0
    if (localPath === 'mixedTemperatureC') return optionalParameterNumber(component, 'initialTemperatureC', component.kind === 'steamHeader' ? 285 : 220)
    if (localPath === 'mixedPressureMPa') return optionalParameterNumber(component, 'initialPressureMPa', component.kind === 'steamHeader' ? 6.9 : 1)
  }
  if (component.kind === 'processValve' || component.kind === 'steamValve') {
    const initialPosition = optionalParameterNumber(component, 'initialPositionFraction', 1)
    if (localPath === 'positionFraction') return initialPosition
    if (localPath === 'effectivePositionFraction') return initialPosition
    if (localPath === 'inletFlowKgPerS') return 0
    if (localPath === 'outletFlowKgPerS') return 0
    if (localPath === 'flowBalanceResidualKgPerS') return 0
  }
  if (component.kind === 'feedwaterSource') {
    if (localPath === 'flowKgPerS') return parameterNumber(component, 'nominalFlowKgPerS')
    if (localPath === 'temperatureC') return parameterNumber(component, 'temperatureC')
  }
  if (component.kind === 'turbineLoadSink') {
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
  }
  if (component.kind === 'condenserSink') {
    if (localPath === 'steamFlowKgPerS') return 0
    if (localPath === 'condensateProductionKgPerS') return 0
    if (localPath === 'heatRejectedMw') return 0
    if (localPath === 'condensateInventoryKg') return parameterNumber(component, 'nominalCondensateInventoryKg') * parameterNumber(component, 'initialCondensateInventoryFraction')
    if (localPath === 'condensateLevelPercent') return parameterNumber(component, 'initialCondensateInventoryFraction') * 100
    if (localPath === 'availableCondensateOutletFlowKgPerS') return parameterNumber(component, 'maxCondensateOutletFlowKgPerS')
    if (localPath === 'condensateTemperatureC') return parameterNumber(component, 'coolingWaterTemperatureC') + parameterNumber(component, 'condensateApproachTemperatureK')
    if (localPath === 'backPressurePa') return 8_000
  }
  throw new Error(`component ${component.id} has no runtime initializer for variable ${path}`)
}
