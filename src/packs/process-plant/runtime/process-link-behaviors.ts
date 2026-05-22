import type { CompiledProcessLink } from '../graph/index.ts'
import { primaryLoopPumpForLink } from '../graph/index.ts'
import type { CompiledProcessPlantSystem } from '../process-systems.ts'
import { approach, averageFor, clamp, parameterNumber, relaxToward } from './component-behaviors.ts'
import {
  averageIncomingLinkValue,
  distributeFlowFromComponent,
  hasProcessLinkVariable,
  passiveFlowFromIncomingService,
  serviceMatches,
  sourceLimitedPumpFlow,
} from './link-flow-helpers.ts'
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
