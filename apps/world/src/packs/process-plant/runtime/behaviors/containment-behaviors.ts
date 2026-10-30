import { componentVariablePath, processLinkVariablePath, type ComponentBehaviorDefinition } from '../behavior-contract.ts'
import { clamp, optionalParameterNumber } from '../component-helpers.ts'
import { saturationTemperatureCFromPressureMPa } from '../thermophysics.ts'
import { mixedLiquidTemperatureStep } from '../thermal-inventory.ts'
import { inventoryBalanceStep } from '../physics.ts'
import { incomingComponentLinks, sumOutgoingComponentLinkValue } from '../component-link-helpers.ts'
import { averageIncomingLinkValue, flowWeightedIncomingLinkValue, sumIncomingLinkValue } from '../links/link-flow-helpers.ts'

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
    reads: ['incoming:flowKgPerS', 'incoming:temperatureC', 'incoming:soluteConcentrationPpm', 'incoming:radiationMSvPerH', 'pressureMPa', 'temperatureC', 'steamMassKg', 'sumpInventoryKg', 'sumpTemperatureC', 'sumpSoluteConcentrationPpm', 'outgoing:flowKgPerS'],
    writes: [
      'atmosphereMassKg',
      'steamMassKg',
      'sumpInventoryKg',
      'sumpTemperatureC',
      'sumpSoluteConcentrationPpm',
      'sumpLevelPercent',
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
      const incomingTemperature = flowWeightedIncomingLinkValue(system, component.index, 'temperatureC', context, link => String(link.toPortName) === 'massEnergyIn' || String(link.toPortName) === 'steamIn')
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
      // Debit only fluid actually delivered through sump outlet links. The
      // source solver shares the finite inventory/capacity across all trains.
      const sumpOutflow = sumOutgoingComponentLinkValue(system, component, 'flowKgPerS', context, link => String(link.fromPortName) === 'sumpOut')
      const nextSumpInventory = inventoryBalanceStep({
        currentInventory: context.readNumber(componentVariablePath(component, 'sumpInventoryKg')),
        inflowKgPerS: incomingLiquid + sprayCondensation + sprayFlow,
        outflowKgPerS: sumpOutflow,
        dtSeconds: context.dtSeconds,
        minInventory: 0,
        maxInventory: Number.POSITIVE_INFINITY,
      })
      const currentSumpTemperature = context.readNumber(componentVariablePath(component, 'sumpTemperatureC'))
      const sprayTemperature = flowWeightedIncomingLinkValue(system, component.index, 'temperatureC', context, link => String(link.toPortName) === 'sprayIn') ?? currentSumpTemperature
      // The containment atmosphere remains the existing lumped steam model.
      // Its condensate enters the separate liquid inventory at local saturation;
      // liquid arrivals and spray retain their actual advected temperatures.
      const condensateTemperature = saturationTemperatureCFromPressureMPa(currentPressure)
      const nextSumpTemperature = mixedLiquidTemperatureStep({
        inventoryKg: context.readNumber(componentVariablePath(component, 'sumpInventoryKg')),
        temperatureC: currentSumpTemperature,
        inflowKgPerS: incomingLiquid + sprayCondensation + sprayFlow,
        inflowThermalRateKgCPerS: incomingLiquid * incomingTemperature + sprayCondensation * condensateTemperature + sprayFlow * sprayTemperature,
        outflowKgPerS: sumpOutflow,
        dtSeconds: context.dtSeconds,
      })
      // The tracer is nonvolatile: primary liquid's incoming solute remains
      // in the sump as the existing atmosphere model flashes part of its water.
      // Spray carries its actual dissolved material; pure steam/condensate
      // carries none. This is not boron solubility or precipitation chemistry.
      let incomingSoluteRateKgPpmPerS = 0
      for (const link of incomingComponentLinks(system, component, link => ['massEnergyIn', 'steamIn', 'sprayIn'].includes(String(link.toPortName)))) {
        const flow = context.readNumber(processLinkVariablePath(link, 'flowKgPerS'))
        if (flow <= 0) continue
        const concentration = processLinkVariablePath(link, 'soluteConcentrationPpm')
        if (!context.has(concentration)) {
          if (link.nominalFluid === 'steam') continue
          throw new Error(`containment liquid inflow ${link.id} requires an actual dissolved-solute reading`)
        }
        incomingSoluteRateKgPpmPerS += flow * context.readNumber(concentration)
      }
      const currentSumpSolute = context.readNumber(componentVariablePath(component, 'sumpSoluteConcentrationPpm'))
      const remainingSumpMass = Math.max(0, context.readNumber(componentVariablePath(component, 'sumpInventoryKg')) - sumpOutflow * context.dtSeconds)
      const nextSumpSolute = nextSumpInventory > 0
        ? (remainingSumpMass * currentSumpSolute + incomingSoluteRateKgPpmPerS * context.dtSeconds) / nextSumpInventory
        : currentSumpSolute
      const sumpLevelReferenceInventory = optionalParameterNumber(component, 'sumpLevelReferenceInventoryKg', 100_000)
      const sumpLevelPercent = clamp(nextSumpInventory / sumpLevelReferenceInventory * 100, 0, 100)
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
      context.write(componentVariablePath(component, 'sumpTemperatureC'), nextSumpTemperature)
      context.write(componentVariablePath(component, 'sumpSoluteConcentrationPpm'), nextSumpSolute)
      context.write(componentVariablePath(component, 'sumpLevelPercent'), sumpLevelPercent)
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
