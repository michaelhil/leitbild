import { componentVariablePath, processLinkVariablePath, type ProcessLinkBehaviorDefinition } from '../behavior-contract.ts'
import { approach, clamp } from '../component-helpers.ts'
import { averageIncomingLinkValue, flowWeightedIncomingLinkValue, hasProcessLinkVariable, serviceMatches } from './link-flow-helpers.ts'

export const processLinkRadiationBehaviorDefinitions: ReadonlyArray<ProcessLinkBehaviorDefinition> = [
  {
    id: 'process-link-radiation-from-leak',
    phase: 'updateProcessLinkState',
    reads: ['radiationMSvPerH', 'leak.areaFraction?', 'source steam generator secondaryRadiationMSvPerH?'],
    writes: ['radiationMSvPerH'],
    appliesTo: (link): boolean => hasProcessLinkVariable(link, 'radiationMSvPerH'),
    update: ({ system, link, context }): void => {
      const fromComponent = system.graph.components[link.fromComponentIndex]
      if (!fromComponent) throw new Error(`process link ${link.id} references missing source component`)
      const leakFraction = clamp(context.readOptionalNumber(processLinkVariablePath(link, 'leak.areaFraction'), 0), 0, 1)
      const currentRadiation = context.readNumber(processLinkVariablePath(link, 'radiationMSvPerH'))
      if (fromComponent.kind === 'reactorVessel' && link.service === 'primaryRelease') {
        context.write(processLinkVariablePath(link, 'radiationMSvPerH'), approach(
          currentRadiation,
          context.readNumber(componentVariablePath(fromComponent, 'primaryReleaseRadiationMSvPerH')),
          2 * context.dtSeconds,
        ))
        return
      }
      const sourceRadiationPath = componentVariablePath(fromComponent, 'secondaryRadiationMSvPerH')
      const sourceRadiation = context.has(sourceRadiationPath)
        ? context.readNumber(sourceRadiationPath)
        : flowWeightedIncomingLinkValue(system, link.fromComponentIndex, 'radiationMSvPerH', context, candidate => serviceMatches(candidate, link.service))
          ?? averageIncomingLinkValue(system, link.fromComponentIndex, 'radiationMSvPerH', context, candidate => serviceMatches(candidate, link.service))
          ?? 0.02
      context.write(processLinkVariablePath(link, 'radiationMSvPerH'), approach(currentRadiation, Math.max(0.02, sourceRadiation) + leakFraction * 25, 2 * context.dtSeconds))
    },
  },
]
