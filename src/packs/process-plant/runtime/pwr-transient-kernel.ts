import type { CompiledComponent, VariablePath } from '../graph/index.ts'
import type { CompiledProcessPlantSystem } from '../process-systems.ts'
import { componentVariablePath } from './behavior-contract.ts'
import type { ProcessPlantVariableTable } from './variable-table.ts'

export interface PwrTransientKernel {
  readonly active: boolean
  readonly core: CompiledComponent | null
  readonly reactorVessel: CompiledComponent | null
  readonly pressurizer: CompiledComponent | null
  readonly steamGenerators: ReadonlyArray<CompiledComponent>
  readonly reactorCoolantPumps: ReadonlyArray<CompiledComponent>
  readonly containment: CompiledComponent | null
  readonly accumulators: ReadonlyArray<CompiledComponent>
  readonly feedwaterTank: CompiledComponent | null
  readonly auxFeedwaterTank: CompiledComponent | null
  readonly auxFeedwaterPumps: ReadonlyArray<CompiledComponent>
  readonly turbine: CompiledComponent | null
  readonly condenser: CompiledComponent | null
  readonly electricalBuses: ReadonlyArray<CompiledComponent>
  readonly safetyBuses: ReadonlyArray<CompiledComponent>
  readonly electricalLoads: ReadonlyArray<CompiledComponent>
  readonly diesels: ReadonlyArray<CompiledComponent>
}

export interface PwrTransientDiagnostics {
  readonly schemaVersion: 1
  readonly active: boolean
  readonly componentCounts: {
    readonly steamGenerators: number
    readonly accumulators: number
    readonly safetyBuses: number
    readonly diesels: number
  }
  readonly primary: {
    readonly inventoryKg: number | null
    readonly inventoryFraction: number | null
    readonly pressureMPa: number | null
    readonly pressureBiasMPa: number | null
    readonly leakFlowKgPerS: number | null
    readonly safetyInjectionFlowKgPerS: number | null
    readonly tubeLeakFlowKgPerS: number | null
    readonly reactorCoolantFlowKgPerS: number
    readonly runningReactorCoolantPumpCount: number
    readonly minReactorCoolantPumpSpeedFraction: number | null
  }
  readonly secondary: {
    readonly liquidInventoryKg: number
    readonly steamMassKg: number
    readonly minLevelPercent: number | null
    readonly minTubeCoverageFraction: number | null
    readonly maxTubeUncoveredFraction: number | null
    readonly maxVoidFraction: number | null
    readonly drySteamGeneratorCount: number
    readonly tubeBundleUncoveredSteamGeneratorCount: number
    readonly heatTransferMw: number
    readonly steamOutflowKgPerS: number
    readonly feedwaterFlowKgPerS: number
    readonly feedwaterTankInventoryKg: number | null
    readonly feedwaterTankLevelPercent: number | null
    readonly feedwaterTankAvailableFlowKgPerS: number | null
    readonly auxFeedwaterFlowKgPerS: number
    readonly auxFeedwaterTankInventoryKg: number | null
    readonly auxFeedwaterTankLevelPercent: number | null
    readonly auxFeedwaterTankAvailableFlowKgPerS: number | null
  }
  readonly balanceOfPlant: {
    readonly turbineElectricMw: number | null
    readonly turbineSteamFlowKgPerS: number | null
    readonly turbineSteamAvailabilityFraction: number | null
    readonly condenserBackPressurePa: number | null
    readonly condenserHeatRejectedMw: number | null
    readonly condenserCondensateInventoryKg: number | null
    readonly condenserCondensateLevelPercent: number | null
    readonly condenserCoolingWaterAvailabilityFraction: number | null
  }
  readonly containment: {
    readonly pressureMPa: number | null
    readonly sumpInventoryKg: number | null
    readonly incomingMassKgPerS: number | null
    readonly radiationSourceTermMSvPerH: number | null
  }
  readonly core: {
    readonly fissionPowerMw: number | null
    readonly decayHeatMw: number | null
    readonly totalThermalPowerMw: number | null
    readonly heatRemovalDeficitMw: number | null
    readonly coolingAvailabilityFraction: number | null
    readonly fuelHeatupRateCPerS: number | null
  }
  readonly safetySystems: {
    readonly accumulatorInventoryKg: number
    readonly accumulatorOutflowKgPerS: number
    readonly deenergizedSafetyBusCount: number
    readonly runningDieselCount: number
  }
  readonly electrical: {
    readonly busCount: number
    readonly energizedBusCount: number
    readonly deenergizedBusCount: number
    readonly degradedBusCount: number
    readonly minBusVoltageFraction: number | null
    readonly minSafetyBusVoltageFraction: number | null
    readonly totalServedLoadMw: number
    readonly totalDemandLoadMw: number
    readonly minLoadServedFraction: number | null
    readonly unservedLoadCount: number
  }
  readonly conservation: {
    readonly maxSteamGeneratorLiquidResidualKg: number
    readonly maxSteamGeneratorSteamResidualKg: number
    readonly maxSteamGeneratorBoilingResidualMw: number
    readonly primaryInventoryResidualKg: number | null
    readonly pressurizerWaterResidualKg: number | null
    readonly pressurizerSteamResidualKg: number | null
  }
}

