import type { CompiledProcessLink } from '../graph/index.ts'
import type { CompiledProcessPlantSystem } from '../process-systems.ts'
import { approach, averageFor, clamp, parameterNumber, relaxToward } from './component-behaviors.ts'
import {
  componentVariablePath,
  createBehaviorContext,
  processLinkVariablePath,
  type ProcessLinkBehaviorDefinition,
} from './behavior-contract.ts'
import type { ProcessPlantSolverPhase } from './model.ts'
import type { ProcessPlantVariableTable } from './variable-table.ts'

const hasProcessLinkVariable = (link: CompiledProcessLink, localPath: string): boolean =>
  link.variables.some(variable => variable.path === processLinkVariablePath(link, localPath))

const serviceMatches = (link: CompiledProcessLink, service: CompiledProcessLink['service']): boolean =>
  service !== undefined && link.service === service

const sumIncomingLinkValue = (
  system: CompiledProcessPlantSystem,
  componentIndex: number,
  localPath: string,
  context: { readonly has: (path: ReturnType<typeof processLinkVariablePath>) => boolean; readonly readNumber: (path: ReturnType<typeof processLinkVariablePath>) => number },
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

const averageIncomingLinkValue = (
  system: CompiledProcessPlantSystem,
  componentIndex: number,
  localPath: string,
  context: { readonly has: (path: ReturnType<typeof processLinkVariablePath>) => boolean; readonly readNumber: (path: ReturnType<typeof processLinkVariablePath>) => number },
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

const primaryCoolantFlowForCoreOutlet = (
  system: CompiledProcessPlantSystem,
  link: CompiledProcessLink,
  context: { readonly has: (path: ReturnType<typeof processLinkVariablePath>) => boolean; readonly readNumber: (path: ReturnType<typeof processLinkVariablePath>) => number },
): number | null => {
  const fromPortName = String(link.fromPortName)
  if (!fromPortName.startsWith('hotLeg')) return null
  const loopName = fromPortName.slice('hotLeg'.length)
  if (loopName.length === 0) return null
  const matchingColdLeg = `coldLeg${loopName}`
  return sumIncomingLinkValue(
    system,
    link.fromComponentIndex,
    'flowKgPerS',
    context,
    candidate => candidate.kind === 'fluidFlow' && candidate.service === 'primaryCoolant' && String(candidate.toPortName) === matchingColdLeg,
  )
}

const passiveFlowFromIncomingService = (
  system: CompiledProcessPlantSystem,
  link: CompiledProcessLink,
  context: { readonly has: (path: ReturnType<typeof processLinkVariablePath>) => boolean; readonly readNumber: (path: ReturnType<typeof processLinkVariablePath>) => number },
): number => {
  const service = link.service
  const matchingService = (candidate: CompiledProcessLink): boolean => candidate.kind === 'fluidFlow' && serviceMatches(candidate, service)
  const incomingFlow = sumIncomingLinkValue(system, link.fromComponentIndex, 'flowKgPerS', context, matchingService)
  const outgoingCount = Math.max(1, outgoingLinkCount(system, link.fromComponentIndex, matchingService))
  return incomingFlow / outgoingCount
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
      let flowSource: number
      if (fromComponent.kind === 'centrifugalPump' || fromComponent.kind === 'feedwaterSource') {
        flowSource = context.readNumber(componentVariablePath(fromComponent, 'flowKgPerS'))
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
      } else if (fromComponent.kind === 'reactorCore' && link.service === 'primaryCoolant') {
        flowSource = primaryCoolantFlowForCoreOutlet(system, link, context) ?? passiveFlowFromIncomingService(system, link, context)
      } else {
        flowSource = passiveFlowFromIncomingService(system, link, context)
      }
      context.write(processLinkVariablePath(link, 'flowKgPerS'), flowSource * valveFactor * (1 - leakFraction))
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
    reads: ['radiationMSvPerH', 'leak.areaFraction?'],
    writes: ['radiationMSvPerH'],
    appliesTo: (link): boolean => hasProcessLinkVariable(link, 'radiationMSvPerH'),
    update: ({ link, context }): void => {
      const leakFraction = clamp(context.readOptionalNumber(processLinkVariablePath(link, 'leak.areaFraction'), 0), 0, 1)
      const currentRadiation = context.readNumber(processLinkVariablePath(link, 'radiationMSvPerH'))
      context.write(processLinkVariablePath(link, 'radiationMSvPerH'), approach(currentRadiation, 0.02 + leakFraction * 25, 2 * context.dtSeconds))
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
