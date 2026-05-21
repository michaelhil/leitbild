import type { CompiledProcessPlantSystem } from '../process-systems.ts'
import type { CompiledComponent, CompiledEdge, CompiledVariable, VariablePath } from '../graph/index.ts'
import { processPlantSolverPhases, type ProcessPlantCommand, type ProcessPlantRuntime, type ProcessPlantRuntimeSnapshot, type ProcessPlantTickResult, type ProcessPlantValue, type ProcessPlantVariableSnapshot } from './model.ts'
import { toCanonicalProcessValue } from './units.ts'

interface RuntimeState {
  readonly values: Map<VariablePath, ProcessPlantValue>
  readonly variableByPath: Map<VariablePath, CompiledVariable>
  readonly commands: ProcessPlantCommand[]
  elapsedMs: number
  remainderMs: number
}

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value))

const approach = (current: number, target: number, maxDelta: number): number => {
  if (Math.abs(target - current) <= maxDelta) return target
  return current + Math.sign(target - current) * maxDelta
}

const parameterNumber = (component: CompiledComponent, key: string): number => {
  const parameters = component.parameters
  if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) throw new Error(`component ${component.id} parameters are not an object`)
  const value = (parameters as Record<string, unknown>)[key]
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`component ${component.id} missing numeric parameter ${key}`)
  return value
}

const variablePath = (component: CompiledComponent, localPath: string): VariablePath =>
  `${component.id}.${localPath}` as VariablePath

const edgeVariablePath = (edge: CompiledEdge, localPath: string): VariablePath =>
  `${edge.id}.${localPath}` as VariablePath

const hasVariable = (component: CompiledComponent, localPath: string): boolean =>
  component.variables.some(variable => variable.path === variablePath(component, localPath))

const hasEdgeVariable = (edge: CompiledEdge, localPath: string): boolean =>
  edge.variables.some(variable => variable.path === edgeVariablePath(edge, localPath))

const readNumber = (state: RuntimeState, path: VariablePath): number => {
  const value = state.values.get(path)
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`variable ${path} is not numeric`)
  return value
}

const readBoolean = (state: RuntimeState, path: VariablePath): boolean => {
  const value = state.values.get(path)
  if (typeof value !== 'boolean') throw new Error(`variable ${path} is not boolean`)
  return value
}

const writeValue = (state: RuntimeState, path: VariablePath, value: ProcessPlantValue): void => {
  if (!state.variableByPath.has(path)) throw new Error(`unknown process plant variable: ${path}`)
  state.values.set(path, value)
}

const readOptionalNumber = (state: RuntimeState, path: VariablePath, defaultValue: number): number => {
  if (!state.variableByPath.has(path)) return defaultValue
  return readNumber(state, path)
}

