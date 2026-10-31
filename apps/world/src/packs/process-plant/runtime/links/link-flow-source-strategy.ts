import { primaryLoopPumpForLink } from '../../graph/index.ts'
import type { CompiledComponent, CompiledProcessLink } from '../../graph/index.ts'
import { pumpDriveSteamPorts } from '../../graph/pump-component-definitions.ts'
import type { CompiledProcessPlant } from '../../plant-compiler.ts'
import { componentVariablePath } from '../behavior-contract.ts'
import type { LinkBehaviorReadContext } from './link-flow-helpers.ts'
import {
  distributeFlowFromComponent,
  downstreamServiceDemandFraction,
  passiveFlowFromIncomingService,
  sourceLimitedPumpFlow,
  sumIncomingLinkValue,
} from './link-flow-helpers.ts'
import { topologyAwareMainSteamDemandForSourceLink, topologyAwareMainSteamReleaseAvailabilityForSourceLink } from './main-steam-demand.ts'
import { processPlantServices, serviceUsesDownstreamDemand } from '../service-profiles.ts'
import { clamp, optionalParameterNumber, parameterNumber } from '../component-helpers.ts'
import { primarySystemPressurizer, primarySystemReactorVessel } from '../system-topology.ts'

const atmosphericPressureMPa = 0.101325

// A steam line's atmospheric relief valve or its bank of safety valves, which vent straight out of the Plant.
const isReliefValve = (component: CompiledComponent | undefined): component is CompiledComponent => {
  const mode = component?.kind === 'steamValve' ? (component.parameters as Readonly<Record<string, unknown>>).valveMode : undefined
  return mode === 'relief' || mode === 'safety'
}


/** The pump whose drive turbine a steam valve supplies, or null for any other valve. */
const drivenPumpOf = (system: CompiledProcessPlant, valve: CompiledComponent | undefined): CompiledComponent | null => {
  if (valve?.kind !== 'steamValve') return null
  for (const index of system.graph.outgoingLinksByComponent[valve.index] ?? []) {
    const onward = system.graph.links[index]
    if (onward?.kind === 'fluidFlow' && String(onward.toPortName) === pumpDriveSteamPorts.inlet) return system.graph.components[onward.toComponentIndex] ?? null
  }
  return null
}

/** Steam a generator's line passes through a valve's flow coefficient at its opening and the generator's pressure, as an atmospheric relief valve or a drive turbine's steam supply valve passes it. */
const generatorSteamThroughValve = (fromComponent: CompiledComponent, valve: CompiledComponent, context: LinkBehaviorReadContext): number => {
  const pressure = context.readNumber(componentVariablePath(fromComponent, 'pressureMPa'))
  const opening = clamp(context.readNumber(componentVariablePath(valve, 'effectivePositionFraction')), 0, 1)
  const valveFlow = parameterNumber(valve, 'cvKgPerSPerSqrtMPa') * opening * Math.sqrt(Math.max(0, pressure - atmosphericPressureMPa))
  return valveFlow
}

export interface ProcessLinkFlowSource {
  readonly flowKgPerS: number
  readonly alreadyIncludesPathAvailability: boolean
  readonly alreadyIncludesTargetValveDemand: boolean
  readonly bypassTargetPumpLimit: boolean
}

/** Requested flow at one actual SG outlet, before its shared finite steam
 * budget is spent. No outlet gets its own copy of the stored dome inventory. */