const componentOfKind = (
  system: CompiledProcessPlantSystem,
  kind: string,
): CompiledComponent | null =>
  system.graph.components.find(component => String(component.kind) === kind) ?? null

const componentById = (
  system: CompiledProcessPlantSystem,
  id: string,
): CompiledComponent | null =>
  system.graph.components.find(component => String(component.id) === id) ?? null

const componentsOfKind = (
  system: CompiledProcessPlantSystem,
  kind: string,
): ReadonlyArray<CompiledComponent> =>
  system.graph.components.filter(component => String(component.kind) === kind)

const componentPath = (component: CompiledComponent | null, localPath: string): VariablePath | null =>
  component === null ? null : componentVariablePath(component, localPath)

const readOptionalNumber = (
  table: ProcessPlantVariableTable,
  path: VariablePath | null,
): number | null => {
  if (path === null || !table.has(path)) return null
  return table.readNumber(path)
}

const readOptionalBoolean = (
  table: ProcessPlantVariableTable,
  path: VariablePath | null,
): boolean | null => {
  if (path === null || !table.has(path)) return null
  return table.readBoolean(path)
}

const sumComponentNumber = (
  table: ProcessPlantVariableTable,
  components: ReadonlyArray<CompiledComponent>,
  localPath: string,
): number => components.reduce((sum, component) => {
  const path = componentVariablePath(component, localPath)
  return table.has(path) ? sum + table.readNumber(path) : sum
}, 0)

const countComponentBoolean = (
  table: ProcessPlantVariableTable,
  components: ReadonlyArray<CompiledComponent>,
  localPath: string,
  expected: boolean,
): number => components.filter(component =>
  readOptionalBoolean(table, componentVariablePath(component, localPath)) === expected
).length

const valuesFor = (
  table: ProcessPlantVariableTable,
  components: ReadonlyArray<CompiledComponent>,
  localPath: string,
): ReadonlyArray<number> => components.flatMap(component => {
  const path = componentVariablePath(component, localPath)
  return table.has(path) ? [table.readNumber(path)] : []
})

const maxAbs = (values: ReadonlyArray<number>): number =>
  values.reduce((max, value) => Math.max(max, Math.abs(value)), 0)

const minimum = (values: ReadonlyArray<number>): number | null =>
  values.length === 0 ? null : Math.min(...values)

const maximum = (values: ReadonlyArray<number>): number | null =>
  values.length === 0 ? null : Math.max(...values)

