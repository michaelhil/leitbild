import type { CompiledProcessLink } from '../graph/index.ts'
import { primaryLoopPumpForLink } from '../graph/index.ts'
import type { CompiledProcessPlantSystem } from '../process-systems.ts'
import { approach, averageFor, clamp, parameterNumber, relaxToward } from './component-behaviors.ts'
import {
  pressureDrivenLeakFlowKgPerS,
  pressureDropMPaFromFlow,
} from './physics.ts'
import {
  componentVariablePath,
  createBehaviorContext,
  processLinkVariablePath,
  type ProcessLinkBehaviorDefinition,
} from './behavior-contract.ts'
import type { ProcessPlantSolverPhase } from './model.ts'
import type { ProcessPlantVariableTable } from './variable-table.ts'

type LinkBehaviorReadContext = {
  readonly has: (path: ReturnType<typeof processLinkVariablePath>) => boolean
  readonly readNumber: (path: ReturnType<typeof processLinkVariablePath>) => number
  readonly readOptionalNumber: (path: ReturnType<typeof processLinkVariablePath>, defaultValue: number) => number
}

const hasProcessLinkVariable = (link: CompiledProcessLink, localPath: string): boolean =>
  link.variables.some(variable => variable.path === processLinkVariablePath(link, localPath))

const serviceMatches = (link: CompiledProcessLink, service: CompiledProcessLink['service']): boolean =>
  service !== undefined && link.service === service

const sumIncomingLinkValue = (
  system: CompiledProcessPlantSystem,
  componentIndex: number,
  localPath: string,
  context: Pick<LinkBehaviorReadContext, 'has' | 'readNumber'>,
  linkMatches: (link: CompiledProcessLink) => boolean,
): number => {
  let total = 0
  for (const linkIndex of system.graph.incomingLinksByComponent[componentIndex] ?? []) {
    const link = system.graph.links[linkIndex]
    if (!link || !linkMatches(link)) continue
    const path = processLinkVariablePath(link, localPath)
    if (!context.has(path)) continue
    total += context.readNumber(path)
  }
  return total
}

const incomingLinkValueStats = (
  system: CompiledProcessPlantSystem,
  componentIndex: number,
  localPath: string,
  context: Pick<LinkBehaviorReadContext, 'has' | 'readNumber'>,
  linkMatches: (link: CompiledProcessLink) => boolean,
): { readonly matchingLinks: number; readonly valuedLinks: number; readonly total: number } => {
  let matchingLinks = 0
  let valuedLinks = 0
  let total = 0
  for (const linkIndex of system.graph.incomingLinksByComponent[componentIndex] ?? []) {
    const link = system.graph.links[linkIndex]
    if (!link || !linkMatches(link)) continue
    matchingLinks += 1
    const path = processLinkVariablePath(link, localPath)
    if (!context.has(path)) continue
    total += context.readNumber(path)
    valuedLinks += 1
  }
  return { matchingLinks, valuedLinks, total }
}

const averageIncomingLinkValue = (
  system: CompiledProcessPlantSystem,
  componentIndex: number,
  localPath: string,
  context: Pick<LinkBehaviorReadContext, 'has' | 'readNumber'>,
  linkMatches: (link: CompiledProcessLink) => boolean,
): number | null => {
  let total = 0
  let count = 0
  for (const linkIndex of system.graph.incomingLinksByComponent[componentIndex] ?? []) {
    const link = system.graph.links[linkIndex]
    if (!link || !linkMatches(link)) continue
    const path = processLinkVariablePath(link, localPath)
    if (!context.has(path)) continue
    total += context.readNumber(path)
    count += 1
  }
  return count === 0 ? null : total / count
}

const outgoingLinkCount = (
  system: CompiledProcessPlantSystem,
  componentIndex: number,
  linkMatches: (link: CompiledProcessLink) => boolean,
): number => {
  let count = 0
  for (const linkIndex of system.graph.outgoingLinksByComponent[componentIndex] ?? []) {
    const link = system.graph.links[linkIndex]
    if (link && linkMatches(link)) count += 1
  }
  return count
}

const mainSteamSourceCount = (system: CompiledProcessPlantSystem): number => {
  const cached = mainSteamSourceCountCache.get(system)
  if (cached !== undefined) return cached
  let count = 0
  for (const link of system.graph.links) {
    const fromComponent = system.graph.components[link.fromComponentIndex]
    if (fromComponent?.kind === 'steamGenerator' && link.kind === 'fluidFlow' && link.service === 'mainSteam') count += 1
  }
  const result = Math.max(1, count)
  mainSteamSourceCountCache.set(system, result)
  return result
}

