import type { CompiledComponent, VariablePath } from '../graph/index.ts'
import type { CompiledProcessPlantSystem } from '../process-systems.ts'
import type { ProcessPlantSolverPhase, ProcessPlantValue } from './model.ts'
import {
  componentVariablePath,
  createBehaviorContext,
  processLinkVariablePath,
  type ComponentBehaviorDefinition,
} from './behavior-contract.ts'
import type { ProcessPlantVariableTable } from './variable-table.ts'

export const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value))

export const approach = (current: number, target: number, maxDelta: number): number => {
  if (Math.abs(target - current) <= maxDelta) return target
  return current + Math.sign(target - current) * maxDelta
}

export const relaxToward = (current: number, target: number, dtSeconds: number, timeConstantSeconds: number): number => {
  const fraction = clamp(dtSeconds / timeConstantSeconds, 0, 1)
  return current + (target - current) * fraction
}

const specificHeatWaterKjPerKgK = 4.2
const latentHeatSteamMjPerKg = 2.3

export const parameterNumber = (component: CompiledComponent, key: string): number => {
  const parameters = component.parameters
  if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) throw new Error(`component ${component.id} parameters are not an object`)
  const value = (parameters as Record<string, unknown>)[key]
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`component ${component.id} missing numeric parameter ${key}`)
  return value
}

const optionalParameterNumber = (component: CompiledComponent, key: string, defaultValue: number): number => {
  const parameters = component.parameters
  if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) throw new Error(`component ${component.id} parameters are not an object`)
  const value = (parameters as Record<string, unknown>)[key]
  if (value === undefined) return defaultValue
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`component ${component.id} parameter ${key} must be numeric`)
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

const averageIncomingLinkValue = (
  system: CompiledProcessPlantSystem,
  component: CompiledComponent,
  localPath: string,
  context: { readonly has: (path: VariablePath) => boolean; readonly readNumber: (path: VariablePath) => number },
  linkMatches: (link: CompiledProcessPlantSystem['graph']['links'][number]) => boolean = () => true,
): number | null => {
  let total = 0
  let count = 0
  for (const link of system.graph.links) {
    if (link.toComponentIndex !== component.index) continue
    if (!linkMatches(link)) continue
    const path = processLinkVariablePath(link, localPath)
    if (!context.has(path)) continue
    total += context.readNumber(path)
    count += 1
  }
  return count === 0 ? null : total / count
}

const averageOutgoingLinkValue = (
  system: CompiledProcessPlantSystem,
  component: CompiledComponent,
  localPath: string,
  context: { readonly has: (path: VariablePath) => boolean; readonly readNumber: (path: VariablePath) => number },
  linkMatches: (link: CompiledProcessPlantSystem['graph']['links'][number]) => boolean = () => true,
): number | null => {
  let total = 0
  let count = 0
  for (const link of system.graph.links) {
    if (link.fromComponentIndex !== component.index) continue
    if (!linkMatches(link)) continue
    const path = processLinkVariablePath(link, localPath)
    if (!context.has(path)) continue
    total += context.readNumber(path)
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
    if (localPath === 'coolantInletTemperatureC') return optionalParameterNumber(component, 'initialCoolantInletTemperatureC', 290)
    if (localPath === 'coolantOutletTemperatureC') return optionalParameterNumber(component, 'initialCoolantInletTemperatureC', 290) + 32
    if (localPath === 'heatToCoolantMw') return ratedPowerMw * initialPowerFraction
  }
  if (component.kind === 'steamGenerator') {
    if (localPath === 'levelPercent') return parameterNumber(component, 'nominalLevelPercent') * 100
    if (localPath === 'pressureMPa') return parameterNumber(component, 'nominalPressureMPa')
    if (localPath === 'heatTransferMw') return 0
    if (localPath === 'primaryInletTemperatureC') return optionalParameterNumber(component, 'initialPrimaryInletTemperatureC', 322)
    if (localPath === 'primaryOutletTemperatureC') return optionalParameterNumber(component, 'initialPrimaryInletTemperatureC', 322) - 32
    if (localPath === 'secondaryTemperatureC') return optionalParameterNumber(component, 'initialSecondaryTemperatureC', 285)
    if (localPath === 'steamFlowKgPerS') return 0
    if (localPath === 'secondaryInventoryKg') return optionalParameterNumber(component, 'nominalSecondaryInventoryKg', 56_000) * parameterNumber(component, 'nominalLevelPercent')
  }
  if (component.kind === 'centrifugalPump') {
    if (localPath === 'running') return true
    if (localPath === 'speedFraction') return 1
    if (localPath === 'flowKgPerS') return parameterNumber(component, 'nominalFlowKgPerS')
  }
  if (component.kind === 'feedwaterSource') {
    if (localPath === 'flowKgPerS') return parameterNumber(component, 'nominalFlowKgPerS')
    if (localPath === 'temperatureC') return parameterNumber(component, 'temperatureC')
  }
  if (component.kind === 'turbineLoadSink') {
    const initialLoadFraction = parameterNumber(component, 'initialLoadFraction')
    if (localPath === 'electricMw') return parameterNumber(component, 'nominalElectricMw') * initialLoadFraction
    if (localPath === 'loadFraction') return initialLoadFraction
    if (localPath === 'steamFlowKgPerS') return parameterNumber(component, 'nominalSteamFlowKgPerS') * initialLoadFraction
  }
  if (component.kind === 'condenserSink') {
    if (localPath === 'steamFlowKgPerS') return 0
    if (localPath === 'condensateTemperatureC') return parameterNumber(component, 'coolingWaterTemperatureC') + parameterNumber(component, 'condensateApproachTemperatureK')
    if (localPath === 'backPressurePa') return 8_000
  }
  throw new Error(`component ${component.id} has no runtime initializer for variable ${path}`)
}

