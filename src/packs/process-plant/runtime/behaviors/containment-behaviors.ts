import { componentVariablePath, processLinkVariablePath, type ComponentBehaviorDefinition } from '../behavior-contract.ts'
import { clamp, optionalParameterNumber } from '../component-helpers.ts'
import { inventoryBalanceStep } from '../physics.ts'
import { averageIncomingLinkValue, sumIncomingLinkValue } from '../link-flow-helpers.ts'

const gasPressureMPa = (config: {
  readonly airMassKg: number
  readonly steamMassKg: number
  readonly volumeM3: number
  readonly temperatureC: number
}): number => {
  const temperatureK = config.temperatureC + 273.15
  const gasMass = Math.max(0, config.airMassKg) + Math.max(0, config.steamMassKg)
  return gasMass * 287.05 * temperatureK / Math.max(1, config.volumeM3) / 1_000_000
}

export const containmentBehaviorDefinitions: ReadonlyArray<ComponentBehaviorDefinition> = [
  {
    id: 'containment-lumped-atmosphere-sump',
    phase: 'updateComponentState',
    componentKind: 'containmentVolume',
    reads: ['incoming:flowKgPerS', 'incoming:temperatureC', 'incoming:radiationMSvPerH', 'pressureMPa', 'temperatureC', 'steamMassKg', 'sumpInventoryKg'],
    writes: [
      'atmosphereMassKg',
      'steamMassKg',
      'sumpInventoryKg',
      'pressureMPa',
      'temperatureC',
      'humidityFraction',
      'incomingMassKgPerS',
      'sprayFlowKgPerS',
      'releaseFlowKgPerS',
      'sumpOutflowKgPerS',
      'heatRemovalMw',
      'radiationSourceTermMSvPerH',
      'contaminationInventory',
    ],
    update: ({ system, component, context }): void => {
      const incomingMass = sumIncomingLinkValue(system, component.index, 'flowKgPerS', context, link => String(link.toPortName) === 'massEnergyIn' || String(link.toPortName) === 'steamIn')
      const sprayFlow = sumIncomingLinkValue(system, component.index, 'flowKgPerS', context, link => String(link.toPortName) === 'sprayIn')
      const incomingTemperature = averageIncomingLinkValue(system, component.index, 'temperatureC', context, link => String(link.toPortName) === 'massEnergyIn' || String(link.toPortName) === 'steamIn')
        ?? context.readNumber(componentVariablePath(component, 'temperatureC'))
      const incomingRadiation = averageIncomingLinkValue(system, component.index, 'radiationMSvPerH', context, link => String(link.toPortName) === 'massEnergyIn' || String(link.toPortName) === 'steamIn') ?? 0.02
      const currentPressure = context.readNumber(componentVariablePath(component, 'pressureMPa'))
      const currentTemperature = context.readNumber(componentVariablePath(component, 'temperatureC'))
      const heatLoss = Math.max(0, currentTemperature - optionalParameterNumber(component, 'initialTemperatureC', 30)) * optionalParameterNumber(component, 'heatLossMwPerC', 0)
      const sprayCondensation = Math.min(context.readNumber(componentVariablePath(component, 'steamMassKg')), sprayFlow * 0.5)
      const ventSetpoint = optionalParameterNumber(component, 'ventSetpointMPa', Number.POSITIVE_INFINITY)
      const ventCapacity = optionalParameterNumber(component, 'ventCapacityKgPerS', 0)
      const releaseFlow = currentPressure > ventSetpoint ? ventCapacity * clamp((currentPressure - ventSetpoint) / Math.max(0.01, ventSetpoint * 0.05), 0, 1) : 0
      const steamShare = incomingTemperature >= 100 ? 0.9 : clamp((incomingTemperature - 70) / 60, 0, 0.5)
      const incomingSteam = incomingMass * steamShare
      const incomingLiquid = incomingMass - incomingSteam
      const nextSteamMass = inventoryBalanceStep({
        currentInventory: context.readNumber(componentVariablePath(component, 'steamMassKg')),
        inflowKgPerS: incomingSteam,
        outflowKgPerS: releaseFlow + sprayCondensation,
        dtSeconds: context.dtSeconds,
        minInventory: 0,
        maxInventory: Number.POSITIVE_INFINITY,
      })
      const sumpOutflow = Math.min(
        optionalParameterNumber(component, 'maxSumpOutflowKgPerS', 0),
        context.readNumber(componentVariablePath(component, 'sumpInventoryKg')) / Math.max(1, context.dtSeconds),
      )
      const nextSumpInventory = inventoryBalanceStep({
        currentInventory: context.readNumber(componentVariablePath(component, 'sumpInventoryKg')),
        inflowKgPerS: incomingLiquid + sprayCondensation + sprayFlow,
        outflowKgPerS: sumpOutflow,
        dtSeconds: context.dtSeconds,
        minInventory: 0,
        maxInventory: Number.POSITIVE_INFINITY,
      })
      const airMass = context.readNumber(componentVariablePath(component, 'airMassKg'))
      const pressure = gasPressureMPa({
        airMassKg: airMass,
        steamMassKg: nextSteamMass,
        volumeM3: optionalParameterNumber(component, 'freeVolumeM3', 1),
        temperatureC: currentTemperature,
      })
      const heatInputMw = incomingMass * 0.00418 * Math.max(0, incomingTemperature - currentTemperature)
      const nextTemperature = Math.max(0, currentTemperature + (heatInputMw - heatLoss - sprayCondensation * 2.25) * context.dtSeconds / 250)
      const atmosphereMass = airMass + nextSteamMass
      const humidity = atmosphereMass <= 0 ? 0 : clamp(nextSteamMass / atmosphereMass, 0, 1)
      const contamination = clamp(
        context.readNumber(componentVariablePath(component, 'contaminationInventory')) + incomingMass * Math.max(0, incomingRadiation - 0.02) * context.dtSeconds / 1_000_000,
        0,
        1,
      )
      context.write(componentVariablePath(component, 'atmosphereMassKg'), atmosphereMass)
      context.write(componentVariablePath(component, 'steamMassKg'), nextSteamMass)
      context.write(componentVariablePath(component, 'sumpInventoryKg'), nextSumpInventory)
      context.write(componentVariablePath(component, 'pressureMPa'), Math.max(0.01, pressure))
      context.write(componentVariablePath(component, 'temperatureC'), nextTemperature)
      context.write(componentVariablePath(component, 'humidityFraction'), humidity)
      context.write(componentVariablePath(component, 'incomingMassKgPerS'), incomingMass)
      context.write(componentVariablePath(component, 'sprayFlowKgPerS'), sprayFlow)
      context.write(componentVariablePath(component, 'releaseFlowKgPerS'), releaseFlow)
      context.write(componentVariablePath(component, 'sumpOutflowKgPerS'), sumpOutflow)
      context.write(componentVariablePath(component, 'heatRemovalMw'), heatLoss + sprayCondensation * 2.25)
      context.write(componentVariablePath(component, 'radiationSourceTermMSvPerH'), Math.max(0.02, incomingRadiation * contamination))
      context.write(componentVariablePath(component, 'contaminationInventory'), contamination)
    },
  },
]
