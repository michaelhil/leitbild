import type { CompiledProcessLink, VariablePath } from '../graph/index.ts'
import type { CompiledProcessPlantSystem } from '../process-systems.ts'
import { approach, averageFor, clamp, componentVariablePath, parameterNumber } from './component-behaviors.ts'
import type { ProcessPlantVariableTable } from './variable-table.ts'

export const processLinkVariablePath = (link: CompiledProcessLink, localPath: string): VariablePath =>
  `${link.id}.${localPath}` as VariablePath

const hasProcessLinkVariable = (link: CompiledProcessLink, localPath: string): boolean =>
  link.variables.some(variable => variable.path === processLinkVariablePath(link, localPath))

export const solveFluidFlowLinks = (system: CompiledProcessPlantSystem, table: ProcessPlantVariableTable): void => {
  const primaryFlow = averageFor(system.graph.components, component =>
    component.kind === 'centrifugalPump' ? table.readNumber(componentVariablePath(component, 'flowKgPerS')) : null,
  ) ?? 0
  const feedwaterFlow = averageFor(system.graph.components, component =>
    component.kind === 'feedwaterSource' ? table.readNumber(componentVariablePath(component, 'flowKgPerS')) : null,
  ) ?? 0
  const turbineSteamDemand = averageFor(system.graph.components, component =>
    component.kind === 'turbineLoadSink' ? table.readNumber(componentVariablePath(component, 'electricMw')) * 0.7 : null,
  ) ?? 0
  for (const link of system.graph.links) {
    if (!hasProcessLinkVariable(link, 'flowKgPerS')) continue
    const valveFactor = clamp(table.readOptionalNumber(processLinkVariablePath(link, 'valve.positionFraction'), 1), 0, 1)
    const leakFraction = clamp(table.readOptionalNumber(processLinkVariablePath(link, 'leak.areaFraction'), 0), 0, 1)
    const flowSource = link.kind === 'steamFlow'
      ? turbineSteamDemand
      : link.medium === 'feedwater'
        ? feedwaterFlow
        : primaryFlow
    table.write(processLinkVariablePath(link, 'flowKgPerS'), flowSource * valveFactor * (1 - leakFraction))
  }
}

export const updateProcessLinkState = (system: CompiledProcessPlantSystem, table: ProcessPlantVariableTable, dtSeconds: number): void => {
  const steamPressure = averageFor(system.graph.components, component =>
    component.kind === 'steamGenerator' ? table.readNumber(componentVariablePath(component, 'pressureMPa')) : null,
  )
  for (const link of system.graph.links) {
    if (steamPressure !== null && hasProcessLinkVariable(link, 'pressureMPa')) {
      table.write(processLinkVariablePath(link, 'pressureMPa'), steamPressure)
    }
    if (hasProcessLinkVariable(link, 'radiationMSvPerH')) {
      const leakFraction = clamp(table.readOptionalNumber(processLinkVariablePath(link, 'leak.areaFraction'), 0), 0, 1)
      const currentRadiation = table.readNumber(processLinkVariablePath(link, 'radiationMSvPerH'))
      table.write(processLinkVariablePath(link, 'radiationMSvPerH'), approach(currentRadiation, 0.02 + leakFraction * 25, 2 * dtSeconds))
    }
  }
}
