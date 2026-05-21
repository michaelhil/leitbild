import type { CompiledComponent, VariablePath } from '../graph/index.ts'
import type { CompiledProcessPlantSystem } from '../process-systems.ts'
import type { ProcessPlantSolverPhase, ProcessPlantValue } from './model.ts'
import {
  componentVariablePath,
  createBehaviorContext,
  processLinkVariablePath,
  type ComponentBehaviorDefinition,
} from './behavior-contract.ts'
import {
  energyBalanceTemperatureStep,
  heatMwFromWaterFlowAndDeltaT,
  saturationTemperatureCFromPressureMPa,
  steamFlowKgPerSFromHeatMw,
  waterDeltaTFromHeatMw,
} from './thermophysics.ts'
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
  for (const linkIndex of system.graph.incomingLinksByComponent[component.index] ?? []) {
    const link = system.graph.links[linkIndex]
    if (!link) continue
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
  for (const linkIndex of system.graph.outgoingLinksByComponent[component.index] ?? []) {
    const link = system.graph.links[linkIndex]
    if (!link) continue
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
    if (localPath === 'fuelTemperatureC') {
      const coolantOutlet = optionalParameterNumber(component, 'initialCoolantInletTemperatureC', 290) + 32
      return coolantOutlet + optionalParameterNumber(component, 'fuelTemperatureRiseAtRatedPowerC', 140) * initialPowerFraction
    }
    if (localPath === 'decayHeatMw') return ratedPowerMw * initialPowerFraction * optionalParameterNumber(component, 'decayHeatFractionAtPower', 0.06)
    if (localPath === 'heatToCoolantMw') return ratedPowerMw * initialPowerFraction
  }
  if (component.kind === 'steamGenerator') {
    if (localPath === 'levelPercent') return parameterNumber(component, 'nominalLevelPercent') * 100
    if (localPath === 'pressureMPa') return parameterNumber(component, 'nominalPressureMPa')
    if (localPath === 'heatTransferMw') return 0
    if (localPath === 'primaryInletTemperatureC') return optionalParameterNumber(component, 'initialPrimaryInletTemperatureC', 322)
    if (localPath === 'primaryOutletTemperatureC') return optionalParameterNumber(component, 'initialPrimaryInletTemperatureC', 322) - 32
    if (localPath === 'tubeMetalTemperatureC') {
      const primary = optionalParameterNumber(component, 'initialPrimaryInletTemperatureC', 322)
      const secondary = optionalParameterNumber(component, 'initialSecondaryTemperatureC', 285)
      return optionalParameterNumber(component, 'tubeMetalInitialTemperatureC', (primary + secondary) / 2)
    }
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
    reads: ['powerMw', 'decayHeatMw'],
    writes: ['heatToCoolantMw'],
    update: ({ component, context }): void => {
      const fissionPower = context.readNumber(componentVariablePath(component, 'powerMw'))
      const decayHeat = context.readNumber(componentVariablePath(component, 'decayHeatMw'))
      context.write(componentVariablePath(component, 'heatToCoolantMw'), Math.max(0, fissionPower + decayHeat))
    },
  },
  {
    id: 'steam-generator-heat-transfer',
    phase: 'solveThermalTransfer',
    componentKind: 'steamGenerator',
    reads: ['tubeMetalTemperatureC', 'secondaryTemperatureC', 'levelPercent', 'incoming:primaryCoolant.temperatureC', 'incoming:primaryCoolant.flowKgPerS'],
    writes: ['heatTransferMw', 'steamFlowKgPerS'],
    update: ({ system, component, context }): void => {
      const primaryWaterTemperature = averageIncomingLinkValue(system, component, 'temperatureC', context, link => link.service === 'primaryCoolant')
        ?? context.readNumber(componentVariablePath(component, 'primaryInletTemperatureC'))
      const primaryWaterFlow = averageIncomingLinkValue(system, component, 'flowKgPerS', context, link => link.service === 'primaryCoolant') ?? 0
      const secondaryTemperature = context.readNumber(componentVariablePath(component, 'secondaryTemperatureC'))
      const tubeMetalTemperature = context.readNumber(componentVariablePath(component, 'tubeMetalTemperatureC'))
      const levelFraction = clamp(context.readNumber(componentVariablePath(component, 'levelPercent')) / 50, 0, 1)
      const transferCapacity = parameterNumber(component, 'heatTransferCoefficientMwPerK') * Math.max(0, tubeMetalTemperature - secondaryTemperature)
      const flowCapacity = heatMwFromWaterFlowAndDeltaT(primaryWaterFlow, Math.max(0, primaryWaterTemperature - secondaryTemperature))
      const heatTransfer = Math.max(0, Math.min(transferCapacity, flowCapacity) * levelFraction)
      context.write(componentVariablePath(component, 'heatTransferMw'), heatTransfer)
      context.write(componentVariablePath(component, 'steamFlowKgPerS'), steamFlowKgPerSFromHeatMw(heatTransfer))
    },
  },
  {
    id: 'reactor-core-power-state',
    phase: 'updateComponentState',
    componentKind: 'reactorCore',
    reads: ['rodInsertionFraction', 'reactivityPcm', 'powerMw', 'coolantOutletTemperatureC', 'fuelTemperatureC', 'decayHeatMw'],
    writes: ['powerMw', 'fuelTemperatureC', 'decayHeatMw'],
    update: ({ component, context }): void => {
      const ratedPower = parameterNumber(component, 'ratedPowerMw')
      const rodInsertion = clamp(context.readNumber(componentVariablePath(component, 'rodInsertionFraction')), 0, 1)
      const reactivity = context.readNumber(componentVariablePath(component, 'reactivityPcm'))
      const targetPower = ratedPower * clamp(1 - rodInsertion + reactivity / 10_000, 0, 1.15)
      const currentPower = context.readNumber(componentVariablePath(component, 'powerMw'))
      const nextPower = approach(currentPower, targetPower, ratedPower * 0.08 * context.dtSeconds)
      context.write(componentVariablePath(component, 'powerMw'), nextPower)

      const decayTarget = Math.max(currentPower, nextPower) * optionalParameterNumber(component, 'decayHeatFractionAtPower', 0.06)
      const decayHeat = context.readNumber(componentVariablePath(component, 'decayHeatMw'))
      context.write(
        componentVariablePath(component, 'decayHeatMw'),
        relaxToward(decayHeat, decayTarget, context.dtSeconds, optionalParameterNumber(component, 'decayHeatTimeConstantS', 900)),
      )

      const coolantOutlet = context.readNumber(componentVariablePath(component, 'coolantOutletTemperatureC'))
      const fuelTemperatureTarget = coolantOutlet + optionalParameterNumber(component, 'fuelTemperatureRiseAtRatedPowerC', 140) * clamp(nextPower / ratedPower, 0, 1.2)
      context.write(
        componentVariablePath(component, 'fuelTemperatureC'),
        relaxToward(context.readNumber(componentVariablePath(component, 'fuelTemperatureC')), fuelTemperatureTarget, context.dtSeconds, optionalParameterNumber(component, 'fuelThermalTimeConstantS', 20)),
      )
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
      const outletTarget = clamp(inletTemperature + waterDeltaTFromHeatMw(heatToCoolant, flow), 220, 360)
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
      'tubeMetalTemperatureC',
      'secondaryTemperatureC',
      'secondaryInventoryKg',
      'incoming:primaryCoolant.temperatureC',
      'incoming:primaryCoolant.flowKgPerS',
    ],
    writes: ['pressureMPa', 'levelPercent', 'primaryInletTemperatureC', 'primaryOutletTemperatureC', 'tubeMetalTemperatureC', 'secondaryTemperatureC', 'secondaryInventoryKg'],
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
      const primaryOutletTarget = clamp(primaryInletTemperature - waterDeltaTFromHeatMw(heatTransfer, primaryFlow), 180, primaryInletTemperature)
      const primaryTimeConstantSeconds = optionalParameterNumber(component, 'primaryThermalTimeConstantS', 10)
      context.write(componentVariablePath(component, 'primaryInletTemperatureC'), relaxToward(context.readNumber(componentVariablePath(component, 'primaryInletTemperatureC')), primaryInletTemperature, context.dtSeconds, primaryTimeConstantSeconds))
      context.write(componentVariablePath(component, 'primaryOutletTemperatureC'), relaxToward(context.readNumber(componentVariablePath(component, 'primaryOutletTemperatureC')), primaryOutletTarget, context.dtSeconds, primaryTimeConstantSeconds))
      const tubeMetalTemperature = context.readNumber(componentVariablePath(component, 'tubeMetalTemperatureC'))
      const primaryToTubeHeat = Math.min(
        heatMwFromWaterFlowAndDeltaT(primaryFlow, Math.max(0, primaryInletTemperature - tubeMetalTemperature)),
        parameterNumber(component, 'heatTransferCoefficientMwPerK') * Math.max(0, primaryInletTemperature - tubeMetalTemperature),
      )
      context.write(componentVariablePath(component, 'tubeMetalTemperatureC'), energyBalanceTemperatureStep({
        currentTemperatureC: tubeMetalTemperature,
        heatInMw: primaryToTubeHeat,
        heatOutMw: heatTransfer,
        dtSeconds: context.dtSeconds,
        thermalCapacityMjPerK: optionalParameterNumber(component, 'tubeMetalThermalCapacityMjPerK', 8_000),
        minTemperatureC: 120,
        maxTemperatureC: 360,
      }))

      const secondaryTemperatureTarget = clamp(saturationTemperatureCFromPressureMPa(context.readNumber(pressurePath)), 160, 330)
      context.write(componentVariablePath(component, 'secondaryTemperatureC'), relaxToward(context.readNumber(componentVariablePath(component, 'secondaryTemperatureC')), secondaryTemperatureTarget, context.dtSeconds, optionalParameterNumber(component, 'secondaryThermalTimeConstantS', 25)))
      const currentPressure = context.readNumber(pressurePath)
      const generatedSteamFlow = context.readNumber(componentVariablePath(component, 'steamFlowKgPerS'))
      const temperaturePressureBias = (context.readNumber(componentVariablePath(component, 'secondaryTemperatureC')) - saturationTemperatureCFromPressureMPa(nominalPressure)) / 100
      const pressureTarget = nominalPressure * (1 + temperaturePressureBias) + ((generatedSteamFlow - turbineSteamFlow) / 1_000) * nominalPressure
      context.write(pressurePath, approach(currentPressure, clamp(pressureTarget, nominalPressure * 0.2, nominalPressure * 1.4), 0.08 * context.dtSeconds))
      const nominalInventory = optionalParameterNumber(component, 'nominalSecondaryInventoryKg', 56_000)
      const currentInventory = context.readNumber(componentVariablePath(component, 'secondaryInventoryKg'))
      const nextInventory = clamp(currentInventory + (feedwaterFlow - turbineSteamFlow) * context.dtSeconds, 0, nominalInventory)
      const inventoryTimeConstant = optionalParameterNumber(component, 'inventoryTimeConstantS', 20)
      const relaxedInventory = relaxToward(currentInventory, nextInventory, context.dtSeconds, inventoryTimeConstant)
      context.write(componentVariablePath(component, 'secondaryInventoryKg'), relaxedInventory)
      context.write(levelPath, clamp((relaxedInventory / nominalInventory) * 100, 0, 100))
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
