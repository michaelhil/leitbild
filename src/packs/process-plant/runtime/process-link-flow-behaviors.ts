import { primaryLoopPumpForLink } from '../graph/index.ts'
import { componentVariablePath, processLinkVariablePath, type ProcessLinkBehaviorDefinition } from './behavior-contract.ts'
import { clamp } from './component-helpers.ts'
import {
  combinedValveFactorForLink,
  distributeFlowFromComponent,
  hasProcessLinkVariable,
  passiveFlowFromIncomingService,
  sourceLimitedPumpFlow,
} from './link-flow-helpers.ts'
import { topologyAwareMainSteamDemandForSourceLink } from './main-steam-demand.ts'
import { pressureDrivenLeakFlowKgPerS } from './physics.ts'
import { physicalFlowCapacityKgPerS, physicalNumber } from './process-link-physical.ts'

export const processLinkFlowBehaviorDefinitions: ReadonlyArray<ProcessLinkBehaviorDefinition> = [
  {
    id: 'process-link-fluid-flow',
    phase: 'solveFluidFlowLinks',
    reads: ['valve.positionFraction?', 'leak.areaFraction?', 'source component flow demand'],
    writes: ['flowKgPerS'],
    appliesTo: (link): boolean => link.kind === 'fluidFlow' && hasProcessLinkVariable(link, 'flowKgPerS'),
    update: ({ system, link, context }): void => {
      const fromComponent = system.graph.components[link.fromComponentIndex]
      const toComponent = system.graph.components[link.toComponentIndex]
      if (!fromComponent || !toComponent) throw new Error(`process link ${link.id} references missing component`)
      const sourceSteamFlow = fromComponent.kind === 'steamGenerator'
        ? context.readNumber(componentVariablePath(fromComponent, 'steamFlowKgPerS'))
        : null
      const valveFactor = combinedValveFactorForLink(system, link, context)
      const leakFraction = clamp(context.readOptionalNumber(processLinkVariablePath(link, 'leak.areaFraction'), 0), 0, 1)
      const primaryLoopPump = primaryLoopPumpForLink(system.graph, link)
      let flowSource: number
      let sourceAlreadyIncludesValveFactor = false
      if (primaryLoopPump !== null) {
        flowSource = context.readNumber(componentVariablePath(primaryLoopPump, 'loopFlowKgPerS'))
      } else if (fromComponent.kind === 'centrifugalPump') {
        flowSource = sourceLimitedPumpFlow(system, link, context, context.readNumber(componentVariablePath(fromComponent, 'flowKgPerS')))
      } else if (fromComponent.kind === 'processTank') {
        flowSource = distributeFlowFromComponent(
          system,
          link,
          context,
          context.readNumber(componentVariablePath(fromComponent, 'availableOutletFlowKgPerS')),
        )
      } else if (fromComponent.kind === 'condenserSink' && link.service === 'condensate') {
        flowSource = distributeFlowFromComponent(
          system,
          link,
          context,
          context.readNumber(componentVariablePath(fromComponent, 'availableCondensateOutletFlowKgPerS')),
        )
      } else if (fromComponent.kind === 'pressurizer' && link.service === 'primaryRelief') {
        flowSource = context.readNumber(componentVariablePath(fromComponent, 'reliefFlowKgPerS'))
      } else if (fromComponent.kind === 'steamGenerator' && link.service === 'mainSteam') {
        sourceAlreadyIncludesValveFactor = true
        flowSource = Math.min(topologyAwareMainSteamDemandForSourceLink(system, link, context), sourceSteamFlow ?? 0)
      } else if (fromComponent.kind === 'turbineLoadSink') {
        flowSource = context.readNumber(componentVariablePath(fromComponent, 'steamFlowKgPerS'))
      } else {
        flowSource = passiveFlowFromIncomingService(system, link, context)
      }
      if (primaryLoopPump === null && toComponent.kind === 'centrifugalPump') {
        flowSource = Math.min(flowSource, context.readNumber(componentVariablePath(toComponent, 'flowKgPerS')))
      }
      const capacity = physicalFlowCapacityKgPerS(link)
      const effectiveValveFactor = sourceAlreadyIncludesValveFactor ? 1 : valveFactor
      context.write(processLinkVariablePath(link, 'flowKgPerS'), Math.min(flowSource, capacity) * effectiveValveFactor * (1 - leakFraction))
    },
  },
  {
    id: 'process-link-pressure-driven-leak',
    phase: 'solveFluidFlowLinks',
    reads: ['pressureMPa', 'leak.areaFraction?', 'physical.leakCoefficientKgPerSPerSqrtMPa'],
    writes: ['leakFlowKgPerS'],
    appliesTo: (link): boolean =>
      link.kind === 'fluidFlow'
      && hasProcessLinkVariable(link, 'pressureMPa')
      && hasProcessLinkVariable(link, 'leakFlowKgPerS'),
    update: ({ link, context }): void => {
      const pressure = context.readNumber(processLinkVariablePath(link, 'pressureMPa'))
      const leakArea = context.readOptionalNumber(processLinkVariablePath(link, 'leak.areaFraction'), 0)
      context.write(processLinkVariablePath(link, 'leakFlowKgPerS'), pressureDrivenLeakFlowKgPerS({
        areaFraction: leakArea,
        pressureDeltaMPa: pressure - 0.101325,
        coefficientKgPerSPerSqrtMPa: physicalNumber(link, 'leakCoefficientKgPerSPerSqrtMPa', 0),
      }))
    },
  },
]
