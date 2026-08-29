import { primaryLoopPumpForLink } from '../../graph/index.ts'
import type { CompiledProcessLink } from '../../graph/index.ts'
import type { CompiledProcessPlantSystem } from '../../process-systems.ts'
import { componentVariablePath } from '../behavior-contract.ts'
import type { LinkBehaviorReadContext } from './link-flow-helpers.ts'
import {
  distributeFlowFromComponent,
  downstreamServiceDemandFraction,
  passiveFlowFromIncomingService,
  sourceLimitedPumpFlow,
} from './link-flow-helpers.ts'
import { topologyAwareMainSteamDemandForSourceLink, topologyAwareMainSteamReleaseAvailabilityForSourceLink } from './main-steam-demand.ts'
import { processPlantServices, serviceUsesDownstreamDemand } from '../service-profiles.ts'

export interface ProcessLinkFlowSource {
  readonly flowKgPerS: number
  readonly alreadyIncludesPathAvailability: boolean
  readonly alreadyIncludesTargetValveDemand: boolean
  readonly bypassTargetPumpLimit: boolean
}

export const processLinkFlowSourceFor = (config: {
  readonly system: CompiledProcessPlantSystem
  readonly link: CompiledProcessLink
  readonly context: LinkBehaviorReadContext
}): ProcessLinkFlowSource => {
  const { system, link, context } = config
  const fromComponent = system.graph.components[link.fromComponentIndex]
  if (!fromComponent) throw new Error(`process link ${link.id} references missing source component`)
  const primaryLoopPump = primaryLoopPumpForLink(system.graph, link)
  if (primaryLoopPump !== null) {
    return {
      flowKgPerS: context.readNumber(componentVariablePath(primaryLoopPump, 'loopFlowKgPerS')),
      alreadyIncludesPathAvailability: false,
      alreadyIncludesTargetValveDemand: false,
      bypassTargetPumpLimit: true,
    }
  }
  if (fromComponent.kind === 'centrifugalPump') {
    return {
      flowKgPerS: sourceLimitedPumpFlow(system, link, context, context.readNumber(componentVariablePath(fromComponent, 'flowKgPerS'))),
      alreadyIncludesPathAvailability: false,
      alreadyIncludesTargetValveDemand: false,
      bypassTargetPumpLimit: false,
    }
  }
  if (fromComponent.kind === 'processTank') {
    const sourceFlow = distributeFlowFromComponent(
      system,
      link,
      context,
      context.readNumber(componentVariablePath(fromComponent, 'availableOutletFlowKgPerS')),
    )
    const demandFraction = serviceUsesDownstreamDemand(link.service)
      ? downstreamServiceDemandFraction(system, link, context)
      : 1
    return {
      flowKgPerS: sourceFlow * demandFraction,
      alreadyIncludesPathAvailability: false,
      alreadyIncludesTargetValveDemand: false,
      bypassTargetPumpLimit: false,
    }
  }
  if (fromComponent.kind === 'condenserSink' && link.service === processPlantServices.condensate) {
    return {
      flowKgPerS: distributeFlowFromComponent(
        system,
        link,
        context,
        context.readNumber(componentVariablePath(fromComponent, 'availableCondensateOutletFlowKgPerS')),
      ) * downstreamServiceDemandFraction(system, link, context),
      alreadyIncludesPathAvailability: false,
      alreadyIncludesTargetValveDemand: false,
      bypassTargetPumpLimit: false,
    }
  }
  if (fromComponent.kind === 'condenserSink' && link.service === 'coolingWater') {
    return {
      flowKgPerS: context.readNumber(componentVariablePath(fromComponent, 'coolingWaterFlowKgPerS')),
      alreadyIncludesPathAvailability: false,
      alreadyIncludesTargetValveDemand: false,
      bypassTargetPumpLimit: false,
    }
  }
  if (fromComponent.kind === 'pressurizer' && link.service === 'primaryRelief') {
    return {
      flowKgPerS: context.readNumber(componentVariablePath(fromComponent, 'reliefFlowKgPerS')),
      alreadyIncludesPathAvailability: false,
      alreadyIncludesTargetValveDemand: false,
      bypassTargetPumpLimit: false,
    }
  }
  if (fromComponent.kind === 'reactorVessel' && link.service === 'primaryRelease') {
    return {
      flowKgPerS: context.readNumber(componentVariablePath(fromComponent, 'primaryLeakFlowKgPerS')),
      alreadyIncludesPathAvailability: false,
      alreadyIncludesTargetValveDemand: false,
      bypassTargetPumpLimit: false,
    }
  }
  if (fromComponent.kind === 'steamGenerator' && link.service === processPlantServices.mainSteam) {
    const availableSteamFlow = context.readNumber(componentVariablePath(fromComponent, 'steamFlowKgPerS'))
    return {
      flowKgPerS: Math.min(
        topologyAwareMainSteamDemandForSourceLink(system, link, context)
        + availableSteamFlow * topologyAwareMainSteamReleaseAvailabilityForSourceLink(system, link, context),
        availableSteamFlow,
      ),
      alreadyIncludesPathAvailability: true,
      alreadyIncludesTargetValveDemand: false,
      bypassTargetPumpLimit: false,
    }
  }
  if (fromComponent.kind === 'turbineLoadSink') {
    return {
      flowKgPerS: context.readNumber(componentVariablePath(fromComponent, 'steamFlowKgPerS')),
      alreadyIncludesPathAvailability: false,
      alreadyIncludesTargetValveDemand: false,
      bypassTargetPumpLimit: false,
    }
  }
  if (fromComponent.kind === 'containmentVolume' && String(link.fromPortName) === 'sumpOut') {
    return {
      flowKgPerS: context.readNumber(componentVariablePath(fromComponent, 'sumpOutflowKgPerS')),
      alreadyIncludesPathAvailability: false,
      alreadyIncludesTargetValveDemand: false,
      bypassTargetPumpLimit: false,
    }
  }
  if (fromComponent.kind === 'containmentVolume' && String(link.fromPortName) === 'ventOut') {
    return {
      flowKgPerS: context.readNumber(componentVariablePath(fromComponent, 'releaseFlowKgPerS')),
      alreadyIncludesPathAvailability: false,
      alreadyIncludesTargetValveDemand: false,
      bypassTargetPumpLimit: false,
    }
  }
  if (fromComponent.kind === 'accumulator' && String(link.fromPortName) === 'outlet') {
    return {
      flowKgPerS: context.readNumber(componentVariablePath(fromComponent, 'outletFlowKgPerS')),
      alreadyIncludesPathAvailability: false,
      alreadyIncludesTargetValveDemand: false,
      bypassTargetPumpLimit: false,
    }
  }
  return {
    flowKgPerS: passiveFlowFromIncomingService(system, link, context),
    alreadyIncludesPathAvailability: false,
    alreadyIncludesTargetValveDemand: true,
    bypassTargetPumpLimit: false,
  }
}
