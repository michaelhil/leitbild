import { componentVariablePath, processLinkVariablePath, type ProcessLinkBehaviorDefinition } from './behavior-contract.ts'
import { relaxToward } from './component-helpers.ts'
import { averageIncomingLinkValue, flowWeightedIncomingLinkValue, hasProcessLinkVariable, serviceMatches } from './link-flow-helpers.ts'

export const processLinkTemperatureBehaviorDefinitions: ReadonlyArray<ProcessLinkBehaviorDefinition> = [
  {
    id: 'process-link-temperature',
    phase: 'updateProcessLinkState',
    reads: ['temperatureC', 'source component temperature state'],
    writes: ['temperatureC'],
    appliesTo: (link): boolean => hasProcessLinkVariable(link, 'temperatureC'),
    update: ({ system, link, context }): void => {
      const fromComponent = system.graph.components[link.fromComponentIndex]
      const toComponent = system.graph.components[link.toComponentIndex]
      if (!fromComponent || !toComponent) throw new Error(`process link ${link.id} references missing component`)
      let target: number
      if (fromComponent.kind === 'reactorCore') {
        target = context.readNumber(componentVariablePath(fromComponent, 'coolantOutletTemperatureC'))
      } else if (fromComponent.kind === 'steamGenerator' && link.service === 'primaryCoolant') {
        target = context.readNumber(componentVariablePath(fromComponent, 'primaryOutletTemperatureC'))
      } else if (fromComponent.kind === 'pressurizer' && link.service === 'primaryRelief') {
        target = context.readNumber(componentVariablePath(fromComponent, 'steamTemperatureC'))
      } else if (fromComponent.kind === 'reactorVessel' && link.service === 'primaryRelease') {
        target = context.readNumber(componentVariablePath(fromComponent, 'meanPrimaryCoolantTemperatureC'))
      } else if (fromComponent.kind === 'processTank') {
        target = context.readNumber(componentVariablePath(fromComponent, 'temperatureC'))
      } else if (fromComponent.kind === 'condenserSink' && link.service === 'condensate') {
        target = context.readNumber(componentVariablePath(fromComponent, 'condensateTemperatureC'))
      } else if (fromComponent.kind === 'condenserSink' && link.service === 'coolingWater') {
        target = context.readNumber(componentVariablePath(fromComponent, 'coolingWaterOutletTemperatureC'))
      } else if (fromComponent.kind === 'steamGenerator' && link.service === 'mainSteam') {
        target = context.readNumber(componentVariablePath(fromComponent, 'secondaryTemperatureC'))
      } else if (fromComponent.kind === 'turbineLoadSink') {
        target = context.readNumber(componentVariablePath(fromComponent, 'exhaustTemperatureC'))
      } else if (fromComponent.kind === 'heatExchanger' && String(link.fromPortName) === 'hotOut') {
        target = context.readNumber(componentVariablePath(fromComponent, 'hotOutletTemperatureC'))
      } else if (fromComponent.kind === 'heatExchanger' && String(link.fromPortName) === 'coldOut') {
        target = context.readNumber(componentVariablePath(fromComponent, 'coldOutletTemperatureC'))
      } else if (fromComponent.kind === 'containmentVolume' && String(link.fromPortName) === 'sumpOut') {
        target = context.readNumber(componentVariablePath(fromComponent, 'temperatureC'))
      } else if (fromComponent.kind === 'containmentVolume' && String(link.fromPortName) === 'ventOut') {
        target = context.readNumber(componentVariablePath(fromComponent, 'temperatureC'))
      } else if (fromComponent.kind === 'accumulator' && String(link.fromPortName) === 'outlet') {
        target = context.readNumber(componentVariablePath(fromComponent, 'temperatureC'))
      } else {
        target = flowWeightedIncomingLinkValue(system, link.fromComponentIndex, 'temperatureC', context, candidate => serviceMatches(candidate, link.service))
          ?? averageIncomingLinkValue(system, link.fromComponentIndex, 'temperatureC', context, candidate => serviceMatches(candidate, link.service))
          ?? context.readNumber(processLinkVariablePath(link, 'temperatureC'))
      }
      context.write(processLinkVariablePath(link, 'temperatureC'), relaxToward(context.readNumber(processLinkVariablePath(link, 'temperatureC')), target, context.dtSeconds, 10))
    },
  },
]
