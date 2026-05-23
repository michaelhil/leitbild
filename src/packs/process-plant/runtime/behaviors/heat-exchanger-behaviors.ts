import { componentVariablePath, type ComponentBehaviorDefinition } from '../behavior-contract.ts'
import { clamp, optionalParameterNumber, relaxToward } from '../component-helpers.ts'
import { pressureDropMPaFromFlow } from '../physics.ts'
import { sumIncomingLinkValue, flowWeightedIncomingLinkValue } from '../link-flow-helpers.ts'

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
      'approachTemperatureC',
      'effectivenessFraction',
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
      const temperatureDelta = Math.max(0, hotInlet - coldInlet)
      const ua = optionalParameterNumber(component, 'uaMwPerC', 0)
      const foulingFactor = optionalParameterNumber(component, 'foulingFactor', 0)
      const bypassFraction = optionalParameterNumber(component, 'bypassFraction', 0)
      const effectivenessLimit = optionalParameterNumber(component, 'effectivenessLimit', 0.92)
      const ntu = limitingCapacity > 0 ? ua * (1 - foulingFactor) / limitingCapacity : 0
      const effectiveness = clamp((1 - Math.exp(-Math.max(0, ntu))) * (1 - bypassFraction), 0, effectivenessLimit)
      const heatTransfer = limitingCapacity * temperatureDelta * effectiveness
      const hotOutletTarget = hotCapacityMwPerC > 0 ? hotInlet - heatTransfer / hotCapacityMwPerC : hotInlet
      const coldOutletTarget = coldCapacityMwPerC > 0 ? coldInlet + heatTransfer / coldCapacityMwPerC : coldInlet
      const thermalMass = optionalParameterNumber(component, 'thermalMassMJPerC', 0)
      const thermalTimeConstant = Math.max(0.1, thermalMass / Math.max(0.001, ua))
      const hotOutlet = relaxToward(context.readNumber(componentVariablePath(component, 'hotOutletTemperatureC')), hotOutletTarget, context.dtSeconds, thermalTimeConstant)
      const coldOutlet = relaxToward(context.readNumber(componentVariablePath(component, 'coldOutletTemperatureC')), coldOutletTarget, context.dtSeconds, thermalTimeConstant)
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
      const hotRemoved = hotCapacityMwPerC * Math.max(0, hotInlet - hotOutlet)
      const coldAdded = coldCapacityMwPerC * Math.max(0, coldOutlet - coldInlet)
      context.write(componentVariablePath(component, 'hotInletTemperatureC'), hotInlet)
      context.write(componentVariablePath(component, 'coldInletTemperatureC'), coldInlet)
      context.write(componentVariablePath(component, 'hotOutletTemperatureC'), Math.max(coldInlet, hotOutlet))
      context.write(componentVariablePath(component, 'coldOutletTemperatureC'), Math.min(hotInlet, coldOutlet))
      context.write(componentVariablePath(component, 'hotSideFlowKgPerS'), hotFlow)
      context.write(componentVariablePath(component, 'coldSideFlowKgPerS'), coldFlow)
      context.write(componentVariablePath(component, 'heatTransferMw'), heatTransfer)
      context.write(componentVariablePath(component, 'approachTemperatureC'), Math.max(0, hotOutlet - coldOutlet))
      context.write(componentVariablePath(component, 'effectivenessFraction'), effectiveness)
      context.write(componentVariablePath(component, 'hotSidePressureDropMPa'), hotSidePressureDrop)
      context.write(componentVariablePath(component, 'coldSidePressureDropMPa'), coldSidePressureDrop)
      context.write(componentVariablePath(component, 'heatBalanceResidualMw'), hotRemoved - coldAdded)
    },
  },
]