const mainSteamSourceCountCache = new WeakMap<CompiledProcessPlantSystem, number>()

const findFirstComponentByKind = (
  system: CompiledProcessPlantSystem,
  kind: string,
) => system.graph.components.find(component => String(component.kind) === kind) ?? null

const physicalNumber = (
  link: CompiledProcessLink,
  key: 'nominalResistance' | 'nominalFlowKgPerS' | 'leakCoefficientKgPerSPerSqrtMPa',
  defaultValue: number,
): number => {
  const value = link.physical?.[key]
  return value === undefined ? defaultValue : value
}

const downstreamValveDemandWeight = (
  system: CompiledProcessPlantSystem,
  link: CompiledProcessLink,
  context: LinkBehaviorReadContext,
): number | null => {
  const toComponent = system.graph.components[link.toComponentIndex]
  if (toComponent?.kind !== 'processValve') return null
  let demandWeight = 0
  let hasDemandSignal = false
  for (const outgoingLinkIndex of system.graph.outgoingLinksByComponent[toComponent.index] ?? []) {
    const outgoingLink = system.graph.links[outgoingLinkIndex]
    if (!outgoingLink || outgoingLink.kind !== 'fluidFlow' || !serviceMatches(outgoingLink, link.service)) continue
    if (!hasProcessLinkVariable(outgoingLink, 'valve.positionFraction')) {
      demandWeight += 1
      continue
    }
    hasDemandSignal = true
    demandWeight += clamp(context.readOptionalNumber(processLinkVariablePath(outgoingLink, 'valve.positionFraction'), 1), 0, 1)
  }
  if (!hasDemandSignal && demandWeight === 0) return null
  return demandWeight
}

const outgoingDemandWeight = (
  system: CompiledProcessPlantSystem,
  link: CompiledProcessLink,
  context: LinkBehaviorReadContext,
): number =>
  downstreamValveDemandWeight(system, link, context) ?? 1

const outgoingDemandWeightTotal = (
  system: CompiledProcessPlantSystem,
  componentIndex: number,
  service: CompiledProcessLink['service'],
  context: LinkBehaviorReadContext,
): number => {
  let total = 0
  for (const linkIndex of system.graph.outgoingLinksByComponent[componentIndex] ?? []) {
    const link = system.graph.links[linkIndex]
    if (!link || link.kind !== 'fluidFlow' || !serviceMatches(link, service)) continue
    total += outgoingDemandWeight(system, link, context)
  }
  return total
}

const distributeFlowFromComponent = (
  system: CompiledProcessPlantSystem,
  link: CompiledProcessLink,
  context: LinkBehaviorReadContext,
  availableFlowKgPerS: number,
): number => {
  const totalDemandWeight = outgoingDemandWeightTotal(system, link.fromComponentIndex, link.service, context)
  if (totalDemandWeight <= 0) return 0
  return availableFlowKgPerS * outgoingDemandWeight(system, link, context) / totalDemandWeight
}

const passiveFlowFromIncomingService = (
  system: CompiledProcessPlantSystem,
  link: CompiledProcessLink,
  context: LinkBehaviorReadContext,
): number => {
  const service = link.service
  const matchingService = (candidate: CompiledProcessLink): boolean => candidate.kind === 'fluidFlow' && serviceMatches(candidate, service)
  const incomingFlow = sumIncomingLinkValue(system, link.fromComponentIndex, 'flowKgPerS', context, matchingService)
  return distributeFlowFromComponent(system, link, context, incomingFlow)
}

const sourceLimitedPumpFlow = (
  system: CompiledProcessPlantSystem,
  link: CompiledProcessLink,
  context: Pick<LinkBehaviorReadContext, 'has' | 'readNumber'>,
  pumpFlow: number,
): number => {
  const incomingFlow = incomingLinkValueStats(
    system,
    link.fromComponentIndex,
    'flowKgPerS',
    context,
    candidate => candidate.kind === 'fluidFlow' && serviceMatches(candidate, link.service),
  )
  if (incomingFlow.matchingLinks === 0) return pumpFlow
  if (incomingFlow.valuedLinks === 0) return 0
  return Math.min(pumpFlow, incomingFlow.total)
}