const generatorSteamRequest = (system: CompiledProcessPlant, link: CompiledProcessLink, context: LinkBehaviorReadContext): ProcessLinkFlowSource => {
  const source = system.graph.components[link.fromComponentIndex]!, target = system.graph.components[link.toComponentIndex]
  const drivenPump = drivenPumpOf(system, target)
  // A steam dump can discharge stored dome steam as well as current boiling.
  // Its reduced rated outlet capacity scales with upstream absolute pressure,
  // as the existing choked-steam relief model does; finite stock is shared
  // below. Restricting a dump to current boiling prevented depressurization.
  const ratedSteamCapacity = optionalParameterNumber(source, 'nominalSteamFlowKgPerS', 760)
    * Math.max(0, context.readNumber(componentVariablePath(source, 'pressureMPa'))) / parameterNumber(source, 'nominalPressureMPa')
  const flow = isReliefValve(target) ? generatorSteamThroughValve(source, target, context)
    : drivenPump !== null && target !== undefined ? context.readBoolean(componentVariablePath(drivenPump, 'running')) ? generatorSteamThroughValve(source, target, context) : 0
      : Math.min(topologyAwareMainSteamDemandForSourceLink(system, link, context)
        + ratedSteamCapacity * topologyAwareMainSteamReleaseAvailabilityForSourceLink(system, link, context), ratedSteamCapacity)
  return { flowKgPerS: flow, alreadyIncludesPathAvailability: true,
    alreadyIncludesTargetValveDemand: isReliefValve(target) || drivenPump !== null, bypassTargetPumpLimit: false }
}

const generatorSteamSource = (system: CompiledProcessPlant, link: CompiledProcessLink, context: LinkBehaviorReadContext & { readonly dtSeconds: number }): ProcessLinkFlowSource => {
  const request = generatorSteamRequest(system, link, context)
  if (context.dtSeconds === 0) return request
  const source = system.graph.components[link.fromComponentIndex]!
  let totalRequested = 0
  for (const index of system.graph.outgoingLinksByComponent[source.index] ?? []) {
    const outlet = system.graph.links[index]!
    if (outlet.kind === 'fluidFlow' && outlet.service === processPlantServices.mainSteam) totalRequested += generatorSteamRequest(system, outlet, context).flowKgPerS
  }
  // The following thermal phase makes this step's steam. Spending only the
  // steam already present keeps the causal split and exact mass balance; a
  // depleted dome cannot discharge its future boiling several times at once.
  const budget = Math.max(0, context.readNumber(componentVariablePath(source, 'steamMassKg'))) / context.dtSeconds
  return { ...request, flowKgPerS: request.flowKgPerS * (totalRequested > 0 ? Math.min(1, budget / totalRequested) : 0) }
}

