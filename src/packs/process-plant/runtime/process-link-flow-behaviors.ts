import { primaryLoopPumpForLink } from '../graph/index.ts'
import { componentVariablePath, processLinkVariablePath, type ProcessLinkBehaviorDefinition } from './behavior-contract.ts'
import { clamp } from './component-helpers.ts'
import {
  combinedValveFactorForLink,
  componentValveCapacityForInboundLink,
  downstreamServiceDemandFraction,
  distributeFlowFromComponent,
  hasProcessLinkVariable,
  passiveFlowFromIncomingService,
  sourceLimitedPumpFlow,
} from './link-flow-helpers.ts'
import { topologyAwareMainSteamDemandForSourceLink, topologyAwareMainSteamReleaseAvailabilityForSourceLink } from './main-steam-demand.ts'
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
        const sourceFlow = distributeFlowFromComponent(
          system,
          link,
          context,
          context.readNumber(componentVariablePath(fromComponent, 'availableOutletFlowKgPerS')),
        )
        const demandFraction = link.service === 'feedwater' || link.service === 'auxFeedwater' || link.service === 'condensate'
          ? downstreamServiceDemandFraction(system, link, context)
          : 1
        flowSource = sourceFlow * demandFraction
      } else if (fromComponent.kind === 'condenserSink' && link.service === 'condensate') {
        flowSource = distributeFlowFromComponent(
          system,
          link,
          context,
          context.readNumber(componentVariablePath(fromComponent, 'availableCondensateOutletFlowKgPerS')),
        ) * downstreamServiceDemandFraction(system, link, context)
      } else if (fromComponent.kind === 'condenserSink' && link.service === 'coolingWater') {
        flowSource = context.readNumber(componentVariablePath(fromComponent, 'coolingWaterFlowKgPerS'))
      } else if (fromComponent.kind === 'pressurizer' && link.service === 'primaryRelief') {
        flowSource = context.readNumber(componentVariablePath(fromComponent, 'reliefFlowKgPerS'))
      } else if (fromComponent.kind === 'reactorVessel' && link.service === 'primaryRelease') {
        flowSource = context.readNumber(componentVariablePath(fromComponent, 'primaryLeakFlowKgPerS'))
      } else if (fromComponent.kind === 'steamGenerator' && link.service === 'mainSteam') {
        sourceAlreadyIncludesValveFactor = true
        const availableSteamFlow = sourceSteamFlow ?? 0
        flowSource = Math.min(
          topologyAwareMainSteamDemandForSourceLink(system, link, context)
          + availableSteamFlow * topologyAwareMainSteamReleaseAvailabilityForSourceLink(system, link, context),
          availableSteamFlow,
        )
      } else if (fromComponent.kind === 'turbineLoadSink') {
        flowSource = context.readNumber(componentVariablePath(fromComponent, 'steamFlowKgPerS'))
      } else if (fromComponent.kind === 'containmentVolume' && String(link.fromPortName) === 'sumpOut') {
        flowSource = context.readNumber(componentVariablePath(fromComponent, 'sumpOutflowKgPerS'))
      } else if (fromComponent.kind === 'containmentVolume' && String(link.fromPortName) === 'ventOut') {
        flowSource = context.readNumber(componentVariablePath(fromComponent, 'releaseFlowKgPerS'))
      } else if (fromComponent.kind === 'accumulator' && String(link.fromPortName) === 'outlet') {
        flowSource = context.readNumber(componentVariablePath(fromComponent, 'outletFlowKgPerS'))
      } else {
        flowSource = passiveFlowFromIncomingService(system, link, context)
      }
      if (primaryLoopPump === null && toComponent.kind === 'centrifugalPump') {
        flowSource = Math.min(flowSource, context.readNumber(componentVariablePath(toComponent, 'flowKgPerS')))
      }
      const capacity = physicalFlowCapacityKgPerS(link)
      const componentValveCapacity = componentValveCapacityForInboundLink(system, link, context)
      const effectiveValveFactor = sourceAlreadyIncludesValveFactor ? 1 : valveFactor
      context.write(processLinkVariablePath(link, 'flowKgPerS'), Math.min(flowSource, capacity, componentValveCapacity) * effectiveValveFactor * (1 - leakFraction))
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