export const processLinkBehaviorDefinitions: ReadonlyArray<ProcessLinkBehaviorDefinition> = [
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
      const valveFactor = clamp(context.readOptionalNumber(processLinkVariablePath(link, 'valve.positionFraction'), 1), 0, 1)
      const leakFraction = clamp(context.readOptionalNumber(processLinkVariablePath(link, 'leak.areaFraction'), 0), 0, 1)
      const primaryLoopPump = primaryLoopPumpForLink(system.graph, link)
      let flowSource: number
      if (primaryLoopPump !== null) {
        flowSource = context.readNumber(componentVariablePath(primaryLoopPump, 'loopFlowKgPerS'))
      } else if (fromComponent.kind === 'centrifugalPump') {
        flowSource = sourceLimitedPumpFlow(system, link, context, context.readNumber(componentVariablePath(fromComponent, 'flowKgPerS')))
      } else if (fromComponent.kind === 'feedwaterSource') {
        flowSource = context.readNumber(componentVariablePath(fromComponent, 'flowKgPerS'))
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
        const turbineSteamDemand = averageFor(system.graph.components, component => {
          if (component.kind !== 'turbineLoadSink') return null
          return context.readNumber(componentVariablePath(component, 'loadFraction')) * parameterNumber(component, 'nominalSteamFlowKgPerS')
        })
        flowSource = Math.min((turbineSteamDemand ?? 0) / mainSteamSourceCount(system), sourceSteamFlow ?? turbineSteamDemand ?? 0)
      } else if (fromComponent.kind === 'turbineLoadSink') {
        const turbineSteamFlow = averageFor(system.graph.components, component =>
          component.kind === 'turbineLoadSink' ? context.readNumber(componentVariablePath(component, 'steamFlowKgPerS')) : null,
        ) ?? 0
        flowSource = turbineSteamFlow
      } else {
        flowSource = passiveFlowFromIncomingService(system, link, context)
      }
      if (primaryLoopPump === null && toComponent.kind === 'centrifugalPump') {
        flowSource = Math.min(flowSource, context.readNumber(componentVariablePath(toComponent, 'flowKgPerS')))
      }
      context.write(processLinkVariablePath(link, 'flowKgPerS'), flowSource * valveFactor * (1 - leakFraction))
    },
  },
  {
    id: 'process-link-primary-pressure-drop',
    phase: 'solveFluidFlowLinks',
    reads: ['flowKgPerS', 'pressurizer.pressureMPa', 'physical.nominalResistance', 'physical.nominalFlowKgPerS'],
    writes: ['pressureDropMPa', 'pressureMPa'],
    appliesTo: (link): boolean =>
      link.service === 'primaryCoolant'
      && hasProcessLinkVariable(link, 'flowKgPerS')
      && hasProcessLinkVariable(link, 'pressureDropMPa')
      && hasProcessLinkVariable(link, 'pressureMPa'),
    update: ({ system, link, context }): void => {
      const pressurizer = findFirstComponentByKind(system, 'pressurizer')
      if (pressurizer === null || !context.has(componentVariablePath(pressurizer, 'pressureMPa'))) {
        throw new Error(`primary coolant pressure link ${link.id} requires a pressurizer pressure source`)
      }
      const flow = context.readNumber(processLinkVariablePath(link, 'flowKgPerS'))
      const pressureDrop = pressureDropMPaFromFlow({
        flowKgPerS: flow,
        nominalFlowKgPerS: physicalNumber(link, 'nominalFlowKgPerS', 4_250),
        nominalPressureDropMPa: physicalNumber(link, 'nominalResistance', 0),
      })
      const sourcePressure = context.readNumber(componentVariablePath(pressurizer, 'pressureMPa'))
      context.write(processLinkVariablePath(link, 'pressureDropMPa'), pressureDrop)
      context.write(processLinkVariablePath(link, 'pressureMPa'), Math.max(0.2, sourcePressure - pressureDrop))
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
      } else if (fromComponent.kind === 'feedwaterSource') {
        target = context.readNumber(componentVariablePath(fromComponent, 'temperatureC'))
      } else if (fromComponent.kind === 'pressurizer' && link.service === 'primaryRelief') {
        target = context.readNumber(componentVariablePath(fromComponent, 'steamTemperatureC'))
      } else if (fromComponent.kind === 'processTank') {
        target = context.readNumber(componentVariablePath(fromComponent, 'temperatureC'))
      } else if (fromComponent.kind === 'condenserSink' && link.service === 'condensate') {
        target = context.readNumber(componentVariablePath(fromComponent, 'condensateTemperatureC'))
      } else if (fromComponent.kind === 'steamGenerator' && link.service === 'mainSteam') {
        target = context.readNumber(componentVariablePath(fromComponent, 'secondaryTemperatureC'))
      } else if (fromComponent.kind === 'turbineLoadSink') {
        target = 120
      } else if (toComponent.kind === 'reactorCore') {
        target = averageIncomingLinkValue(system, link.fromComponentIndex, 'temperatureC', context, candidate => serviceMatches(candidate, link.service))
          ?? context.readNumber(processLinkVariablePath(link, 'temperatureC'))
      } else {
        target = averageIncomingLinkValue(system, link.fromComponentIndex, 'temperatureC', context, candidate => serviceMatches(candidate, link.service))
          ?? context.readNumber(processLinkVariablePath(link, 'temperatureC'))
      }
      context.write(processLinkVariablePath(link, 'temperatureC'), relaxToward(context.readNumber(processLinkVariablePath(link, 'temperatureC')), target, context.dtSeconds, 10))
    },
  },
  {
    id: 'process-link-steam-pressure',
    phase: 'updateProcessLinkState',
    reads: ['source steam generator pressureMPa'],
    writes: ['pressureMPa'],
    appliesTo: (link): boolean => hasProcessLinkVariable(link, 'pressureMPa'),
    update: ({ system, link, context }): void => {
      const fromComponent = system.graph.components[link.fromComponentIndex]
      if (!fromComponent) throw new Error(`process link ${link.id} references missing source component`)
      if (link.service === 'primaryCoolant') {
        const pressurizer = findFirstComponentByKind(system, 'pressurizer')
        if (pressurizer !== null && context.has(componentVariablePath(pressurizer, 'pressureMPa'))) {
          const pressureDrop = context.readOptionalNumber(processLinkVariablePath(link, 'pressureDropMPa'), 0)
          context.write(processLinkVariablePath(link, 'pressureMPa'), Math.max(0.2, context.readNumber(componentVariablePath(pressurizer, 'pressureMPa')) - pressureDrop))
          return
        }
      }
      if (fromComponent.kind === 'steamGenerator') {
        context.write(processLinkVariablePath(link, 'pressureMPa'), context.readNumber(componentVariablePath(fromComponent, 'pressureMPa')))
        return
      }
      const sourcePressure = averageIncomingLinkValue(
        system,
        link.fromComponentIndex,
        'pressureMPa',
        context,
        candidate => candidate.service === link.service,
      )
      if (sourcePressure !== null) {
        context.write(processLinkVariablePath(link, 'pressureMPa'), sourcePressure)
        return
      }
      const steamPressure = averageFor(system.graph.components, component =>
        component.kind === 'steamGenerator' ? context.readNumber(componentVariablePath(component, 'pressureMPa')) : null,
      )
      if (steamPressure !== null) context.write(processLinkVariablePath(link, 'pressureMPa'), steamPressure)
    },
  },
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
      const sourceRadiationPath = componentVariablePath(fromComponent, 'secondaryRadiationMSvPerH')
      const sourceRadiation = context.has(sourceRadiationPath) ? context.readNumber(sourceRadiationPath) : 0.02
      context.write(processLinkVariablePath(link, 'radiationMSvPerH'), approach(currentRadiation, Math.max(0.02, sourceRadiation) + leakFraction * 25, 2 * context.dtSeconds))
    },
  },
]

export const runProcessLinkBehaviors = (
  system: CompiledProcessPlantSystem,
  table: ProcessPlantVariableTable,
  phase: ProcessPlantSolverPhase,
  dtSeconds: number,
): void => {
  for (const behavior of processLinkBehaviorDefinitions) {
    if (behavior.phase !== phase) continue
    for (const link of system.graph.links) {
      if (!behavior.appliesTo(link)) continue
      const writablePaths = new Set(behavior.writes.map(localPath => processLinkVariablePath(link, localPath)))
      behavior.update({
        system,
        link,
        context: createBehaviorContext({
          behaviorId: behavior.id,
          phase,
          dtSeconds,
          table,
          writablePaths,
        }),
      })
    }
  }
}
