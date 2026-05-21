import type { CompiledComponent, VariablePath } from '../graph/index.ts'
import type { CompiledProcessPlantSystem } from '../process-systems.ts'
import type { ProcessPlantValue } from './model.ts'
import type { ProcessPlantVariableTable } from './variable-table.ts'

export const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value))

export const approach = (current: number, target: number, maxDelta: number): number => {
  if (Math.abs(target - current) <= maxDelta) return target
  return current + Math.sign(target - current) * maxDelta
}

export const parameterNumber = (component: CompiledComponent, key: string): number => {
  const parameters = component.parameters
  if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) throw new Error(`component ${component.id} parameters are not an object`)
  const value = (parameters as Record<string, unknown>)[key]
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`component ${component.id} missing numeric parameter ${key}`)
  return value
}

export const componentVariablePath = (component: CompiledComponent, localPath: string): VariablePath =>
  `${component.id}.${localPath}` as VariablePath

const hasComponentVariable = (component: CompiledComponent, localPath: string): boolean =>
  component.variables.some(variable => variable.path === componentVariablePath(component, localPath))

export const averageFor = (
  components: ReadonlyArray<CompiledComponent>,
  valueFor: (component: CompiledComponent) => number | null,
): number | null => {
  let total = 0
  let count = 0
  for (const component of components) {
    const value = valueFor(component)
    if (value === null) continue
    total += value
    count += 1
  }
  return count === 0 ? null : total / count
}

export const initialComponentValueFor = (component: CompiledComponent, path: VariablePath): ProcessPlantValue => {
  const localPath = String(path).slice(String(component.id).length + 1)
  if (component.kind === 'reactorCore') {
    const ratedPowerMw = parameterNumber(component, 'ratedPowerMw')
    const initialPowerFraction = parameterNumber(component, 'initialPowerFraction')
    if (localPath === 'powerMw') return ratedPowerMw * initialPowerFraction
    if (localPath === 'reactivityPcm') return 0
    if (localPath === 'rodInsertionFraction') return clamp(1 - initialPowerFraction, 0, 1)
  }
  if (component.kind === 'steamGenerator') {
    if (localPath === 'levelPercent') return parameterNumber(component, 'nominalLevelPercent') * 100
    if (localPath === 'pressureMPa') return parameterNumber(component, 'nominalPressureMPa')
    if (localPath === 'heatTransferMw') return 0
  }
  if (component.kind === 'centrifugalPump') {
    if (localPath === 'running') return true
    if (localPath === 'speedFraction') return 1
    if (localPath === 'flowKgPerS') return parameterNumber(component, 'nominalFlowKgPerS')
  }
  if (component.kind === 'feedwaterSource') {
    if (localPath === 'flowKgPerS') return parameterNumber(component, 'nominalFlowKgPerS')
  }
  if (component.kind === 'turbineLoadSink') {
    const initialLoadFraction = parameterNumber(component, 'initialLoadFraction')
    if (localPath === 'electricMw') return parameterNumber(component, 'nominalElectricMw') * initialLoadFraction
    if (localPath === 'loadFraction') return initialLoadFraction
  }
  throw new Error(`component ${component.id} has no runtime initializer for variable ${path}`)
}

export const updateControlLogic = (system: CompiledProcessPlantSystem, table: ProcessPlantVariableTable, dtSeconds: number): void => {
  for (const component of system.graph.components) {
    if (component.kind !== 'reactorCore') continue
    const rodPath = componentVariablePath(component, 'rodInsertionFraction')
    const reactivityPath = componentVariablePath(component, 'reactivityPcm')
    if (!hasComponentVariable(component, 'rodInsertionFraction') || !hasComponentVariable(component, 'reactivityPcm')) continue
    const rodInsertion = clamp(table.readNumber(rodPath), 0, 1)
    const targetReactivity = (0.5 - rodInsertion) * 1_200
    const reactivity = table.readNumber(reactivityPath)
    table.write(reactivityPath, approach(reactivity, targetReactivity, 500 * dtSeconds))
  }
}

