import { componentVariablePath, processLinkVariablePath, type ProcessLinkBehaviorDefinition } from '../behavior-contract.ts'
import { relaxToward } from '../component-helpers.ts'
import { averageIncomingLinkValue, flowWeightedIncomingLinkValue, hasProcessLinkVariable, serviceMatches } from './link-flow-helpers.ts'

export const processLinkChemistryBehaviorDefinitions: ReadonlyArray<ProcessLinkBehaviorDefinition> = [
  {
    id: 'process-link-solute-concentration',
    phase: 'updateProcessLinkState',
    reads: ['soluteConcentrationPpm', 'source component chemistry state'],
    writes: ['soluteConcentrationPpm'],
    appliesTo: (link): boolean => hasProcessLinkVariable(link, 'soluteConcentrationPpm'),
    update: ({ system, link, context }): void => {
      const fromComponent = system.graph.components[link.fromComponentIndex]
      if (!fromComponent) throw new Error(`process link ${link.id} references missing source component`)
      let target: number
      if (fromComponent.kind === 'processTank') {
        target = context.readNumber(componentVariablePath(fromComponent, 'soluteConcentrationPpm'))
      } else if (fromComponent.kind === 'reactorVessel') {
        target = context.readNumber(componentVariablePath(fromComponent, 'boronConcentrationPpm'))
      } else {
        target = flowWeightedIncomingLinkValue(system, link.fromComponentIndex, 'soluteConcentrationPpm', context, candidate => serviceMatches(candidate, link.service))
          ?? averageIncomingLinkValue(system, link.fromComponentIndex, 'soluteConcentrationPpm', context, candidate => serviceMatches(candidate, link.service))
          ?? context.readNumber(processLinkVariablePath(link, 'soluteConcentrationPpm'))
      }
      context.write(
        processLinkVariablePath(link, 'soluteConcentrationPpm'),
        context.dtSeconds === 0
          ? target
          : relaxToward(context.readNumber(processLinkVariablePath(link, 'soluteConcentrationPpm')), target, context.dtSeconds, 10),
      )
    },
  },
]