export const compilePwrTransientKernel = (
  system: CompiledProcessPlantSystem,
): PwrTransientKernel => {
  const steamGenerators = componentsOfKind(system, 'steamGenerator')
  const core = componentOfKind(system, 'reactorCore')
  const reactorVessel = componentOfKind(system, 'reactorVessel')
  const pressurizer = componentOfKind(system, 'pressurizer')
  const reactorCoolantPumps = componentsOfKind(system, 'centrifugalPump')
    .filter(component => String(component.id).toLowerCase().startsWith('rcp'))
  const electricalBuses = componentsOfKind(system, 'electricalBus')
  return {
    active: core !== null && reactorVessel !== null && pressurizer !== null && steamGenerators.length > 0,
    core,
    reactorVessel,
    pressurizer,
    steamGenerators,
    reactorCoolantPumps,
    containment: componentOfKind(system, 'containmentVolume'),
    accumulators: componentsOfKind(system, 'accumulator'),
    feedwaterTank: componentById(system, 'feedwaterTank'),
    auxFeedwaterTank: componentById(system, 'auxFeedwaterTank'),
    auxFeedwaterPumps: componentsOfKind(system, 'centrifugalPump')
      .filter(component => String(component.id).toLowerCase().startsWith('auxfeedwaterpump')),
    turbine: componentOfKind(system, 'turbineLoadSink'),
    condenser: componentOfKind(system, 'condenserSink'),
    electricalBuses,
    safetyBuses: electricalBuses.filter(component => String(component.id).toLowerCase().includes('safety')),
    electricalLoads: componentsOfKind(system, 'electricalLoad'),
    diesels: componentsOfKind(system, 'dieselGenerator'),
  }
}