export const processLinkFlowSourceFor = (config: {
  readonly system: CompiledProcessPlant
  readonly link: CompiledProcessLink
  readonly context: LinkBehaviorReadContext & { readonly dtSeconds: number }
}): ProcessLinkFlowSource => {
  const { system, link, context } = config
  const fromComponent = system.graph.components[link.fromComponentIndex]
  if (!fromComponent) throw new Error(`process link ${link.id} references missing source component`)
  const toComponent = system.graph.components[link.toComponentIndex]
  const vessel = toComponent?.kind === 'pressurizer' && link.service === 'primaryCoolant' ? primarySystemReactorVessel(system) : null
  if (vessel !== null) {
    // The surge line carries the loops' surge either way; the vessel's
    // signed surge flow says which.
    return {
      flowKgPerS: Math.abs(context.readNumber(componentVariablePath(vessel, 'surgeFlowKgPerS'))),
      alreadyIncludesPathAvailability: true,
      alreadyIncludesTargetValveDemand: true,
      bypassTargetPumpLimit: true,
    }
  }
  const primaryLoopPump = primaryLoopPumpForLink(system.graph, link)
  if (primaryLoopPump !== null) {
    // A loop's legs carry its flow either way; the pump says which.
    return {
      flowKgPerS: context.readNumber(componentVariablePath(primaryLoopPump, 'loopFlowKgPerS')) + context.readNumber(componentVariablePath(primaryLoopPump, 'loopReverseFlowKgPerS')),
      alreadyIncludesPathAvailability: false,
      alreadyIncludesTargetValveDemand: false,
      bypassTargetPumpLimit: true,
    }
  }
  if (fromComponent.kind === 'centrifugalPump' && String(link.fromPortName) === pumpDriveSteamPorts.exhaust) {
    // The drive turbine exhausts all the steam it takes.
    return {
      flowKgPerS: sumIncomingLinkValue(system, fromComponent.index, 'flowKgPerS', context, candidate => candidate.kind === 'fluidFlow' && String(candidate.toPortName) === pumpDriveSteamPorts.inlet),
      alreadyIncludesPathAvailability: true,
      alreadyIncludesTargetValveDemand: true,
      bypassTargetPumpLimit: false,
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
    const inventory = context.readNumber(componentVariablePath(fromComponent, 'inventoryKg'))
    const inventoryBudget = context.dtSeconds > 0 ? inventory / context.dtSeconds : inventory > 0 ? Number.POSITIVE_INFINITY : 0
    const sourceFlow = distributeFlowFromComponent(
      system, link, context,
      Math.min(context.readNumber(componentVariablePath(fromComponent, 'availableOutletFlowKgPerS')), inventoryBudget),
    )
    return {
      flowKgPerS: sourceFlow,
      alreadyIncludesPathAvailability: true,
      alreadyIncludesTargetValveDemand: true,
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
    const reliefFlowByPort: Readonly<Record<string, string>> = { reliefOutlet: 'reliefFlowKgPerS', safetyOutlet: 'safetyValveFlowKgPerS' }
    const flowVariable = reliefFlowByPort[String(link.fromPortName)]
    if (flowVariable === undefined) throw new Error(`pressurizer relief link ${link.id} leaves port ${link.fromPortName}, which relieves nothing`)
    return {
      flowKgPerS: context.readNumber(componentVariablePath(fromComponent, flowVariable)),
      alreadyIncludesPathAvailability: false,
      alreadyIncludesTargetValveDemand: false,
      bypassTargetPumpLimit: false,
    }
  }
  if (fromComponent.kind === 'reactorVessel' && link.service === 'letdown') {
    // The letdown line's backpressure valve holds the pressure behind the
    // orifices, so they pass their rated flow while the coolant pressure is
    // well above it, and less as the coolant pressure falls toward it, with
    // the square root of the remaining difference. The letdown valve sets the rest.
    const pressurizer = primarySystemPressurizer(system)
    const backpressure = parameterNumber(fromComponent, 'letdownBackpressureMPa')
    const pressureFraction = pressurizer === null
      ? 1
      : (context.readNumber(componentVariablePath(pressurizer, 'pressureMPa')) - backpressure) / backpressure
    return {
      flowKgPerS: optionalParameterNumber(fromComponent, 'normalLetdownFlowKgPerS', 0) * Math.sqrt(Math.max(0, Math.min(1, pressureFraction))),
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
  if (fromComponent.kind === 'steamGenerator' && link.service === processPlantServices.mainSteam) return generatorSteamSource(system, link, context)
  if (toComponent?.kind === 'centrifugalPump' && String(link.toPortName) === pumpDriveSteamPorts.inlet) {
    // The drive turbine takes what its supply valve passes, whatever water the pump moves.
    return {
      flowKgPerS: sumIncomingLinkValue(system, link.fromComponentIndex, 'flowKgPerS', context, candidate => candidate.kind === 'fluidFlow' && candidate.service === link.service),
      alreadyIncludesPathAvailability: true,
      alreadyIncludesTargetValveDemand: true,
      bypassTargetPumpLimit: true,
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
      flowKgPerS: distributeFlowFromComponent(system, link, context, Math.min(
        optionalParameterNumber(fromComponent, 'maxSumpOutflowKgPerS', 0),
        context.dtSeconds > 0 ? context.readNumber(componentVariablePath(fromComponent, 'sumpInventoryKg')) / context.dtSeconds
          : context.readNumber(componentVariablePath(fromComponent, 'sumpInventoryKg')) > 0 ? Number.POSITIVE_INFINITY : 0,
      )),
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