export const solveElectrical = (system: CompiledProcessPlantSystem, table: ProcessPlantVariableTable, dtSeconds: number): void => {
  const averageSteamGeneratorPressure = averageFor(system.graph.components, component => {
    if (component.kind !== 'steamGenerator') return null
    return table.readNumber(componentVariablePath(component, 'pressureMPa')) / parameterNumber(component, 'nominalPressureMPa')
  })
  for (const component of system.graph.components) {
    if (component.kind !== 'turbineLoadSink') continue
    const load = clamp(table.readNumber(componentVariablePath(component, 'loadFraction')), 0, 1)
    const target = parameterNumber(component, 'nominalElectricMw') * load * clamp(averageSteamGeneratorPressure ?? 1, 0, 1.2)
    const current = table.readNumber(componentVariablePath(component, 'electricMw'))
    table.write(componentVariablePath(component, 'electricMw'), approach(current, target, parameterNumber(component, 'nominalElectricMw') * 0.2 * dtSeconds))
  }
}

export const solveFluidFlowComponents = (system: CompiledProcessPlantSystem, table: ProcessPlantVariableTable): void => {
  for (const component of system.graph.components) {
    if (component.kind !== 'centrifugalPump') continue
    const running = table.readBoolean(componentVariablePath(component, 'running'))
    const speed = clamp(table.readNumber(componentVariablePath(component, 'speedFraction')), 0, 1.2)
    table.write(componentVariablePath(component, 'flowKgPerS'), running ? parameterNumber(component, 'nominalFlowKgPerS') * speed : 0)
  }
}

export const solveThermalTransfer = (system: CompiledProcessPlantSystem, table: ProcessPlantVariableTable): void => {
  const corePower = averageFor(system.graph.components, component =>
    component.kind === 'reactorCore' ? table.readNumber(componentVariablePath(component, 'powerMw')) : null,
  ) ?? 0
  const primaryFlowFraction = averageFor(system.graph.components, component => {
    if (component.kind !== 'centrifugalPump') return null
    const nominal = parameterNumber(component, 'nominalFlowKgPerS')
    return nominal === 0 ? 0 : table.readNumber(componentVariablePath(component, 'flowKgPerS')) / nominal
  }) ?? 0
  for (const component of system.graph.components) {
    if (component.kind !== 'steamGenerator') continue
    const levelFraction = clamp(table.readNumber(componentVariablePath(component, 'levelPercent')) / 50, 0, 1)
    const heatTransfer = corePower * clamp(primaryFlowFraction, 0, 1.15) * levelFraction
    table.write(componentVariablePath(component, 'heatTransferMw'), heatTransfer)
  }
}

export const updateComponentState = (system: CompiledProcessPlantSystem, table: ProcessPlantVariableTable, dtSeconds: number): void => {
  const turbineLoadMw = averageFor(system.graph.components, component =>
    component.kind === 'turbineLoadSink' ? table.readNumber(componentVariablePath(component, 'electricMw')) : null,
  ) ?? 0
  const feedwaterFlow = averageFor(system.graph.components, component =>
    component.kind === 'feedwaterSource' ? table.readNumber(componentVariablePath(component, 'flowKgPerS')) : null,
  ) ?? 0
  for (const component of system.graph.components) {
    if (component.kind === 'reactorCore') {
      const ratedPower = parameterNumber(component, 'ratedPowerMw')
      const rodInsertion = clamp(table.readNumber(componentVariablePath(component, 'rodInsertionFraction')), 0, 1)
      const reactivity = table.readNumber(componentVariablePath(component, 'reactivityPcm'))
      const targetPower = ratedPower * clamp(1 - rodInsertion + reactivity / 10_000, 0, 1.15)
      const currentPower = table.readNumber(componentVariablePath(component, 'powerMw'))
      table.write(componentVariablePath(component, 'powerMw'), approach(currentPower, targetPower, ratedPower * 0.08 * dtSeconds))
    }
    if (component.kind === 'steamGenerator') {
      const pressurePath = componentVariablePath(component, 'pressureMPa')
      const levelPath = componentVariablePath(component, 'levelPercent')
      const heatTransfer = table.readNumber(componentVariablePath(component, 'heatTransferMw'))
      const nominalPressure = parameterNumber(component, 'nominalPressureMPa')
      const currentPressure = table.readNumber(pressurePath)
      const pressureTarget = nominalPressure + ((heatTransfer - turbineLoadMw * 2.9) / 3_400) * nominalPressure
      table.write(pressurePath, approach(currentPressure, clamp(pressureTarget, nominalPressure * 0.2, nominalPressure * 1.4), 0.08 * dtSeconds))
      const currentLevel = table.readNumber(levelPath)
      const steamDemandFlow = turbineLoadMw * 0.7
      const levelTarget = clamp(currentLevel + (feedwaterFlow - steamDemandFlow) * 0.0008, 0, 100)
      table.write(levelPath, approach(currentLevel, levelTarget, 0.4 * dtSeconds))
    }
  }
}