export const evaluatePwrTransientKernel = (
  kernel: PwrTransientKernel,
  table: ProcessPlantVariableTable,
): PwrTransientDiagnostics => {
  const vessel = kernel.reactorVessel
  const pressurizer = kernel.pressurizer
  const core = kernel.core
  const containment = kernel.containment
  const primaryInventory = readOptionalNumber(table, componentPath(vessel, 'primaryCoolantInventoryKg'))
  const nominalPrimaryInventory = vessel === null
    ? null
    : typeof vessel.parameters === 'object'
      && vessel.parameters !== null
      && 'nominalPrimaryCoolantInventoryKg' in vessel.parameters
      && typeof (vessel.parameters as { nominalPrimaryCoolantInventoryKg?: unknown }).nominalPrimaryCoolantInventoryKg === 'number'
        ? (vessel.parameters as { nominalPrimaryCoolantInventoryKg: number }).nominalPrimaryCoolantInventoryKg
        : null
  const primaryPressure = readOptionalNumber(table, componentPath(pressurizer, 'pressureMPa'))
  const heatTransfer = sumComponentNumber(table, kernel.steamGenerators, 'heatTransferMw')
  const totalThermalPower = readOptionalNumber(table, componentPath(core, 'totalThermalPowerMw'))
  const levelValues = valuesFor(table, kernel.steamGenerators, 'levelPercent')
  const voidValues = valuesFor(table, kernel.steamGenerators, 'voidFraction')
  const tubeCoverageValues = valuesFor(table, kernel.steamGenerators, 'tubeCoverageFraction')
  const tubeUncoveredValues = valuesFor(table, kernel.steamGenerators, 'tubeUncoveredFraction')
  const busVoltageValues = valuesFor(table, kernel.electricalBuses, 'voltageFraction')
  const safetyBusVoltageValues = valuesFor(table, kernel.safetyBuses, 'voltageFraction')
  const loadServedFractionValues = valuesFor(table, kernel.electricalLoads, 'servedFraction')
  return {
    schemaVersion: 1,
    active: kernel.active,
    componentCounts: {
      steamGenerators: kernel.steamGenerators.length,
      accumulators: kernel.accumulators.length,
      safetyBuses: kernel.safetyBuses.length,
      diesels: kernel.diesels.length,
    },
    primary: {
      inventoryKg: primaryInventory,
      inventoryFraction: primaryInventory === null || nominalPrimaryInventory === null ? null : primaryInventory / nominalPrimaryInventory,
      pressureMPa: primaryPressure,
      pressureBiasMPa: readOptionalNumber(table, componentPath(vessel, 'primaryPressureBiasMPa')),
      leakFlowKgPerS: readOptionalNumber(table, componentPath(vessel, 'primaryLeakFlowKgPerS')),
      safetyInjectionFlowKgPerS: readOptionalNumber(table, componentPath(vessel, 'safetyInjectionFlowKgPerS')),
      tubeLeakFlowKgPerS: readOptionalNumber(table, componentPath(vessel, 'tubeLeakFlowKgPerS')),
      reactorCoolantFlowKgPerS: sumComponentNumber(table, kernel.reactorCoolantPumps, 'loopFlowKgPerS'),
      runningReactorCoolantPumpCount: countComponentBoolean(table, kernel.reactorCoolantPumps, 'running', true),
      minReactorCoolantPumpSpeedFraction: minimum(valuesFor(table, kernel.reactorCoolantPumps, 'speedFraction')),
    },
    secondary: {
      liquidInventoryKg: sumComponentNumber(table, kernel.steamGenerators, 'secondaryInventoryKg'),
      steamMassKg: sumComponentNumber(table, kernel.steamGenerators, 'steamMassKg'),
      minLevelPercent: minimum(levelValues),
      minTubeCoverageFraction: minimum(tubeCoverageValues),
      maxTubeUncoveredFraction: maximum(tubeUncoveredValues),
      maxVoidFraction: maximum(voidValues),
      drySteamGeneratorCount: levelValues.filter(level => level <= 5).length,
      tubeBundleUncoveredSteamGeneratorCount: tubeUncoveredValues.filter(uncovered => uncovered > 0.05).length,
      heatTransferMw: heatTransfer,
      steamOutflowKgPerS: sumComponentNumber(table, kernel.steamGenerators, 'steamOutflowKgPerS'),
      feedwaterFlowKgPerS: sumComponentNumber(table, kernel.steamGenerators, 'feedwaterFlowKgPerS'),
      feedwaterTankInventoryKg: readOptionalNumber(table, componentPath(kernel.feedwaterTank, 'inventoryKg')),
      feedwaterTankLevelPercent: readOptionalNumber(table, componentPath(kernel.feedwaterTank, 'levelPercent')),
      feedwaterTankAvailableFlowKgPerS: readOptionalNumber(table, componentPath(kernel.feedwaterTank, 'availableOutletFlowKgPerS')),
      auxFeedwaterFlowKgPerS: sumComponentNumber(table, kernel.auxFeedwaterPumps, 'flowKgPerS'),
      auxFeedwaterTankInventoryKg: readOptionalNumber(table, componentPath(kernel.auxFeedwaterTank, 'inventoryKg')),
      auxFeedwaterTankLevelPercent: readOptionalNumber(table, componentPath(kernel.auxFeedwaterTank, 'levelPercent')),
      auxFeedwaterTankAvailableFlowKgPerS: readOptionalNumber(table, componentPath(kernel.auxFeedwaterTank, 'availableOutletFlowKgPerS')),
    },
    balanceOfPlant: {
      turbineElectricMw: readOptionalNumber(table, componentPath(kernel.turbine, 'electricMw')),
      turbineSteamFlowKgPerS: readOptionalNumber(table, componentPath(kernel.turbine, 'steamFlowKgPerS')),
      turbineSteamAvailabilityFraction: readOptionalNumber(table, componentPath(kernel.turbine, 'steamAvailabilityFraction')),
      condenserBackPressurePa: readOptionalNumber(table, componentPath(kernel.condenser, 'backPressurePa')),
      condenserHeatRejectedMw: readOptionalNumber(table, componentPath(kernel.condenser, 'heatRejectedMw')),
      condenserCondensateInventoryKg: readOptionalNumber(table, componentPath(kernel.condenser, 'condensateInventoryKg')),
      condenserCondensateLevelPercent: readOptionalNumber(table, componentPath(kernel.condenser, 'condensateLevelPercent')),
      condenserCoolingWaterAvailabilityFraction: readOptionalNumber(table, componentPath(kernel.condenser, 'coolingWaterAvailabilityFraction')),
    },
    containment: {
      pressureMPa: readOptionalNumber(table, componentPath(containment, 'pressureMPa')),
      sumpInventoryKg: readOptionalNumber(table, componentPath(containment, 'sumpInventoryKg')),
      incomingMassKgPerS: readOptionalNumber(table, componentPath(containment, 'incomingMassKgPerS')),
      radiationSourceTermMSvPerH: readOptionalNumber(table, componentPath(containment, 'radiationSourceTermMSvPerH')),
    },
    core: {
      fissionPowerMw: readOptionalNumber(table, componentPath(core, 'fissionPowerMw')),
      decayHeatMw: readOptionalNumber(table, componentPath(core, 'decayHeatMw')),
      totalThermalPowerMw: totalThermalPower,
      heatRemovalDeficitMw: readOptionalNumber(table, componentPath(core, 'coreHeatRemovalDeficitMw'))
        ?? (totalThermalPower === null ? null : Math.max(0, totalThermalPower - heatTransfer)),
      coolingAvailabilityFraction: readOptionalNumber(table, componentPath(core, 'coreCoolingAvailabilityFraction')),
      fuelHeatupRateCPerS: readOptionalNumber(table, componentPath(core, 'fuelHeatupRateCPerS')),
    },
    safetySystems: {
      accumulatorInventoryKg: sumComponentNumber(table, kernel.accumulators, 'liquidInventoryKg'),
      accumulatorOutflowKgPerS: sumComponentNumber(table, kernel.accumulators, 'outletFlowKgPerS'),
      deenergizedSafetyBusCount: kernel.safetyBuses.filter(component =>
        readOptionalBoolean(table, componentVariablePath(component, 'energized')) === false
      ).length,
      runningDieselCount: kernel.diesels.filter(component =>
        readOptionalBoolean(table, componentVariablePath(component, 'running')) === true
      ).length,
    },
    electrical: {
      busCount: kernel.electricalBuses.length,
      energizedBusCount: countComponentBoolean(table, kernel.electricalBuses, 'energized', true),
      deenergizedBusCount: countComponentBoolean(table, kernel.electricalBuses, 'energized', false),
      degradedBusCount: countComponentBoolean(table, kernel.electricalBuses, 'degraded', true),
      minBusVoltageFraction: minimum(busVoltageValues),
      minSafetyBusVoltageFraction: minimum(safetyBusVoltageValues),
      totalServedLoadMw: sumComponentNumber(table, kernel.electricalLoads, 'servedMw'),
      totalDemandLoadMw: sumComponentNumber(table, kernel.electricalLoads, 'demandMw'),
      minLoadServedFraction: minimum(loadServedFractionValues),
      unservedLoadCount: loadServedFractionValues.filter(fraction => fraction < 0.99).length,
    },
    conservation: {
      maxSteamGeneratorLiquidResidualKg: maxAbs(valuesFor(table, kernel.steamGenerators, 'secondaryInventoryBalanceResidualKg')),
      maxSteamGeneratorSteamResidualKg: maxAbs(valuesFor(table, kernel.steamGenerators, 'steamMassBalanceResidualKg')),
      maxSteamGeneratorBoilingResidualMw: maxAbs(valuesFor(table, kernel.steamGenerators, 'boilingEnergyResidualMw')),
      primaryInventoryResidualKg: readOptionalNumber(table, componentPath(vessel, 'primaryInventoryBalanceResidualKg')),
      pressurizerWaterResidualKg: readOptionalNumber(table, componentPath(pressurizer, 'waterInventoryBalanceResidualKg')),
      pressurizerSteamResidualKg: readOptionalNumber(table, componentPath(pressurizer, 'steamMassBalanceResidualKg')),
    },
  }
}
