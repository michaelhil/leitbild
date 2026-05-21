import type { CompiledComponent, VariablePath } from '../graph/index.ts'
import type { CompiledProcessPlantSystem } from '../process-systems.ts'
import type { ProcessPlantSolverPhase, ProcessPlantValue } from './model.ts'
import {
  componentVariablePath,
  createBehaviorContext,
  type ComponentBehaviorDefinition,
} from './behavior-contract.ts'
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

export const componentBehaviorDefinitions: ReadonlyArray<ComponentBehaviorDefinition> = [
  {
    id: 'reactor-core-reactivity-control',
    phase: 'updateControlLogic',
    componentKind: 'reactorCore',
    writes: ['reactivityPcm'],
    update: ({ component, context }): void => {
      if (!hasComponentVariable(component, 'rodInsertionFraction') || !hasComponentVariable(component, 'reactivityPcm')) return
      const rodInsertion = clamp(context.readNumber(componentVariablePath(component, 'rodInsertionFraction')), 0, 1)
      const targetReactivity = (0.5 - rodInsertion) * 1_200
      const reactivity = context.readNumber(componentVariablePath(component, 'reactivityPcm'))
      context.write(componentVariablePath(component, 'reactivityPcm'), approach(reactivity, targetReactivity, 500 * context.dtSeconds))
    },
  },
  {
    id: 'turbine-electrical-output',
    phase: 'solveElectrical',
    componentKind: 'turbineLoadSink',
    writes: ['electricMw'],
    update: ({ system, component, context }): void => {
      const averageSteamGeneratorPressure = averageFor(system.graph.components, candidate => {
        if (candidate.kind !== 'steamGenerator') return null
        return context.readNumber(componentVariablePath(candidate, 'pressureMPa')) / parameterNumber(candidate, 'nominalPressureMPa')
      })
      const load = clamp(context.readNumber(componentVariablePath(component, 'loadFraction')), 0, 1)
      const target = parameterNumber(component, 'nominalElectricMw') * load * clamp(averageSteamGeneratorPressure ?? 1, 0, 1.2)
      const current = context.readNumber(componentVariablePath(component, 'electricMw'))
      context.write(
        componentVariablePath(component, 'electricMw'),
        approach(current, target, parameterNumber(component, 'nominalElectricMw') * 0.2 * context.dtSeconds),
      )
    },
  },
  {
    id: 'centrifugal-pump-flow',
    phase: 'solveFluidFlowComponents',
    componentKind: 'centrifugalPump',
    writes: ['flowKgPerS'],
    update: ({ component, context }): void => {
      const running = context.readBoolean(componentVariablePath(component, 'running'))
      const speed = clamp(context.readNumber(componentVariablePath(component, 'speedFraction')), 0, 1.2)
      context.write(componentVariablePath(component, 'flowKgPerS'), running ? parameterNumber(component, 'nominalFlowKgPerS') * speed : 0)
    },
  },
  {
    id: 'steam-generator-heat-transfer',
    phase: 'solveThermalTransfer',
    componentKind: 'steamGenerator',
    writes: ['heatTransferMw'],
    update: ({ system, component, context }): void => {
      const corePower = averageFor(system.graph.components, candidate =>
        candidate.kind === 'reactorCore' ? context.readNumber(componentVariablePath(candidate, 'powerMw')) : null,
      ) ?? 0
      const primaryFlowFraction = averageFor(system.graph.components, candidate => {
        if (candidate.kind !== 'centrifugalPump') return null
        const nominal = parameterNumber(candidate, 'nominalFlowKgPerS')
        return nominal === 0 ? 0 : context.readNumber(componentVariablePath(candidate, 'flowKgPerS')) / nominal
      }) ?? 0
      const levelFraction = clamp(context.readNumber(componentVariablePath(component, 'levelPercent')) / 50, 0, 1)
      const heatTransfer = corePower * clamp(primaryFlowFraction, 0, 1.15) * levelFraction
      context.write(componentVariablePath(component, 'heatTransferMw'), heatTransfer)
    },
  },
  {
    id: 'reactor-core-power-state',
    phase: 'updateComponentState',
    componentKind: 'reactorCore',
    writes: ['powerMw'],
    update: ({ component, context }): void => {
      const ratedPower = parameterNumber(component, 'ratedPowerMw')
      const rodInsertion = clamp(context.readNumber(componentVariablePath(component, 'rodInsertionFraction')), 0, 1)
      const reactivity = context.readNumber(componentVariablePath(component, 'reactivityPcm'))
      const targetPower = ratedPower * clamp(1 - rodInsertion + reactivity / 10_000, 0, 1.15)
      const currentPower = context.readNumber(componentVariablePath(component, 'powerMw'))
      context.write(componentVariablePath(component, 'powerMw'), approach(currentPower, targetPower, ratedPower * 0.08 * context.dtSeconds))
    },
  },
  {
    id: 'steam-generator-inventory-pressure-state',
    phase: 'updateComponentState',
    componentKind: 'steamGenerator',
    writes: ['pressureMPa', 'levelPercent'],
    update: ({ system, component, context }): void => {
      const turbineLoadMw = averageFor(system.graph.components, candidate =>
        candidate.kind === 'turbineLoadSink' ? context.readNumber(componentVariablePath(candidate, 'electricMw')) : null,
      ) ?? 0
      const feedwaterFlow = averageFor(system.graph.components, candidate =>
        candidate.kind === 'feedwaterSource' ? context.readNumber(componentVariablePath(candidate, 'flowKgPerS')) : null,
      ) ?? 0
      const pressurePath = componentVariablePath(component, 'pressureMPa')
      const levelPath = componentVariablePath(component, 'levelPercent')
      const heatTransfer = context.readNumber(componentVariablePath(component, 'heatTransferMw'))
      const nominalPressure = parameterNumber(component, 'nominalPressureMPa')
      const currentPressure = context.readNumber(pressurePath)
      const pressureTarget = nominalPressure + ((heatTransfer - turbineLoadMw * 2.9) / 3_400) * nominalPressure
      context.write(pressurePath, approach(currentPressure, clamp(pressureTarget, nominalPressure * 0.2, nominalPressure * 1.4), 0.08 * context.dtSeconds))
      const currentLevel = context.readNumber(levelPath)
      const steamDemandFlow = turbineLoadMw * 0.7
      const levelTarget = clamp(currentLevel + (feedwaterFlow - steamDemandFlow) * 0.0008, 0, 100)
      context.write(levelPath, approach(currentLevel, levelTarget, 0.4 * context.dtSeconds))
    },
  },
]

export const runComponentBehaviors = (
  system: CompiledProcessPlantSystem,
  table: ProcessPlantVariableTable,
  phase: ProcessPlantSolverPhase,
  dtSeconds: number,
): void => {
  for (const behavior of componentBehaviorDefinitions) {
    if (behavior.phase !== phase) continue
    for (const component of system.graph.components) {
      if (String(component.kind) !== behavior.componentKind) continue
      const writablePaths = new Set(behavior.writes.map(localPath => componentVariablePath(component, localPath)))
      behavior.update({
        system,
        component,
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
