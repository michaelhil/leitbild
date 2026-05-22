import { componentVariablePath, type ComponentBehaviorDefinition } from '../behavior-contract.ts'
import {
  approach,
  clamp,
  optionalParameterNumber,
  parameterNumber,
  relaxToward,
} from '../component-helpers.ts'
import {
  averageIncomingComponentLinkValue as averageIncomingLinkValue,
  averageOutgoingComponentLinkValue as averageOutgoingLinkValue,
} from '../component-link-helpers.ts'
import { inventoryBalanceStep } from '../physics.ts'
import {
  energyBalanceTemperatureStep,
  heatMwFromWaterFlowAndDeltaT,
  latentHeatSteamMjPerKg,
  saturationTemperatureCFromPressureMPa,
  steamFlowKgPerSFromHeatMw,
  waterDeltaTFromHeatMw,
} from '../thermophysics.ts'

export const steamGeneratorBehaviorDefinitions: ReadonlyArray<ComponentBehaviorDefinition> = [
  {
    id: 'steam-generator-heat-transfer',
    phase: 'solveThermalTransfer',
    componentKind: 'steamGenerator',
    reads: ['tubeMetalTemperatureC', 'secondaryTemperatureC', 'levelPercent', 'incoming:primaryCoolant.temperatureC', 'incoming:primaryCoolant.flowKgPerS'],
    writes: ['heatTransferMw', 'steamFlowKgPerS', 'boilingRateKgPerS'],
    update: ({ system, component, context }): void => {
      const primaryWaterTemperature = averageIncomingLinkValue(system, component, 'temperatureC', context, link => link.service === 'primaryCoolant')
        ?? context.readNumber(componentVariablePath(component, 'primaryInletTemperatureC'))
      const primaryWaterFlow = averageIncomingLinkValue(system, component, 'flowKgPerS', context, link => link.service === 'primaryCoolant') ?? 0
      const secondaryTemperature = context.readNumber(componentVariablePath(component, 'secondaryTemperatureC'))
      const tubeMetalTemperature = context.readNumber(componentVariablePath(component, 'tubeMetalTemperatureC'))
      const nominalLevelFraction = parameterNumber(component, 'nominalLevelPercent')
      const levelFraction = clamp(context.readNumber(componentVariablePath(component, 'levelPercent')) / 100, 0, 1)
      const levelHeatTransferFactor = clamp(levelFraction / Math.max(0.05, nominalLevelFraction), 0.05, 1.15)
      const recirculationRatio = optionalParameterNumber(component, 'recirculationRatio', 4)
      const recirculationHeatTransferFactor = clamp(0.65 + recirculationRatio * 0.09, 0.8, 1.35)
      const transferCapacity = parameterNumber(component, 'heatTransferCoefficientMwPerK')
        * recirculationHeatTransferFactor
        * Math.max(0, tubeMetalTemperature - secondaryTemperature)
      const flowCapacity = heatMwFromWaterFlowAndDeltaT(primaryWaterFlow, Math.max(0, primaryWaterTemperature - secondaryTemperature))
      const heatTransfer = Math.max(0, Math.min(transferCapacity, flowCapacity) * levelHeatTransferFactor)
      const boilingRate = steamFlowKgPerSFromHeatMw(heatTransfer)
      context.write(componentVariablePath(component, 'heatTransferMw'), heatTransfer)
      context.write(componentVariablePath(component, 'boilingRateKgPerS'), boilingRate)
      context.write(componentVariablePath(component, 'steamFlowKgPerS'), Math.min(boilingRate, optionalParameterNumber(component, 'nominalSteamFlowKgPerS', 760) * 1.25))
    },
  },
  {
    id: 'steam-generator-tube-leak-transfer',
    phase: 'solveThermalTransfer',
    componentKind: 'steamGenerator',
    reads: ['tubeLeakFraction', 'pressureMPa', 'secondaryRadiationMSvPerH', 'primary pressure source'],
    writes: ['primaryToSecondaryLeakKgPerS', 'secondaryRadiationMSvPerH'],
    update: ({ system, component, context }): void => {
      const leakFraction = clamp(context.readNumber(componentVariablePath(component, 'tubeLeakFraction')), 0, 1)
      const primaryPressure = averageIncomingLinkValue(system, component, 'pressureMPa', context, link => link.service === 'primaryCoolant') ?? 0
      const secondaryPressure = context.readNumber(componentVariablePath(component, 'pressureMPa'))
      const pressureDelta = Math.max(0, primaryPressure - secondaryPressure)
      const leakCoefficient = optionalParameterNumber(component, 'tubeLeakFlowCoefficientKgPerSPerSqrtMPa', 0)
      const leakFlow = leakFraction * leakCoefficient * Math.sqrt(pressureDelta)
      const radiationTarget = 0.02 + leakFlow * optionalParameterNumber(component, 'tubeLeakRadiationGainMSvPerHPerKgS', 0.7)
      context.write(componentVariablePath(component, 'primaryToSecondaryLeakKgPerS'), leakFlow)
      context.write(
        componentVariablePath(component, 'secondaryRadiationMSvPerH'),
        relaxToward(
          context.readNumber(componentVariablePath(component, 'secondaryRadiationMSvPerH')),
          radiationTarget,
          context.dtSeconds,
          optionalParameterNumber(component, 'tubeLeakRadiationTimeConstantS', 5),
        ),
      )
    },
  },
  {
    id: 'steam-generator-inventory-pressure-state',
    phase: 'updateComponentState',
    componentKind: 'steamGenerator',
    reads: [
      'pressureMPa',
      'levelPercent',
      'collapsedLevelPercent',
      'voidFraction',
      'swellLevelPercent',
      'steamMassKg',
      'heatTransferMw',
      'steamFlowKgPerS',
      'boilingRateKgPerS',
      'feedwaterFlowKgPerS',
      'steamOutflowKgPerS',
      'steamQualityFraction',
      'primaryInletTemperatureC',
      'primaryOutletTemperatureC',
      'tubeMetalTemperatureC',
      'secondaryTemperatureC',
      'secondaryInventoryKg',
      'pressureTargetMPa',
      'steamMassPressureBiasMPa',
      'temperaturePressureBiasMPa',
      'inventoryPressureBiasMPa',
      'secondaryInventoryBalanceResidualKg',
      'steamMassBalanceResidualKg',
      'boilingEnergyResidualMw',
      'incoming:primaryCoolant.temperatureC',
      'incoming:primaryCoolant.flowKgPerS',
    ],
    writes: [
      'pressureMPa',
      'levelPercent',
      'collapsedLevelPercent',
      'voidFraction',
      'swellLevelPercent',
      'steamMassKg',
      'primaryInletTemperatureC',
      'primaryOutletTemperatureC',
      'tubeMetalTemperatureC',
      'secondaryTemperatureC',
      'secondaryInventoryKg',
      'feedwaterFlowKgPerS',
      'steamOutflowKgPerS',
      'steamQualityFraction',
      'pressureTargetMPa',
      'steamMassPressureBiasMPa',
      'temperaturePressureBiasMPa',
      'inventoryPressureBiasMPa',
      'secondaryInventoryBalanceResidualKg',
      'steamMassBalanceResidualKg',
      'boilingEnergyResidualMw',
    ],
    update: ({ system, component, context }): void => {
      const feedwaterFlow = (averageIncomingLinkValue(system, component, 'flowKgPerS', context, link => link.service === 'feedwater') ?? 0)
        + (averageIncomingLinkValue(system, component, 'flowKgPerS', context, link => link.service === 'auxFeedwater') ?? 0)
      const tubeLeakFlow = context.readNumber(componentVariablePath(component, 'primaryToSecondaryLeakKgPerS'))
      context.write(componentVariablePath(component, 'feedwaterFlowKgPerS'), feedwaterFlow)
      const turbineSteamFlow = averageOutgoingLinkValue(system, component, 'flowKgPerS', context, link => link.service === 'mainSteam') ?? 0
      context.write(componentVariablePath(component, 'steamOutflowKgPerS'), turbineSteamFlow)
      const pressurePath = componentVariablePath(component, 'pressureMPa')
      const levelPath = componentVariablePath(component, 'levelPercent')
      const heatTransfer = context.readNumber(componentVariablePath(component, 'heatTransferMw'))
      const nominalPressure = parameterNumber(component, 'nominalPressureMPa')
      const primaryInletTemperature = averageIncomingLinkValue(system, component, 'temperatureC', context, link => link.service === 'primaryCoolant')
        ?? context.readNumber(componentVariablePath(component, 'primaryInletTemperatureC'))
      const primaryFlow = Math.max(1, averageIncomingLinkValue(system, component, 'flowKgPerS', context, link => link.service === 'primaryCoolant') ?? 1)
      const primaryOutletTarget = clamp(primaryInletTemperature - waterDeltaTFromHeatMw(heatTransfer, primaryFlow), 180, primaryInletTemperature)
      const primaryTimeConstantSeconds = optionalParameterNumber(component, 'primaryThermalTimeConstantS', 10)
      context.write(componentVariablePath(component, 'primaryInletTemperatureC'), relaxToward(context.readNumber(componentVariablePath(component, 'primaryInletTemperatureC')), primaryInletTemperature, context.dtSeconds, primaryTimeConstantSeconds))
      context.write(componentVariablePath(component, 'primaryOutletTemperatureC'), relaxToward(context.readNumber(componentVariablePath(component, 'primaryOutletTemperatureC')), primaryOutletTarget, context.dtSeconds, primaryTimeConstantSeconds))
      const tubeMetalTemperature = context.readNumber(componentVariablePath(component, 'tubeMetalTemperatureC'))
      const primaryToTubeHeat = Math.min(
        heatMwFromWaterFlowAndDeltaT(primaryFlow, Math.max(0, primaryInletTemperature - tubeMetalTemperature)),
        parameterNumber(component, 'heatTransferCoefficientMwPerK') * Math.max(0, primaryInletTemperature - tubeMetalTemperature),
      )
      context.write(componentVariablePath(component, 'tubeMetalTemperatureC'), energyBalanceTemperatureStep({
        currentTemperatureC: tubeMetalTemperature,
        heatInMw: primaryToTubeHeat,
        heatOutMw: heatTransfer,
        dtSeconds: context.dtSeconds,
        thermalCapacityMjPerK: optionalParameterNumber(component, 'tubeMetalThermalCapacityMjPerK', 8_000),
        minTemperatureC: 120,
        maxTemperatureC: 360,
      }))

      const secondaryTemperatureTarget = clamp(saturationTemperatureCFromPressureMPa(context.readNumber(pressurePath)), 160, 330)
      context.write(componentVariablePath(component, 'secondaryTemperatureC'), relaxToward(context.readNumber(componentVariablePath(component, 'secondaryTemperatureC')), secondaryTemperatureTarget, context.dtSeconds, optionalParameterNumber(component, 'secondaryThermalTimeConstantS', 25)))
      const currentPressure = context.readNumber(pressurePath)
      const boilingRate = context.readNumber(componentVariablePath(component, 'boilingRateKgPerS'))
      context.write(componentVariablePath(component, 'boilingEnergyResidualMw'), boilingRate * latentHeatSteamMjPerKg - heatTransfer)
      const secondaryTemperature = context.readNumber(componentVariablePath(component, 'secondaryTemperatureC'))
      const temperaturePressureBias = (secondaryTemperature - saturationTemperatureCFromPressureMPa(nominalPressure)) / 100 * nominalPressure
      const nominalSteamMass = optionalParameterNumber(component, 'nominalSteamMassKg', 12_000)
      const currentSteamMass = context.readNumber(componentVariablePath(component, 'steamMassKg'))
      const steamMassTarget = inventoryBalanceStep({
        currentInventory: currentSteamMass,
        inflowKgPerS: boilingRate,
        outflowKgPerS: turbineSteamFlow,
        dtSeconds: context.dtSeconds,
        minInventory: nominalSteamMass * 0.15,
        maxInventory: nominalSteamMass * 2.5,
      })
      const nextSteamMass = steamMassTarget
      context.write(componentVariablePath(component, 'steamMassKg'), nextSteamMass)
      context.write(
        componentVariablePath(component, 'steamMassBalanceResidualKg'),
        nextSteamMass - currentSteamMass - (boilingRate - turbineSteamFlow) * context.dtSeconds,
      )
      const steamQualityTarget = turbineSteamFlow <= 0
        ? 1
        : clamp(boilingRate / Math.max(1, turbineSteamFlow), 0.78, 1)
      context.write(
        componentVariablePath(component, 'steamQualityFraction'),
        relaxToward(
          context.readNumber(componentVariablePath(component, 'steamQualityFraction')),
          steamQualityTarget,
          context.dtSeconds,
          optionalParameterNumber(component, 'steamQualityTimeConstantS', 8),
        ),
      )
      const nominalInventory = optionalParameterNumber(component, 'nominalSecondaryInventoryKg', 56_000)
      const currentInventory = context.readNumber(componentVariablePath(component, 'secondaryInventoryKg'))
      const nextInventory = inventoryBalanceStep({
        currentInventory,
        inflowKgPerS: feedwaterFlow + tubeLeakFlow,
        outflowKgPerS: turbineSteamFlow,
        dtSeconds: context.dtSeconds,
        minInventory: 0,
        maxInventory: nominalInventory,
      })
      context.write(componentVariablePath(component, 'secondaryInventoryKg'), nextInventory)
      context.write(
        componentVariablePath(component, 'secondaryInventoryBalanceResidualKg'),
        nextInventory - currentInventory - (feedwaterFlow + tubeLeakFlow - turbineSteamFlow) * context.dtSeconds,
      )
      const collapsedLevel = clamp((nextInventory / nominalInventory) * 100, 0, 100)
      context.write(componentVariablePath(component, 'collapsedLevelPercent'), collapsedLevel)
      const recirculationRatio = optionalParameterNumber(component, 'recirculationRatio', 1)
      const nominalSteamFlow = optionalParameterNumber(component, 'nominalSteamFlowKgPerS', 760)
      const recirculationMultiplier = clamp(1 + (recirculationRatio - 1) * 0.06, 1, 1.35)
      const voidTarget = clamp(
        optionalParameterNumber(component, 'voidFractionAtNominalBoiling', 0.16)
        * recirculationMultiplier
        * boilingRate / Math.max(1, nominalSteamFlow),
        0,
        0.45,
      )
      const voidFraction = relaxToward(
        context.readNumber(componentVariablePath(component, 'voidFraction')),
        voidTarget,
        context.dtSeconds,
        optionalParameterNumber(component, 'voidFractionTimeConstantS', 6),
      )
      context.write(componentVariablePath(component, 'voidFraction'), voidFraction)
      const swellLevel = clamp(voidFraction * optionalParameterNumber(component, 'swellLevelGainPercent', 26), 0, 35)
      context.write(componentVariablePath(component, 'swellLevelPercent'), swellLevel)
      context.write(levelPath, clamp(collapsedLevel + swellLevel, 0, 100))
      const steamMassPressureBias = nominalPressure * (clamp(nextSteamMass / nominalSteamMass, 0.2, 1.6) - 1)
      const inventoryPressureBias = ((nextInventory / nominalInventory) - parameterNumber(component, 'nominalLevelPercent')) * optionalParameterNumber(component, 'pressureInventoryGainMPaPerFraction', 0.6)
      const demandPressureBias = (boilingRate - turbineSteamFlow) * optionalParameterNumber(component, 'steamPressureGainMPaPerKgS', 0.006)
      const pressureTarget = nominalPressure + steamMassPressureBias + demandPressureBias + temperaturePressureBias + inventoryPressureBias
      context.write(componentVariablePath(component, 'steamMassPressureBiasMPa'), steamMassPressureBias)
      context.write(componentVariablePath(component, 'temperaturePressureBiasMPa'), temperaturePressureBias)
      context.write(componentVariablePath(component, 'inventoryPressureBiasMPa'), inventoryPressureBias)
      context.write(componentVariablePath(component, 'pressureTargetMPa'), clamp(pressureTarget, nominalPressure * 0.2, nominalPressure * 1.4))
      context.write(pressurePath, approach(currentPressure, clamp(pressureTarget, nominalPressure * 0.2, nominalPressure * 1.4), 0.08 * context.dtSeconds))
    },
  },
]
