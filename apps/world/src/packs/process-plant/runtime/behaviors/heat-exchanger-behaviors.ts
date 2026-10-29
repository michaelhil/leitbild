import { componentVariablePath, type ComponentBehaviorDefinition } from '../behavior-contract.ts'
import { clamp, optionalParameterNumber } from '../component-helpers.ts'
import { pressureDropMPaFromFlow } from '../physics.ts'
import { sumIncomingLinkValue, flowWeightedIncomingLinkValue } from '../links/link-flow-helpers.ts'

const waterSpecificHeatMjPerKgC = 0.00418

export const heatExchangerBehaviorDefinitions: ReadonlyArray<ComponentBehaviorDefinition> = [
  {
    id: 'heat-exchanger-thermal-transfer',
    phase: 'updateComponentState',
    componentKind: 'heatExchanger',
    reads: ['incoming:flowKgPerS', 'incoming:temperatureC', 'hotOutletTemperatureC', 'coldOutletTemperatureC'],
    writes: [
      'hotInletTemperatureC',
      'hotOutletTemperatureC',
      'coldInletTemperatureC',
      'coldOutletTemperatureC',
      'hotSideFlowKgPerS',
      'coldSideFlowKgPerS',
      'heatTransferMw',
      'heatTransferCapacityMw',
      'approachTemperatureC',
      'effectivenessFraction',
      'coolingAvailabilityFraction',
      'hotSidePressureDropMPa',
      'coldSidePressureDropMPa',
      'heatBalanceResidualMw',
    ],
    update: ({ system, component, context }): void => {
      const hotSide = (link: { readonly toPortName?: unknown; readonly fromPortName?: unknown }): boolean =>
        String(link.toPortName ?? link.fromPortName).startsWith('hot')
      const coldSide = (link: { readonly toPortName?: unknown; readonly fromPortName?: unknown }): boolean =>
        String(link.toPortName ?? link.fromPortName).startsWith('cold')
      const hotFlow = sumIncomingLinkValue(system, component.index, 'flowKgPerS', context, link => hotSide(link))
      const coldFlow = sumIncomingLinkValue(system, component.index, 'flowKgPerS', context, link => coldSide(link))
      const hotInlet = flowWeightedIncomingLinkValue(system, component.index, 'temperatureC', context, link => hotSide(link))
        ?? context.readNumber(componentVariablePath(component, 'hotOutletTemperatureC'))
      const coldInlet = flowWeightedIncomingLinkValue(system, component.index, 'temperatureC', context, link => coldSide(link))
        ?? context.readNumber(componentVariablePath(component, 'coldOutletTemperatureC'))
      const hotCapacityMwPerC = hotFlow * waterSpecificHeatMjPerKgC
      const coldCapacityMwPerC = coldFlow * waterSpecificHeatMjPerKgC
      const limitingCapacity = Math.min(hotCapacityMwPerC, coldCapacityMwPerC)
      // The names identify circuits, not a one-way heat diode: heat can reverse.
      const temperatureDelta = hotInlet - coldInlet
      const ua = optionalParameterNumber(component, 'uaMwPerC', 0)
      const foulingFactor = optionalParameterNumber(component, 'foulingFactor', 0)
      const bypassFraction = optionalParameterNumber(component, 'bypassFraction', 0)
      const effectivenessLimit = optionalParameterNumber(component, 'effectivenessLimit', 0.92)
      const ntu = limitingCapacity > 0 ? ua * (1 - foulingFactor) / limitingCapacity : 0
      // Counterflow epsilon-NTU with both finite stream heat capacities.
      // expm1 and the factored denominator retain precision as Cr approaches 1;
      // the exactly equal-capacity limit is NTU / (1 + NTU).
      const capacityRatio = limitingCapacity > 0 ? limitingCapacity / Math.max(hotCapacityMwPerC, coldCapacityMwPerC) : 0
      const oneMinusRatio = 1 - capacityRatio
      const attenuation = -Math.expm1(-ntu * oneMinusRatio)
      const counterflowEffectiveness = limitingCapacity <= 0 ? 0 : oneMinusRatio === 0
        ? ntu / (1 + ntu)
        : attenuation / (oneMinusRatio + capacityRatio * attenuation)
      const effectiveness = clamp(counterflowEffectiveness * (1 - bypassFraction), 0, effectivenessLimit)
      const heatTransferCapacity = limitingCapacity * Math.abs(temperatureDelta) * effectivenessLimit
      const heatTransfer = limitingCapacity * temperatureDelta * effectiveness
      const coolingAvailability = clamp(coldFlow / Math.max(0.001, optionalParameterNumber(component, 'coldSideDesignFlowKgPerS', 1)), 0, 1)
      const hotOutletTarget = hotCapacityMwPerC > 0 ? hotInlet - heatTransfer / hotCapacityMwPerC : hotInlet
      const coldOutletTarget = coldCapacityMwPerC > 0 ? coldInlet + heatTransfer / coldCapacityMwPerC : coldInlet
      // An algebraic exchanger stores no energy. Both advective sides carry the
      // exact same signed transfer at this instant; all thermal storage lives
      // in explicit upstream/downstream fluid inventories, not outlet lag.
      const hotOutlet = hotOutletTarget
      const coldOutlet = coldOutletTarget
      const hotSidePressureDrop = pressureDropMPaFromFlow({
        flowKgPerS: hotFlow,
        nominalFlowKgPerS: optionalParameterNumber(component, 'hotSideDesignFlowKgPerS', 1),
        nominalPressureDropMPa: optionalParameterNumber(component, 'hotSideNominalPressureDropMPa', 0),
      })
      const coldSidePressureDrop = pressureDropMPaFromFlow({
        flowKgPerS: coldFlow,
        nominalFlowKgPerS: optionalParameterNumber(component, 'coldSideDesignFlowKgPerS', 1),
        nominalPressureDropMPa: optionalParameterNumber(component, 'coldSideNominalPressureDropMPa', 0),
      })
      const hotRemoved = hotCapacityMwPerC * (hotInlet - hotOutlet)
      const coldAdded = coldCapacityMwPerC * (coldOutlet - coldInlet)
      context.write(componentVariablePath(component, 'hotInletTemperatureC'), hotInlet)
      context.write(componentVariablePath(component, 'coldInletTemperatureC'), coldInlet)
      context.write(componentVariablePath(component, 'hotOutletTemperatureC'), hotOutlet)
      context.write(componentVariablePath(component, 'coldOutletTemperatureC'), coldOutlet)
      context.write(componentVariablePath(component, 'hotSideFlowKgPerS'), hotFlow)
      context.write(componentVariablePath(component, 'coldSideFlowKgPerS'), coldFlow)
      context.write(componentVariablePath(component, 'heatTransferMw'), heatTransfer)
      context.write(componentVariablePath(component, 'heatTransferCapacityMw'), heatTransferCapacity)
      context.write(componentVariablePath(component, 'approachTemperatureC'), Math.min(Math.abs(hotInlet - coldOutlet), Math.abs(hotOutlet - coldInlet)))
      context.write(componentVariablePath(component, 'effectivenessFraction'), effectiveness)
      context.write(componentVariablePath(component, 'coolingAvailabilityFraction'), coolingAvailability)
      context.write(componentVariablePath(component, 'hotSidePressureDropMPa'), hotSidePressureDrop)
      context.write(componentVariablePath(component, 'coldSidePressureDropMPa'), coldSidePressureDrop)
      context.write(componentVariablePath(component, 'heatBalanceResidualMw'), hotRemoved - coldAdded)
    },
  },
]
