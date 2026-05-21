import type { CompiledProcessLink } from '../graph/index.ts'
import type { CompiledProcessPlantSystem } from '../process-systems.ts'
import { approach, averageFor, clamp, parameterNumber } from './component-behaviors.ts'
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

export const processLinkBehaviorDefinitions: ReadonlyArray<ProcessLinkBehaviorDefinition> = [
  {
    id: 'process-link-fluid-flow',
    phase: 'solveFluidFlowLinks',
    writes: ['flowKgPerS'],
    appliesTo: (link): boolean => hasProcessLinkVariable(link, 'flowKgPerS'),
    update: ({ system, link, context }): void => {
      const fromComponent = system.graph.components[link.fromComponentIndex]
      const toComponent = system.graph.components[link.toComponentIndex]
      if (!fromComponent || !toComponent) throw new Error(`process link ${link.id} references missing component`)
      const primaryFlow = averageFor(system.graph.components, component =>
        component.kind === 'centrifugalPump' ? context.readNumber(componentVariablePath(component, 'flowKgPerS')) : null,
      ) ?? 0
      const feedwaterFlow = averageFor(system.graph.components, component =>
        component.kind === 'feedwaterSource' ? context.readNumber(componentVariablePath(component, 'flowKgPerS')) : null,
      ) ?? 0
      const turbineSteamDemand = averageFor(system.graph.components, component => {
        if (component.kind !== 'turbineLoadSink') return null
        return context.readNumber(componentVariablePath(component, 'loadFraction')) * parameterNumber(component, 'nominalSteamFlowKgPerS')
      })
      const turbineSteamFlow = averageFor(system.graph.components, component =>
        component.kind === 'turbineLoadSink' ? context.readNumber(componentVariablePath(component, 'steamFlowKgPerS')) : null,
      ) ?? 0
      const valveFactor = clamp(context.readOptionalNumber(processLinkVariablePath(link, 'valve.positionFraction'), 1), 0, 1)
      const leakFraction = clamp(context.readOptionalNumber(processLinkVariablePath(link, 'leak.areaFraction'), 0), 0, 1)
      const flowSource = link.kind === 'steamFlow'
        ? fromComponent.kind === 'turbineLoadSink'
          ? turbineSteamFlow
          : turbineSteamDemand ?? 0
        : link.medium === 'feedwater'
          ? feedwaterFlow
          : primaryFlow
      context.write(processLinkVariablePath(link, 'flowKgPerS'), flowSource * valveFactor * (1 - leakFraction))
    },
  },
  {
    id: 'process-link-temperature',
    phase: 'updateProcessLinkState',
    writes: ['temperatureC'],
    appliesTo: (link): boolean => hasProcessLinkVariable(link, 'temperatureC'),
    update: ({ system, link, context }): void => {
      const fromComponent = system.graph.components[link.fromComponentIndex]
      const toComponent = system.graph.components[link.toComponentIndex]
      if (!fromComponent || !toComponent) throw new Error(`process link ${link.id} references missing component`)
      let target: number
      if (fromComponent.kind === 'reactorCore') {
        target = context.readNumber(componentVariablePath(fromComponent, 'coolantOutletTemperatureC'))
      } else if (fromComponent.kind === 'steamGenerator' && link.medium === 'primary-water') {
        target = context.readNumber(componentVariablePath(fromComponent, 'primaryOutletTemperatureC'))
      } else if (fromComponent.kind === 'feedwaterSource') {
        target = context.readNumber(componentVariablePath(fromComponent, 'temperatureC'))
      } else if (fromComponent.kind === 'steamGenerator' && link.medium === 'steam') {
        target = context.readNumber(componentVariablePath(fromComponent, 'secondaryTemperatureC'))
      } else if (fromComponent.kind === 'turbineLoadSink') {
        target = 120
      } else if (toComponent.kind === 'reactorCore') {
        target = averageFor(system.graph.components, component =>
          component.kind === 'steamGenerator' ? context.readNumber(componentVariablePath(component, 'primaryOutletTemperatureC')) : null,
        ) ?? context.readNumber(processLinkVariablePath(link, 'temperatureC'))
      } else {
        target = context.readNumber(processLinkVariablePath(link, 'temperatureC'))
      }
      context.write(processLinkVariablePath(link, 'temperatureC'), approach(context.readNumber(processLinkVariablePath(link, 'temperatureC')), target, 3 * context.dtSeconds))
    },
  },
  {
    id: 'process-link-steam-pressure',
    phase: 'updateProcessLinkState',
    writes: ['pressureMPa'],
    appliesTo: (link): boolean => hasProcessLinkVariable(link, 'pressureMPa'),
    update: ({ system, link, context }): void => {
      const steamPressure = averageFor(system.graph.components, component =>
        component.kind === 'steamGenerator' ? context.readNumber(componentVariablePath(component, 'pressureMPa')) : null,
      )
      if (steamPressure !== null) context.write(processLinkVariablePath(link, 'pressureMPa'), steamPressure)
    },
  },
  {
    id: 'process-link-radiation-from-leak',
    phase: 'updateProcessLinkState',
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