export const componentBehaviorDefinitions: ReadonlyArray<ComponentBehaviorDefinition> = [
  {
    id: 'reactor-core-reactivity-control',
    phase: 'updateControlLogic',
    componentKind: 'reactorCore',
    reads: ['rodInsertionFraction', 'reactivityPcm'],
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
    reads: ['loadFraction', 'steamFlowKgPerS', 'incoming:flowKgPerS', 'incoming:pressureMPa'],
    writes: ['electricMw', 'steamFlowKgPerS'],
    update: ({ system, component, context }): void => {
      const inletSteamFlow = averageIncomingLinkValue(system, component, 'flowKgPerS', context) ?? 0
      const averageSteamPressure = averageIncomingLinkValue(system, component, 'pressureMPa', context)
      const nominalSteamFlow = parameterNumber(component, 'nominalSteamFlowKgPerS')
      const load = clamp(context.readNumber(componentVariablePath(component, 'loadFraction')), 0, 1)
      const steamAvailability = clamp(inletSteamFlow / nominalSteamFlow, 0, 1.2)
      const pressureAvailability = clamp((averageSteamPressure ?? 6.9) / 6.9, 0, 1.2)
      const target = parameterNumber(component, 'nominalElectricMw') * load * Math.min(steamAvailability, pressureAvailability)
      const current = context.readNumber(componentVariablePath(component, 'electricMw'))
      context.write(componentVariablePath(component, 'steamFlowKgPerS'), inletSteamFlow)
      context.write(
        componentVariablePath(component, 'electricMw'),
        relaxToward(current, target, context.dtSeconds, optionalParameterNumber(component, 'electricalTimeConstantS', 5)),
      )
    },
  },
  {
    id: 'centrifugal-pump-flow',
    phase: 'solveFluidFlowComponents',
    componentKind: 'centrifugalPump',
    reads: ['running', 'speedFraction'],
    writes: ['flowKgPerS'],
    update: ({ component, context }): void => {
      const running = context.readBoolean(componentVariablePath(component, 'running'))
      const speed = clamp(context.readNumber(componentVariablePath(component, 'speedFraction')), 0, 1.2)
      context.write(componentVariablePath(component, 'flowKgPerS'), running ? parameterNumber(component, 'nominalFlowKgPerS') * speed : 0)
    },
  },
  {
    id: 'reactor-core-heat-to-coolant',
    phase: 'solveThermalTransfer',
    componentKind: 'reactorCore',
    reads: ['powerMw'],
    writes: ['heatToCoolantMw'],
    update: ({ component, context }): void => {
      context.write(componentVariablePath(component, 'heatToCoolantMw'), context.readNumber(componentVariablePath(component, 'powerMw')))
    },
  },
  {
    id: 'steam-generator-heat-transfer',
    phase: 'solveThermalTransfer',
    componentKind: 'steamGenerator',
    reads: ['secondaryTemperatureC', 'levelPercent', 'incoming:primaryCoolant.temperatureC', 'incoming:primaryCoolant.flowKgPerS'],
    writes: ['heatTransferMw', 'steamFlowKgPerS'],
    update: ({ system, component, context }): void => {
      const primaryWaterTemperature = averageIncomingLinkValue(system, component, 'temperatureC', context, link => link.service === 'primaryCoolant')
        ?? context.readNumber(componentVariablePath(component, 'primaryInletTemperatureC'))
      const primaryWaterFlow = averageIncomingLinkValue(system, component, 'flowKgPerS', context, link => link.service === 'primaryCoolant') ?? 0
      const secondaryTemperature = context.readNumber(componentVariablePath(component, 'secondaryTemperatureC'))
      const levelFraction = clamp(context.readNumber(componentVariablePath(component, 'levelPercent')) / 50, 0, 1)
      const transferCapacity = parameterNumber(component, 'heatTransferCoefficientMwPerK') * Math.max(0, primaryWaterTemperature - secondaryTemperature)
      const flowCapacity = primaryWaterFlow * specificHeatWaterKjPerKgK * Math.max(0, primaryWaterTemperature - secondaryTemperature) / 1_000
      const heatTransfer = Math.max(0, Math.min(transferCapacity, flowCapacity) * levelFraction)
      context.write(componentVariablePath(component, 'heatTransferMw'), heatTransfer)
      context.write(componentVariablePath(component, 'steamFlowKgPerS'), heatTransfer / latentHeatSteamMjPerKg)
    },
  },
  {
    id: 'reactor-core-power-state',
    phase: 'updateComponentState',
    componentKind: 'reactorCore',
    reads: ['rodInsertionFraction', 'reactivityPcm', 'powerMw'],
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
    id: 'reactor-core-coolant-temperature-state',
    phase: 'updateComponentState',
    componentKind: 'reactorCore',
    reads: ['coolantInletTemperatureC', 'coolantOutletTemperatureC', 'heatToCoolantMw', 'incoming:temperatureC', 'incoming:flowKgPerS'],
    writes: ['coolantInletTemperatureC', 'coolantOutletTemperatureC'],
    update: ({ system, component, context }): void => {
      const inletTemperature = averageIncomingLinkValue(system, component, 'temperatureC', context)
        ?? context.readNumber(componentVariablePath(component, 'coolantInletTemperatureC'))
      const flow = Math.max(1, averageIncomingLinkValue(system, component, 'flowKgPerS', context) ?? 1)
      const heatToCoolant = context.readNumber(componentVariablePath(component, 'heatToCoolantMw'))
      const outletTarget = clamp(inletTemperature + (heatToCoolant * 1_000) / (flow * specificHeatWaterKjPerKgK), 220, 360)
      const currentOutlet = context.readNumber(componentVariablePath(component, 'coolantOutletTemperatureC'))
      const timeConstantSeconds = optionalParameterNumber(component, 'coolantThermalTimeConstantS', 8)
      context.write(componentVariablePath(component, 'coolantInletTemperatureC'), relaxToward(context.readNumber(componentVariablePath(component, 'coolantInletTemperatureC')), inletTemperature, context.dtSeconds, timeConstantSeconds))
      context.write(componentVariablePath(component, 'coolantOutletTemperatureC'), relaxToward(currentOutlet, outletTarget, context.dtSeconds, timeConstantSeconds))
    },
  },
  {
    id: 'steam-generator-inventory-pressure-state',
    phase: 'updateComponentState',
    componentKind: 'steamGenerator',
    reads: [
      'pressureMPa',
      'levelPercent',
      'heatTransferMw',
      'steamFlowKgPerS',
      'primaryInletTemperatureC',
      'primaryOutletTemperatureC',
      'secondaryTemperatureC',
      'incoming:primaryCoolant.temperatureC',
      'incoming:primaryCoolant.flowKgPerS',
    ],
    writes: ['pressureMPa', 'levelPercent', 'primaryInletTemperatureC', 'primaryOutletTemperatureC', 'secondaryTemperatureC', 'secondaryInventoryKg'],
    update: ({ system, component, context }): void => {
      const feedwaterFlow = (averageIncomingLinkValue(system, component, 'flowKgPerS', context, link => link.service === 'feedwater') ?? 0)
        + (averageIncomingLinkValue(system, component, 'flowKgPerS', context, link => link.service === 'auxFeedwater') ?? 0)
      const turbineSteamFlow = averageOutgoingLinkValue(system, component, 'flowKgPerS', context, link => link.service === 'mainSteam') ?? 0
      const pressurePath = componentVariablePath(component, 'pressureMPa')
      const levelPath = componentVariablePath(component, 'levelPercent')
      const heatTransfer = context.readNumber(componentVariablePath(component, 'heatTransferMw'))
      const nominalPressure = parameterNumber(component, 'nominalPressureMPa')
      const primaryInletTemperature = averageIncomingLinkValue(system, component, 'temperatureC', context, link => link.service === 'primaryCoolant')
        ?? context.readNumber(componentVariablePath(component, 'primaryInletTemperatureC'))
      const primaryFlow = Math.max(1, averageIncomingLinkValue(system, component, 'flowKgPerS', context, link => link.service === 'primaryCoolant') ?? 1)
      const primaryOutletTarget = clamp(primaryInletTemperature - (heatTransfer * 1_000) / (primaryFlow * specificHeatWaterKjPerKgK), 180, primaryInletTemperature)
      const primaryTimeConstantSeconds = optionalParameterNumber(component, 'primaryThermalTimeConstantS', 10)
      context.write(componentVariablePath(component, 'primaryInletTemperatureC'), relaxToward(context.readNumber(componentVariablePath(component, 'primaryInletTemperatureC')), primaryInletTemperature, context.dtSeconds, primaryTimeConstantSeconds))
      context.write(componentVariablePath(component, 'primaryOutletTemperatureC'), relaxToward(context.readNumber(componentVariablePath(component, 'primaryOutletTemperatureC')), primaryOutletTarget, context.dtSeconds, primaryTimeConstantSeconds))
      const secondaryTemperatureTarget = clamp(280 + (context.readNumber(pressurePath) - nominalPressure) * 7, 180, 330)
      context.write(componentVariablePath(component, 'secondaryTemperatureC'), relaxToward(context.readNumber(componentVariablePath(component, 'secondaryTemperatureC')), secondaryTemperatureTarget, context.dtSeconds, optionalParameterNumber(component, 'secondaryThermalTimeConstantS', 25)))
      const currentPressure = context.readNumber(pressurePath)
      const generatedSteamFlow = context.readNumber(componentVariablePath(component, 'steamFlowKgPerS'))
      const pressureTarget = nominalPressure + ((generatedSteamFlow - turbineSteamFlow) / 1_000) * nominalPressure
      context.write(pressurePath, approach(currentPressure, clamp(pressureTarget, nominalPressure * 0.2, nominalPressure * 1.4), 0.08 * context.dtSeconds))
      const currentLevel = context.readNumber(levelPath)
      const levelTarget = clamp(currentLevel + (feedwaterFlow - turbineSteamFlow) * 0.0008, 0, 100)
      context.write(levelPath, relaxToward(currentLevel, levelTarget, context.dtSeconds, optionalParameterNumber(component, 'inventoryTimeConstantS', 20)))
      const nominalInventory = optionalParameterNumber(component, 'nominalSecondaryInventoryKg', 56_000)
      context.write(componentVariablePath(component, 'secondaryInventoryKg'), nominalInventory * context.readNumber(levelPath) / 100)
    },
  },
  {
    id: 'condenser-steam-sink-state',
    phase: 'updateComponentState',
    componentKind: 'condenserSink',
    reads: ['steamFlowKgPerS', 'condensateTemperatureC', 'backPressurePa', 'incoming:flowKgPerS'],
    writes: ['steamFlowKgPerS', 'condensateTemperatureC', 'backPressurePa'],
    update: ({ system, component, context }): void => {
      const steamFlow = averageIncomingLinkValue(system, component, 'flowKgPerS', context) ?? 0
      const nominalSteamFlow = parameterNumber(component, 'nominalSteamFlowKgPerS')
      const targetCondensateTemperature = parameterNumber(component, 'coolingWaterTemperatureC')
        + parameterNumber(component, 'condensateApproachTemperatureK')
        + clamp(steamFlow / nominalSteamFlow, 0, 1.5) * 18
      const targetBackPressure = 7_000 + clamp(steamFlow / nominalSteamFlow, 0, 1.5) * 5_000
      context.write(componentVariablePath(component, 'steamFlowKgPerS'), steamFlow)
      context.write(componentVariablePath(component, 'condensateTemperatureC'), relaxToward(context.readNumber(componentVariablePath(component, 'condensateTemperatureC')), targetCondensateTemperature, context.dtSeconds, optionalParameterNumber(component, 'condenserThermalTimeConstantS', 12)))
      context.write(componentVariablePath(component, 'backPressurePa'), approach(context.readNumber(componentVariablePath(component, 'backPressurePa')), targetBackPressure, 500 * context.dtSeconds))
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
