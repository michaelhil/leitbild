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
  readonly containment: CompiledComponent | null
  readonly accumulators: ReadonlyArray<CompiledComponent>
  readonly safetyBuses: ReadonlyArray<CompiledComponent>
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
  return {
    active: core !== null && reactorVessel !== null && pressurizer !== null && steamGenerators.length > 0,
    core,
    reactorVessel,
    pressurizer,
    steamGenerators,
    containment: componentOfKind(system, 'containmentVolume'),
    accumulators: componentsOfKind(system, 'accumulator'),
    safetyBuses: componentsOfKind(system, 'electricalBus').filter(component => String(component.id).toLowerCase().includes('safety')),
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