const initialValueFor = (component: CompiledComponent, path: VariablePath): ProcessPlantValue => {
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

const createInitialState = (system: CompiledProcessPlantSystem): RuntimeState => {
  const variableByPath = new Map(system.graph.variables.map(variable => [variable.path, variable]))
  const values = new Map<VariablePath, ProcessPlantValue>()
  for (const variable of system.graph.variables) {
    if (variable.owner.type === 'component') {
      const component = system.graph.components[variable.owner.componentIndex]
      if (!component) throw new Error(`variable ${variable.path} references missing component index ${variable.owner.componentIndex}`)
      values.set(variable.path, initialValueFor(component, variable.path))
      continue
    }
    if (variable.initialValue === undefined) throw new Error(`connection variable ${variable.path} has no initial value`)
    values.set(variable.path, variable.initialValue)
  }
  return {
    values,
    variableByPath,
    commands: [],
    elapsedMs: 0,
    remainderMs: 0,
  }
}

const snapshotVariable = (state: RuntimeState, variable: CompiledVariable): ProcessPlantVariableSnapshot => {
  const value = state.values.get(variable.path)
  if (value === undefined) throw new Error(`variable ${variable.path} has no runtime value`)
  return {
    path: variable.path,
    value,
    canonicalValue: toCanonicalProcessValue(value, variable.descriptor.unit),
    quantity: variable.descriptor.quantity,
    unit: variable.descriptor.unit,
    kind: variable.descriptor.kind,
    writable: variable.descriptor.writable,
    published: variable.published,
  }
}

const applyCommands = (state: RuntimeState): void => {
  for (const command of state.commands.splice(0)) {
    writeValue(state, command.path, command.value)
  }
}

const updateControlLogic = (system: CompiledProcessPlantSystem, state: RuntimeState, dtSeconds: number): void => {
  for (const component of system.graph.components) {
    if (component.kind !== 'reactorCore') continue
    const rodPath = variablePath(component, 'rodInsertionFraction')
    const reactivityPath = variablePath(component, 'reactivityPcm')
    if (!hasVariable(component, 'rodInsertionFraction') || !hasVariable(component, 'reactivityPcm')) continue
    const rodInsertion = clamp(readNumber(state, rodPath), 0, 1)
    const targetReactivity = (0.5 - rodInsertion) * 1_200
    const reactivity = readNumber(state, reactivityPath)
    writeValue(state, reactivityPath, approach(reactivity, targetReactivity, 500 * dtSeconds))
  }
}

const solveElectrical = (system: CompiledProcessPlantSystem, state: RuntimeState, dtSeconds: number): void => {
  const averageSteamGeneratorPressure = averageFor(system.graph.components, component => {
    if (component.kind !== 'steamGenerator') return null
    return readNumber(state, variablePath(component, 'pressureMPa')) / parameterNumber(component, 'nominalPressureMPa')
  })
  for (const component of system.graph.components) {
    if (component.kind !== 'turbineLoadSink') continue
    const load = clamp(readNumber(state, variablePath(component, 'loadFraction')), 0, 1)
    const target = parameterNumber(component, 'nominalElectricMw') * load * clamp(averageSteamGeneratorPressure ?? 1, 0, 1.2)
    const current = readNumber(state, variablePath(component, 'electricMw'))
    writeValue(state, variablePath(component, 'electricMw'), approach(current, target, parameterNumber(component, 'nominalElectricMw') * 0.2 * dtSeconds))
  }
}

const solveFluidFlow = (system: CompiledProcessPlantSystem, state: RuntimeState): void => {
  for (const component of system.graph.components) {
    if (component.kind !== 'centrifugalPump') continue
    const running = readBoolean(state, variablePath(component, 'running'))
    const speed = clamp(readNumber(state, variablePath(component, 'speedFraction')), 0, 1.2)
    writeValue(state, variablePath(component, 'flowKgPerS'), running ? parameterNumber(component, 'nominalFlowKgPerS') * speed : 0)
  }
  const primaryFlow = averageFor(system.graph.components, component =>
    component.kind === 'centrifugalPump' ? readNumber(state, variablePath(component, 'flowKgPerS')) : null,
  ) ?? 0
  const feedwaterFlow = averageFor(system.graph.components, component =>
    component.kind === 'feedwaterSource' ? readNumber(state, variablePath(component, 'flowKgPerS')) : null,
  ) ?? 0
  const turbineSteamDemand = averageFor(system.graph.components, component =>
    component.kind === 'turbineLoadSink' ? readNumber(state, variablePath(component, 'electricMw')) * 0.7 : null,
  ) ?? 0
  for (const edge of system.graph.edges) {
    if (!hasEdgeVariable(edge, 'flowKgPerS')) continue
    const valveFactor = clamp(readOptionalNumber(state, edgeVariablePath(edge, 'valve.positionFraction'), 1), 0, 1)
    const leakFraction = clamp(readOptionalNumber(state, edgeVariablePath(edge, 'leak.areaFraction'), 0), 0, 1)
    const flowSource = edge.kind === 'steamFlow'
      ? turbineSteamDemand
      : edge.medium === 'feedwater'
        ? feedwaterFlow
        : primaryFlow
    writeValue(state, edgeVariablePath(edge, 'flowKgPerS'), flowSource * valveFactor * (1 - leakFraction))
  }
}

const solveThermalTransfer = (system: CompiledProcessPlantSystem, state: RuntimeState): void => {
  const corePower = averageFor(system.graph.components, component =>
    component.kind === 'reactorCore' ? readNumber(state, variablePath(component, 'powerMw')) : null,
  ) ?? 0
  const primaryFlowFraction = averageFor(system.graph.components, component => {
    if (component.kind !== 'centrifugalPump') return null
    const nominal = parameterNumber(component, 'nominalFlowKgPerS')
    return nominal === 0 ? 0 : readNumber(state, variablePath(component, 'flowKgPerS')) / nominal
  }) ?? 0
  for (const component of system.graph.components) {
    if (component.kind !== 'steamGenerator') continue
    const levelFraction = clamp(readNumber(state, variablePath(component, 'levelPercent')) / 50, 0, 1)
    const heatTransfer = corePower * clamp(primaryFlowFraction, 0, 1.15) * levelFraction
    writeValue(state, variablePath(component, 'heatTransferMw'), heatTransfer)
  }
}

const updateComponentState = (system: CompiledProcessPlantSystem, state: RuntimeState, dtSeconds: number): void => {
  const turbineLoadMw = averageFor(system.graph.components, component =>
    component.kind === 'turbineLoadSink' ? readNumber(state, variablePath(component, 'electricMw')) : null,
  ) ?? 0
  const feedwaterFlow = averageFor(system.graph.components, component =>
    component.kind === 'feedwaterSource' ? readNumber(state, variablePath(component, 'flowKgPerS')) : null,
  ) ?? 0
  for (const component of system.graph.components) {
    if (component.kind === 'reactorCore') {
      const ratedPower = parameterNumber(component, 'ratedPowerMw')
      const rodInsertion = clamp(readNumber(state, variablePath(component, 'rodInsertionFraction')), 0, 1)
      const reactivity = readNumber(state, variablePath(component, 'reactivityPcm'))
      const targetPower = ratedPower * clamp(1 - rodInsertion + reactivity / 10_000, 0, 1.15)
      const currentPower = readNumber(state, variablePath(component, 'powerMw'))
      writeValue(state, variablePath(component, 'powerMw'), approach(currentPower, targetPower, ratedPower * 0.08 * dtSeconds))
    }
    if (component.kind === 'steamGenerator') {
      const pressurePath = variablePath(component, 'pressureMPa')
      const levelPath = variablePath(component, 'levelPercent')
      const heatTransfer = readNumber(state, variablePath(component, 'heatTransferMw'))
      const nominalPressure = parameterNumber(component, 'nominalPressureMPa')
      const currentPressure = readNumber(state, pressurePath)
      const pressureTarget = nominalPressure + ((heatTransfer - turbineLoadMw * 2.9) / 3_400) * nominalPressure
      writeValue(state, pressurePath, approach(currentPressure, clamp(pressureTarget, nominalPressure * 0.2, nominalPressure * 1.4), 0.08 * dtSeconds))
      const currentLevel = readNumber(state, levelPath)
      const steamDemandFlow = turbineLoadMw * 0.7
      const levelTarget = clamp(currentLevel + (feedwaterFlow - steamDemandFlow) * 0.0008, 0, 100)
      writeValue(state, levelPath, approach(currentLevel, levelTarget, 0.4 * dtSeconds))
    }
  }
  const steamPressure = averageFor(system.graph.components, component =>
    component.kind === 'steamGenerator' ? readNumber(state, variablePath(component, 'pressureMPa')) : null,
  )
  for (const edge of system.graph.edges) {
    if (steamPressure !== null && hasEdgeVariable(edge, 'pressureMPa')) {
      writeValue(state, edgeVariablePath(edge, 'pressureMPa'), steamPressure)
    }
    if (hasEdgeVariable(edge, 'radiationMSvPerH')) {
      const leakFraction = clamp(readOptionalNumber(state, edgeVariablePath(edge, 'leak.areaFraction'), 0), 0, 1)
      const currentRadiation = readNumber(state, edgeVariablePath(edge, 'radiationMSvPerH'))
      writeValue(state, edgeVariablePath(edge, 'radiationMSvPerH'), approach(currentRadiation, 0.02 + leakFraction * 25, 2 * dtSeconds))
    }
  }
}

const averageFor = (
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

const step = (system: CompiledProcessPlantSystem, state: RuntimeState, stepMs: number): void => {
  const dtSeconds = stepMs / 1_000
  applyCommands(state)
  updateControlLogic(system, state, dtSeconds)
  solveElectrical(system, state, dtSeconds)
  solveFluidFlow(system, state)
  solveThermalTransfer(system, state)
  updateComponentState(system, state, dtSeconds)
  state.elapsedMs += stepMs
}

export const createProcessPlantRuntime = (system: CompiledProcessPlantSystem): ProcessPlantRuntime => {
  const state = createInitialState(system)
  const fixedStepMs = system.graph.timestep.fixedStepMs
  const variables = system.graph.variables

  const snapshot = (): ProcessPlantRuntimeSnapshot => ({
    elapsedMs: state.elapsedMs,
    variables: variables.map(variable => snapshotVariable(state, variable)),
  })

  return {
    tick: (elapsedMs: number): ProcessPlantTickResult => {
      if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) throw new Error(`process plant tick elapsedMs must be positive, got ${elapsedMs}`)
      state.remainderMs += elapsedMs
      let simulatedMs = 0
      while (state.remainderMs >= fixedStepMs) {
        step(system, state, fixedStepMs)
        state.remainderMs -= fixedStepMs
        simulatedMs += fixedStepMs
      }
      return {
        elapsedMs,
        simulatedMs,
        phases: processPlantSolverPhases,
        publishedVariables: variables.filter(variable => variable.published).map(variable => snapshotVariable(state, variable)),
      }
    },
    readVariable: (path: VariablePath): ProcessPlantValue => {
      if (!state.variableByPath.has(path)) throw new Error(`unknown process plant variable: ${path}`)
      const value = state.values.get(path)
      if (value === undefined) throw new Error(`variable ${path} has no runtime value`)
      return value
    },
    writeCommand: (command: ProcessPlantCommand): void => {
      const variable = state.variableByPath.get(command.path)
      if (!variable) throw new Error(`unknown process plant variable: ${command.path}`)
      if (!variable.descriptor.writable) throw new Error(`process plant variable is not writable: ${command.path}`)
      const current = state.values.get(command.path)
      if (typeof current !== typeof command.value) throw new Error(`process plant variable ${command.path} expects ${typeof current} value`)
      state.commands.push(command)
    },
    snapshot,
  }
}
