import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import {
  compileProcessPlantSystem,
  createProcessPlantMultiSystemTestbed,
  processPlantPressurizedWaterReactorGraphRef,
  type ProcessPlantMultiSystemConfig,
  type ProcessPlantScheduledAction,
  type ProcessPlantTelemetrySeries,
  type VariablePath,
} from '../../src/packs/process-plant/index.ts'

const durationMs = 240_000
const stepMs = 1_000
const sampleIntervalMs = 1_000
const artifactRoot = process.env.PROCESS_PLANT_ACCEPTANCE_ARTIFACT_ROOT ?? 'docs/assets'
const traceSvgPath = `${artifactRoot}/process-plant-acceptance-traces.svg`
const traceCsvPath = `${artifactRoot}/process-plant-acceptance-traces.csv`
const summaryJsonPath = `${artifactRoot}/process-plant-acceptance-summary.json`
const minRealtimeFactor = Number(process.env.PROCESS_PLANT_ACCEPTANCE_MIN_REALTIME_FACTOR ?? 20)

if (!Number.isFinite(minRealtimeFactor) || minRealtimeFactor <= 0) {
  throw new Error('PROCESS_PLANT_ACCEPTANCE_MIN_REALTIME_FACTOR must be a positive number when provided')
}

const variablePath = (value: string): VariablePath => value as VariablePath

const telemetryVariables = [
  'core.powerMw',
  'core.fissionPowerMw',
  'core.totalThermalPowerMw',
  'core.temperatureFeedbackPcm',
  'core.effectiveReactivityPcm',
  'core.fuelLowerTemperatureC',
  'core.fuelMidTemperatureC',
  'core.fuelUpperTemperatureC',
  'core.fuelStoredEnergyMj',
  'core.decayHeatMw',
  'vessel.primaryPressureBiasMPa',
  'vessel.compressibilityPressureBiasMPa',
  'vessel.thermalExpansionPressureBiasMPa',
  'vessel.meanPrimaryCoolantTemperatureC',
  'vessel.primaryCoolantInventoryKg',
  'pressurizer.pressureMPa',
  'pressurizer.steamPressureMPa',
  'pressurizer.pressureTargetMPa',
  'pressurizer.steamMassKg',
  'pressurizer.steamVolumeM3',
  'pressurizer.waterInventoryBalanceResidualKg',
  'pressurizer.steamMassBalanceResidualKg',
  'pressurizer.reliefFlowKgPerS',
  'sgA.levelPercent',
  'sgA.pressureMPa',
  'sgA.pressureTargetMPa',
  'sgA.steamMassKg',
  'sgA.steamOutflowKgPerS',
  'sgA.feedwaterFlowKgPerS',
  'sgA.secondaryInventoryBalanceResidualKg',
  'sgA.steamMassBalanceResidualKg',
  'sgA.boilingEnergyResidualMw',
  'sgA.primaryToSecondaryLeakKgPerS',
  'sgA.secondaryRadiationMSvPerH',
  'rcpA.loopFlowKgPerS',
  'turbine.electricMw',
  'turbine.steamDemandKgPerS',
  'turbine.steamAvailabilityFraction',
  'turbine.exhaustTemperatureC',
  'feedwaterHeader.flowBalanceResidualKgPerS',
  'auxFeedwaterHeader.flowBalanceResidualKgPerS',
  'main-feedwater-pump-a-to-header.flowKgPerS',
  'main-feedwater-pump-b-to-header.flowKgPerS',
  'motor-afw-pump-to-header.flowKgPerS',
  'aux-feedwater-valve-a-to-sg-a.flowKgPerS',
  'condenser.heatRejectedMw',
  'condenser.backPressurePa',
  'condenser.condensateInventoryKg',
] as const satisfies ReadonlyArray<string>

type CaseId =
  | 'baseline'
  | 'sgtr'
  | 'loss-feedwater'
  | 'aux-feedwater-recovery'
  | 'rcp-trip'
  | 'relief-open'
  | 'load-reduction'
  | 'condenser-backpressure'
  | 'mixed-transient'

interface AcceptanceCase {
  readonly id: CaseId
  readonly title: string
  readonly description: string
  readonly parameters?: Record<string, Record<string, unknown>>
  readonly actions: ReadonlyArray<ProcessPlantScheduledAction>
}

interface Point {
  readonly x: number
  readonly y: number
}

interface PlotSeries {
  readonly label: string
  readonly color: string
  readonly points: ReadonlyArray<Point>
}

interface AcceptanceCheck {
  readonly caseId: CaseId
  readonly description: string
  readonly passed: boolean
  readonly details: string
}

const cases: ReadonlyArray<AcceptanceCase> = [
  {
    id: 'baseline',
    title: 'Baseline',
    description: 'No scheduled fault. Published variables should remain bounded and near steady state.',
    actions: [],
  },
  {
    id: 'sgtr',
    title: 'SGTR',
    description: 'Steam generator tube leak creates primary-to-secondary leak flow and secondary radiation.',
    actions: [{
      id: 'sgtr-open-tube-leak',
      atMs: 60_000,
      type: 'setVariable',
      path: variablePath('sgA.tubeLeakFraction'),
      value: 0.35,
    }],
  },
  {
    id: 'loss-feedwater',
    title: 'Loss of Feedwater',
    description: 'Both main feedwater pumps trip and steam generator level should fall.',
    actions: [
      {
        id: 'trip-main-feedwater-a',
        atMs: 60_000,
        type: 'tripComponent',
        componentId: 'mainFeedwaterPumpA' as never,
      },
      {
        id: 'trip-main-feedwater-b',
        atMs: 60_000,
        type: 'tripComponent',
        componentId: 'mainFeedwaterPumpB' as never,
      },
    ],
  },
  {
    id: 'aux-feedwater-recovery',
    title: 'Aux Feed Recovery',
    description: 'Main feedwater trips, one auxiliary branch is opened, and header balance should remain coherent.',
    actions: [
      {
        id: 'trip-main-feedwater-a',
        atMs: 45_000,
        type: 'tripComponent',
        componentId: 'mainFeedwaterPumpA' as never,
      },
      {
        id: 'trip-main-feedwater-b',
        atMs: 45_000,
        type: 'tripComponent',
        componentId: 'mainFeedwaterPumpB' as never,
      },
      {
        id: 'start-motor-aux-feed',
        atMs: 90_000,
        type: 'setVariable',
        path: variablePath('auxFeedwaterPumpMotor.running'),
        value: true,
      },
      {
        id: 'open-aux-feed-a',
        atMs: 90_000,
        type: 'setVariable',
        path: variablePath('auxFeedwaterValveA.positionFraction'),
        value: 1,
      },
    ],
  },
  {
    id: 'rcp-trip',
    title: 'RCP A Trip',
    description: 'One reactor coolant pump coasts down and loop flow should decline without instantly collapsing.',
    actions: [{
      id: 'trip-rcp-a',
      atMs: 60_000,
      type: 'tripComponent',
      componentId: 'rcpA' as never,
    }],
  },
  {
    id: 'relief-open',
    title: 'Pressurizer Relief',
    description: 'Opening pressurizer relief creates relief flow and lowers steam mass/pressure tendency.',
    actions: [{
      id: 'open-pressurizer-relief',
      atMs: 60_000,
      type: 'setVariable',
      path: variablePath('pressurizer.reliefValvePositionFraction'),
      value: 1,
    }],
  },
  {
    id: 'load-reduction',
    title: 'Load Reduction',
    description: 'Turbine load demand reduces electric output and steam demand.',
    actions: [{
      id: 'reduce-turbine-load',
      atMs: 60_000,
      type: 'setVariable',
      path: variablePath('turbine.loadFraction'),
      value: 0.45,
    }],
  },
  {
    id: 'condenser-backpressure',
    title: 'Condenser Backpressure',
    description: 'Hot cooling water raises condenser backpressure and derates turbine demand/output.',
    parameters: {
      condenser: { coolingWaterTemperatureC: 95 },
    },
    actions: [],
  },
  {
    id: 'mixed-transient',
    title: 'Mixed Transient',
    description: 'A combined SGTR, RCP trip, and load reduction checks multi-unit scenario behavior.',
    actions: [
      {
        id: 'mixed-open-tube-leak',
        atMs: 45_000,
        type: 'setVariable',
        path: variablePath('sgA.tubeLeakFraction'),
        value: 0.25,
      },
      {
        id: 'mixed-trip-rcp-a',
        atMs: 75_000,
        type: 'tripComponent',
        componentId: 'rcpA' as never,
      },
      {
        id: 'mixed-reduce-turbine-load',
        atMs: 120_000,
        type: 'setVariable',
        path: variablePath('turbine.loadFraction'),
        value: 0.5,
      },
    ],
  },
]

const compiledSystem = (
  id: string,
  parameters?: Record<string, Record<string, unknown>>,
) => compileProcessPlantSystem({
  id,
  pack: 'process-plant',
  componentLibrary: 'process-plant',
  graphRef: processPlantPressurizedWaterReactorGraphRef,
  ...(parameters === undefined ? {} : { parameters }),
})

const configs = (): ReadonlyArray<ProcessPlantMultiSystemConfig> =>
  cases.map(testCase => ({
    system: compiledSystem(testCase.id, testCase.parameters),
    schedule: { actions: testCase.actions },
    telemetry: {
      sampleIntervalMs,
      variables: telemetryVariables.map(variablePath),
    },
  }))

const seriesFor = (
  telemetry: ReadonlyArray<ProcessPlantTelemetrySeries>,
  path: string,
): ProcessPlantTelemetrySeries => {
  const series = telemetry.find(candidate => candidate.path === path)
  if (!series) throw new Error(`missing process plant acceptance telemetry series: ${path}`)
  return series
}

const valueAtOrAfter = (
  telemetry: ReadonlyArray<ProcessPlantTelemetrySeries>,
  path: string,
  elapsedMs: number,
): number => {
  const point = seriesFor(telemetry, path).points.find(candidate => candidate.elapsedMs >= elapsedMs)
  if (!point) throw new Error(`missing process plant acceptance point for ${path} at ${elapsedMs}ms`)
  if (typeof point.value !== 'number') throw new Error(`process plant acceptance variable is not numeric: ${path}`)
  return point.value
}

const maxAfter = (
  telemetry: ReadonlyArray<ProcessPlantTelemetrySeries>,
  path: string,
  elapsedMs: number,
): number => {
  const values = seriesFor(telemetry, path).points
    .filter(point => point.elapsedMs >= elapsedMs)
    .map(point => {
      if (typeof point.value !== 'number') throw new Error(`process plant acceptance variable is not numeric: ${path}`)
      return point.value
    })
  if (values.length === 0) throw new Error(`no process plant acceptance samples after ${elapsedMs}ms for ${path}`)
  return Math.max(...values)
}

const minAfter = (
  telemetry: ReadonlyArray<ProcessPlantTelemetrySeries>,
  path: string,
  elapsedMs: number,
): number => {
  const values = seriesFor(telemetry, path).points
    .filter(point => point.elapsedMs >= elapsedMs)
    .map(point => {
      if (typeof point.value !== 'number') throw new Error(`process plant acceptance variable is not numeric: ${path}`)
      return point.value
    })
  if (values.length === 0) throw new Error(`no process plant acceptance samples after ${elapsedMs}ms for ${path}`)
  return Math.min(...values)
}

const numericPoints = (
  telemetry: ReadonlyArray<ProcessPlantTelemetrySeries>,
  path: string,
  scale: number,
): ReadonlyArray<Point> =>
  seriesFor(telemetry, path).points.map(point => {
    if (typeof point.value !== 'number') throw new Error(`process plant acceptance variable is not numeric: ${path}`)
    return { x: point.elapsedMs / 1_000, y: point.value * scale }
  })

const maxAbsoluteSeriesDelta = (
  telemetry: ReadonlyArray<ProcessPlantTelemetrySeries>,
  leftPath: string,
  rightPath: string,
): number => {
  const left = seriesFor(telemetry, leftPath).points
  const right = seriesFor(telemetry, rightPath).points
  if (left.length !== right.length) throw new Error(`acceptance series length mismatch: ${leftPath} vs ${rightPath}`)
  let maxDelta = 0
  for (let index = 0; index < left.length; index += 1) {
    const leftPoint = left[index]
    const rightPoint = right[index]
    if (!leftPoint || !rightPoint) throw new Error(`acceptance series point mismatch: ${leftPath} vs ${rightPath}`)
    if (leftPoint.elapsedMs !== rightPoint.elapsedMs) throw new Error(`acceptance series timestamp mismatch: ${leftPath} vs ${rightPath}`)
    if (typeof leftPoint.value !== 'number' || typeof rightPoint.value !== 'number') throw new Error(`acceptance series is not numeric: ${leftPath} vs ${rightPath}`)
    maxDelta = Math.max(maxDelta, Math.abs(leftPoint.value - rightPoint.value))
  }
  return maxDelta
}

const maxAbsoluteValue = (
  telemetry: ReadonlyArray<ProcessPlantTelemetrySeries>,
  path: string,
): number => {
  let maxValue = 0
  for (const point of seriesFor(telemetry, path).points) {
    if (typeof point.value !== 'number') throw new Error(`acceptance series is not numeric: ${path}`)
    maxValue = Math.max(maxValue, Math.abs(point.value))
  }
  return maxValue
}

const maxAbsoluteComputedDelta = (
  telemetry: ReadonlyArray<ProcessPlantTelemetrySeries>,
  observedPath: string,
  addendPaths: ReadonlyArray<string>,
): number => {
  const observed = seriesFor(telemetry, observedPath).points
  const addendSeries = addendPaths.map(path => seriesFor(telemetry, path).points)
  let maxDelta = 0
  for (let index = 0; index < observed.length; index += 1) {
    const observedPoint = observed[index]
    if (!observedPoint || typeof observedPoint.value !== 'number') throw new Error(`acceptance observed series is not numeric: ${observedPath}`)
    let expected = 0
    for (let seriesIndex = 0; seriesIndex < addendSeries.length; seriesIndex += 1) {
      const addendPoint = addendSeries[seriesIndex]?.[index]
      const addendPath = addendPaths[seriesIndex]
      if (!addendPoint || addendPoint.elapsedMs !== observedPoint.elapsedMs) throw new Error(`acceptance computed series timestamp mismatch: ${observedPath} vs ${String(addendPath)}`)
      if (typeof addendPoint.value !== 'number') throw new Error(`acceptance computed series is not numeric: ${String(addendPath)}`)
      expected += addendPoint.value
    }
    maxDelta = Math.max(maxDelta, Math.abs(observedPoint.value - expected))
  }
  return maxDelta
}

const check = (
  caseId: CaseId,
  description: string,
  passed: boolean,
  details: string,
): AcceptanceCheck => ({ caseId, description, passed, details })

const nonnegativeTelemetryPaths: ReadonlySet<string> = new Set([
  'core.powerMw',
  'core.fissionPowerMw',
  'core.totalThermalPowerMw',
  'core.fuelStoredEnergyMj',
  'vessel.primaryCoolantInventoryKg',
  'pressurizer.pressureMPa',
  'pressurizer.steamPressureMPa',
  'pressurizer.pressureTargetMPa',
  'pressurizer.steamMassKg',
  'pressurizer.steamVolumeM3',
  'pressurizer.reliefFlowKgPerS',
  'sgA.levelPercent',
  'sgA.pressureMPa',
  'sgA.pressureTargetMPa',
  'sgA.steamMassKg',
  'sgA.feedwaterFlowKgPerS',
  'sgA.primaryToSecondaryLeakKgPerS',
  'sgA.secondaryRadiationMSvPerH',
  'rcpA.loopFlowKgPerS',
  'turbine.electricMw',
  'turbine.steamDemandKgPerS',
  'turbine.steamAvailabilityFraction',
  'turbine.exhaustTemperatureC',
  'main-feedwater-pump-a-to-header.flowKgPerS',
  'main-feedwater-pump-b-to-header.flowKgPerS',
  'motor-afw-pump-to-header.flowKgPerS',
  'aux-feedwater-valve-a-to-sg-a.flowKgPerS',
  'condenser.heatRejectedMw',
  'condenser.backPressurePa',
  'condenser.condensateInventoryKg',
])

const evaluateTelemetryIntegrity = (
  caseId: CaseId,
  telemetry: ReadonlyArray<ProcessPlantTelemetrySeries>,
): ReadonlyArray<AcceptanceCheck> => {
  const numericValues = telemetry.flatMap(series => series.points.map(point => ({
    path: series.path,
    value: point.value,
  })))
  const invalidFinite = numericValues.find(point => typeof point.value !== 'number' || !Number.isFinite(point.value))
  const invalidNegative = numericValues.find(point =>
    typeof point.value === 'number'
    && nonnegativeTelemetryPaths.has(point.path)
    && point.value < -1e-9,
  )
  const maxFissionMismatch = maxAbsoluteSeriesDelta(telemetry, 'core.powerMw', 'core.fissionPowerMw')
  const maxThermalPowerMismatch = maxAbsoluteComputedDelta(
    telemetry,
    'core.totalThermalPowerMw',
    ['core.fissionPowerMw', 'core.decayHeatMw'],
  )
  const maxPressureBiasMismatch = maxAbsoluteComputedDelta(
    telemetry,
    'vessel.primaryPressureBiasMPa',
    ['vessel.compressibilityPressureBiasMPa', 'vessel.thermalExpansionPressureBiasMPa'],
  )
  const maxSgInventoryResidual = maxAbsoluteValue(telemetry, 'sgA.secondaryInventoryBalanceResidualKg')
  const maxSgSteamResidual = maxAbsoluteValue(telemetry, 'sgA.steamMassBalanceResidualKg')
  const maxSgBoilingEnergyResidual = maxAbsoluteValue(telemetry, 'sgA.boilingEnergyResidualMw')
  const maxPressurizerWaterResidual = maxAbsoluteValue(telemetry, 'pressurizer.waterInventoryBalanceResidualKg')
  const maxPressurizerSteamResidual = maxAbsoluteValue(telemetry, 'pressurizer.steamMassBalanceResidualKg')
  const maxFeedwaterHeaderResidual = maxAbsoluteValue(telemetry, 'feedwaterHeader.flowBalanceResidualKgPerS')
  const maxAuxFeedwaterHeaderResidual = maxAbsoluteValue(telemetry, 'auxFeedwaterHeader.flowBalanceResidualKgPerS')
  return [
    check(
      caseId,
      'all acceptance telemetry samples are finite numbers',
      invalidFinite === undefined,
      invalidFinite === undefined ? 'all finite' : `${invalidFinite.path}=${String(invalidFinite.value)}`,
    ),
    check(
      caseId,
      'nonnegative physical telemetry remains nonnegative',
      invalidNegative === undefined,
      invalidNegative === undefined ? 'all nonnegative' : `${invalidNegative.path}=${String(invalidNegative.value)}`,
    ),
    check(
      caseId,
      'reactor fission power alias remains exact',
      maxFissionMismatch < 1e-6,
      `maxMismatch=${maxFissionMismatch.toExponential(2)}MW`,
    ),
    check(
      caseId,
      'reactor thermal power equals fission plus decay heat',
      maxThermalPowerMismatch < 1e-6,
      `maxMismatch=${maxThermalPowerMismatch.toExponential(2)}MW`,
    ),
    check(
      caseId,
      'reactor vessel pressure bias equals compressibility plus thermal expansion',
      maxPressureBiasMismatch < 1e-6,
      `maxMismatch=${maxPressureBiasMismatch.toExponential(2)}MPa`,
    ),
    check(
      caseId,
      'steam generator liquid and steam balances remain conservative',
      maxSgInventoryResidual < 75 && maxSgSteamResidual < 25 && maxSgBoilingEnergyResidual < 1e-6,
      `inventory=${maxSgInventoryResidual.toExponential(2)}kg steam=${maxSgSteamResidual.toExponential(2)}kg energy=${maxSgBoilingEnergyResidual.toExponential(2)}MW`,
    ),
    check(
      caseId,
      'pressurizer water and steam balances remain conservative',
      maxPressurizerWaterResidual < 5 && maxPressurizerSteamResidual < 5,
      `water=${maxPressurizerWaterResidual.toExponential(2)}kg steam=${maxPressurizerSteamResidual.toExponential(2)}kg`,
    ),
    check(
      caseId,
      'feedwater and aux feedwater headers conserve reachable flow',
      maxFeedwaterHeaderResidual < 1e-6 && maxAuxFeedwaterHeaderResidual < 1e-6,
      `feed=${maxFeedwaterHeaderResidual.toExponential(2)}kg/s aux=${maxAuxFeedwaterHeaderResidual.toExponential(2)}kg/s`,
    ),
  ]
}

const evaluateCase = (
  caseId: CaseId,
  telemetry: ReadonlyArray<ProcessPlantTelemetrySeries>,
): ReadonlyArray<AcceptanceCheck> => {
  if (caseId === 'baseline') {
    const startPower = valueAtOrAfter(telemetry, 'core.powerMw', 10_000)
    const endPower = valueAtOrAfter(telemetry, 'core.powerMw', durationMs)
    const endPressure = valueAtOrAfter(telemetry, 'pressurizer.pressureMPa', durationMs)
    return [
      check(caseId, 'baseline power stays bounded', endPower > 2_000 && endPower < 4_500, `endPower=${endPower.toFixed(1)}MW`),
      check(caseId, 'baseline pressure stays plausible', endPressure > 13 && endPressure < 18, `endPressure=${endPressure.toFixed(2)}MPa`),
      check(caseId, 'baseline does not drift violently', Math.abs(endPower - startPower) < 500, `start=${startPower.toFixed(1)} end=${endPower.toFixed(1)}MW`),
    ]
  }
  if (caseId === 'sgtr') {
    const leak = maxAfter(telemetry, 'sgA.primaryToSecondaryLeakKgPerS', 70_000)
    const radiation = maxAfter(telemetry, 'sgA.secondaryRadiationMSvPerH', 70_000)
    return [
      check(caseId, 'SGTR creates primary-to-secondary leak flow', leak > 0.1, `maxLeak=${leak.toFixed(2)}kg/s`),
      check(caseId, 'SGTR raises secondary radiation indication', radiation > 0.01, `maxRadiation=${radiation.toFixed(3)}mSv/h`),
    ]
  }
  if (caseId === 'loss-feedwater') {
    const beforeLevel = valueAtOrAfter(telemetry, 'sgA.levelPercent', 55_000)
    const afterLevel = valueAtOrAfter(telemetry, 'sgA.levelPercent', durationMs)
    const feed = maxAfter(telemetry, 'sgA.feedwaterFlowKgPerS', 120_000)
    return [
      check(caseId, 'loss of feedwater lowers SG level', afterLevel < beforeLevel - 3, `before=${beforeLevel.toFixed(1)} after=${afterLevel.toFixed(1)}%`),
      check(caseId, 'loss of feedwater removes main feed contribution', feed < 150, `maxFeedAfter120s=${feed.toFixed(1)}kg/s`),
    ]
  }
  if (caseId === 'aux-feedwater-recovery') {
    const mainFeedAfter = maxAfter(telemetry, 'main-feedwater-pump-a-to-header.flowKgPerS', 90_000)
      + maxAfter(telemetry, 'main-feedwater-pump-b-to-header.flowKgPerS', 90_000)
    const auxFeedAfter = maxAfter(telemetry, 'aux-feedwater-valve-a-to-sg-a.flowKgPerS', 120_000)
    const afterLevel = valueAtOrAfter(telemetry, 'sgA.levelPercent', durationMs)
    return [
      check(caseId, 'main feedwater remains isolated after trip', mainFeedAfter < 50, `maxMainFeedAfter90s=${mainFeedAfter.toFixed(1)}kg/s`),
      check(caseId, 'auxiliary feedwater reaches the open SG branch', auxFeedAfter > 20, `maxAuxFeedA=${auxFeedAfter.toFixed(1)}kg/s`),
      check(caseId, 'auxiliary feedwater keeps SG level bounded above dryout', afterLevel > 15, `endLevel=${afterLevel.toFixed(1)}%`),
    ]
  }
  if (caseId === 'rcp-trip') {
    const beforeFlow = valueAtOrAfter(telemetry, 'rcpA.loopFlowKgPerS', 55_000)
    const shortAfterFlow = valueAtOrAfter(telemetry, 'rcpA.loopFlowKgPerS', 65_000)
    const afterFlow = valueAtOrAfter(telemetry, 'rcpA.loopFlowKgPerS', durationMs)
    return [
      check(caseId, 'RCP trip begins a coastdown, not an instant zero', shortAfterFlow > beforeFlow * 0.35, `before=${beforeFlow.toFixed(0)} shortAfter=${shortAfterFlow.toFixed(0)}kg/s`),
      check(caseId, 'RCP trip materially lowers loop flow', afterFlow < beforeFlow * 0.75, `before=${beforeFlow.toFixed(0)} end=${afterFlow.toFixed(0)}kg/s`),
    ]
  }
  if (caseId === 'relief-open') {
    const relief = maxAfter(telemetry, 'pressurizer.reliefFlowKgPerS', 70_000)
    const beforeSteam = valueAtOrAfter(telemetry, 'pressurizer.steamMassKg', 55_000)
    const afterSteam = valueAtOrAfter(telemetry, 'pressurizer.steamMassKg', durationMs)
    return [
      check(caseId, 'relief valve produces relief flow', relief > 0.1, `maxRelief=${relief.toFixed(2)}kg/s`),
      check(caseId, 'relief valve reduces pressurizer steam mass tendency', afterSteam < beforeSteam, `before=${beforeSteam.toFixed(1)} end=${afterSteam.toFixed(1)}kg`),
    ]
  }
  if (caseId === 'load-reduction') {
    const beforeElectric = valueAtOrAfter(telemetry, 'turbine.electricMw', 55_000)
    const afterElectric = valueAtOrAfter(telemetry, 'turbine.electricMw', durationMs)
    const minElectric = minAfter(telemetry, 'turbine.electricMw', 120_000)
    const beforeDemand = valueAtOrAfter(telemetry, 'turbine.steamDemandKgPerS', 55_000)
    const afterDemand = valueAtOrAfter(telemetry, 'turbine.steamDemandKgPerS', durationMs)
    const beforeHeatRejected = valueAtOrAfter(telemetry, 'condenser.heatRejectedMw', 55_000)
    const afterHeatRejected = valueAtOrAfter(telemetry, 'condenser.heatRejectedMw', durationMs)
    const minAvailability = minAfter(telemetry, 'turbine.steamAvailabilityFraction', 120_000)
    const maxAvailability = maxAfter(telemetry, 'turbine.steamAvailabilityFraction', 120_000)
    return [
      check(caseId, 'load reduction lowers turbine output', afterElectric < beforeElectric * 0.7, `before=${beforeElectric.toFixed(1)} end=${afterElectric.toFixed(1)}MW`),
      check(caseId, 'load reduction keeps output nonnegative', minElectric >= 0, `min=${minElectric.toFixed(1)}MW`),
      check(caseId, 'load reduction lowers turbine steam demand', afterDemand < beforeDemand * 0.6, `before=${beforeDemand.toFixed(1)} end=${afterDemand.toFixed(1)}kg/s`),
      check(caseId, 'load reduction lowers condenser heat rejection', afterHeatRejected < beforeHeatRejected * 0.75, `before=${beforeHeatRejected.toFixed(1)} end=${afterHeatRejected.toFixed(1)}MW`),
      check(caseId, 'turbine steam availability remains a bounded ratio', minAvailability >= 0 && maxAvailability <= 1, `min=${minAvailability.toFixed(2)} max=${maxAvailability.toFixed(2)}`),
    ]
  }
  if (caseId === 'condenser-backpressure') {
    const backPressure = valueAtOrAfter(telemetry, 'condenser.backPressurePa', durationMs)
    const electric = valueAtOrAfter(telemetry, 'turbine.electricMw', durationMs)
    const steamDemand = valueAtOrAfter(telemetry, 'turbine.steamDemandKgPerS', durationMs)
    return [
      check(caseId, 'hot condenser raises backpressure', backPressure > 20_000, `backPressure=${backPressure.toFixed(0)}Pa`),
      check(caseId, 'condenser backpressure derates turbine output', electric < 900, `electric=${electric.toFixed(1)}MW`),
      check(caseId, 'condenser backpressure derates turbine steam demand', steamDemand < 1_350, `steamDemand=${steamDemand.toFixed(1)}kg/s`),
    ]
  }
  const leak = maxAfter(telemetry, 'sgA.primaryToSecondaryLeakKgPerS', 55_000)
  const beforeFlow = valueAtOrAfter(telemetry, 'rcpA.loopFlowKgPerS', 70_000)
  const afterFlow = valueAtOrAfter(telemetry, 'rcpA.loopFlowKgPerS', durationMs)
  const beforeElectric = valueAtOrAfter(telemetry, 'turbine.electricMw', 110_000)
  const afterElectric = valueAtOrAfter(telemetry, 'turbine.electricMw', durationMs)
  return [
    check(caseId, 'mixed transient creates tube leak flow', leak > 0.1, `maxLeak=${leak.toFixed(2)}kg/s`),
    check(caseId, 'mixed transient lowers the tripped loop flow', afterFlow < beforeFlow * 0.8, `before=${beforeFlow.toFixed(0)} end=${afterFlow.toFixed(0)}kg/s`),
    check(caseId, 'mixed transient lowers turbine output after load reduction', afterElectric < beforeElectric * 0.75, `before=${beforeElectric.toFixed(1)} end=${afterElectric.toFixed(1)}MW`),
  ]
}

const svgEscape = (value: string): string =>
  value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')

const scaledPath = (
  points: ReadonlyArray<Point>,
  bounds: { readonly x: number; readonly y: number; readonly width: number; readonly height: number },
  yMin: number,
  yMax: number,
): string => {
  const span = yMax - yMin
  if (span <= 0) throw new Error('acceptance plot y-axis span must be positive')
  return points.map((point, index) => {
    const x = bounds.x + (point.x / (durationMs / 1_000)) * bounds.width
    const y = bounds.y + bounds.height - ((point.y - yMin) / span) * bounds.height
    return `${index === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`
  }).join(' ')
}

const renderPanel = (
  testCase: AcceptanceCase,
  telemetry: ReadonlyArray<ProcessPlantTelemetrySeries>,
  x: number,
  y: number,
): string => {
  const width = 350
  const height = 225
  const bounds = { x: x + 50, y: y + 60, width: width - 78, height: height - 106 }
  const series: ReadonlyArray<PlotSeries> = [
    {
      label: 'Core MW / 10',
      color: '#2563eb',
      points: numericPoints(telemetry, 'core.powerMw', 1 / 10),
    },
    {
      label: 'SG level %',
      color: '#0f766e',
      points: numericPoints(telemetry, 'sgA.levelPercent', 1),
    },
    {
      label: 'PZR MPa x 10',
      color: '#dc2626',
      points: numericPoints(telemetry, 'pressurizer.pressureMPa', 10),
    },
    {
      label: 'Turbine MW / 10',
      color: '#f59e0b',
      points: numericPoints(telemetry, 'turbine.electricMw', 1 / 10),
    },
  ]
  const lines = series.map(item => `
    <path d="${scaledPath(item.points, bounds, 0, 420)}" fill="none" stroke="${item.color}" stroke-width="2.1"/>`).join('')
  const legend = series.map((item, index) => {
    const lx = x + 56 + (index % 2) * 146
    const ly = y + height - 34 + Math.floor(index / 2) * 17
    return `
      <g transform="translate(${lx}, ${ly})">
        <line x1="0" y1="0" x2="18" y2="0" stroke="${item.color}" stroke-width="3"/>
        <text x="24" y="4" font-family="Inter, system-ui, sans-serif" font-size="11" fill="#374151">${svgEscape(item.label)}</text>
      </g>`
  }).join('')
  return `
    <g>
      <rect x="${x}" y="${y}" width="${width}" height="${height}" rx="12" fill="#ffffff" stroke="#d1d5db"/>
      <text x="${x + 22}" y="${y + 28}" font-family="Inter, system-ui, sans-serif" font-size="17" font-weight="700" fill="#111827">${svgEscape(testCase.title)}</text>
      <text x="${x + 22}" y="${y + 47}" font-family="Inter, system-ui, sans-serif" font-size="11" fill="#6b7280">${svgEscape(testCase.description)}</text>
      <line x1="${bounds.x}" y1="${bounds.y + bounds.height}" x2="${bounds.x + bounds.width}" y2="${bounds.y + bounds.height}" stroke="#9ca3af"/>
      <line x1="${bounds.x}" y1="${bounds.y}" x2="${bounds.x}" y2="${bounds.y + bounds.height}" stroke="#9ca3af"/>
      <text x="${bounds.x - 8}" y="${bounds.y + 4}" text-anchor="end" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#6b7280">420</text>
      <text x="${bounds.x - 8}" y="${bounds.y + bounds.height + 4}" text-anchor="end" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#6b7280">0</text>
      ${lines}
      ${legend}
    </g>`
}

const renderSvg = (
  traces: ReadonlyArray<{ readonly systemId: string; readonly telemetry?: ReadonlyArray<ProcessPlantTelemetrySeries> }>,
  checks: ReadonlyArray<AcceptanceCheck>,
): string => {
  const columns = 3
  const panelRows = Math.ceil(cases.length / columns)
  const svgHeight = 92 + panelRows * 268 + 72
  const panels = cases.map((testCase, index) => {
    const trace = traces.find(candidate => candidate.systemId === testCase.id)
    if (!trace?.telemetry) throw new Error(`acceptance trace missing telemetry for ${testCase.id}`)
    return renderPanel(testCase, trace.telemetry, 50 + (index % columns) * 380, 92 + Math.floor(index / columns) * 268)
  }).join('')
  const failed = checks.filter(candidate => !candidate.passed)
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="${svgHeight}" viewBox="0 0 1200 ${svgHeight}">
  <rect width="1200" height="${svgHeight}" fill="#f8fafc"/>
  <text x="50" y="42" font-family="Inter, system-ui, sans-serif" font-size="26" font-weight="800" fill="#111827">Process Plant Acceptance Traces</text>
  <text x="50" y="66" font-family="Inter, system-ui, sans-serif" font-size="13" fill="#64748b">${cases.length} representative transients from the real graphRef/runtime. Checks: ${checks.length - failed.length}/${checks.length} passed.</text>
  ${panels}
</svg>`
}

const csvRowsFor = (
  traces: ReadonlyArray<{ readonly systemId: string; readonly telemetry?: ReadonlyArray<ProcessPlantTelemetrySeries> }>,
): ReadonlyArray<string> => {
  const rows = ['case,path,elapsedMs,value,canonicalValue,unit']
  for (const trace of traces) {
    if (!trace.telemetry) throw new Error(`acceptance trace missing telemetry for ${trace.systemId}`)
    for (const series of trace.telemetry) {
      for (const point of series.points) {
        rows.push(`${trace.systemId},${series.path},${point.elapsedMs},${point.value},${point.canonicalValue},${point.unit}`)
      }
    }
  }
  return rows
}

const main = async (): Promise<void> => {
  const started = performance.now()
  const traces = createProcessPlantMultiSystemTestbed(configs()).runFor(durationMs, stepMs)
  const wallMs = performance.now() - started
  const checks = traces.flatMap(trace => {
    if (!trace.telemetry) throw new Error(`acceptance trace missing telemetry for ${trace.systemId}`)
    return [
      ...evaluateCase(trace.systemId as CaseId, trace.telemetry),
      ...evaluateTelemetryIntegrity(trace.systemId as CaseId, trace.telemetry),
    ]
  })
  const failed = checks.filter(candidate => !candidate.passed)
  const realtimeFactor = durationMs / wallMs
  const performanceChecks = [
    check('baseline', 'multi-case acceptance run remains comfortably faster than realtime', realtimeFactor >= minRealtimeFactor, `realtimeFactor=${realtimeFactor.toFixed(1)}x min=${minRealtimeFactor.toFixed(1)}x`),
  ] satisfies ReadonlyArray<AcceptanceCheck>
  const failedPerformanceChecks = performanceChecks.filter(candidate => !candidate.passed)
  await mkdir(dirname(traceSvgPath), { recursive: true })
  await writeFile(traceSvgPath, renderSvg(traces, checks))
  await writeFile(traceCsvPath, `${csvRowsFor(traces).join('\n')}\n`)
  await writeFile(summaryJsonPath, `${JSON.stringify({
    schemaVersion: 1,
    durationMs,
    stepMs,
    sampleIntervalMs,
    caseCount: cases.length,
    checkCount: checks.length,
    failedCheckCount: failed.length,
    wallMs,
    realtimeFactor,
    minRealtimeFactor,
    checks,
    performanceChecks,
    artifacts: {
      traceSvgPath,
      traceCsvPath,
      summaryJsonPath,
    },
  }, null, 2)}\n`)
  if (failed.length > 0) {
    const details = failed.map(item => `${item.caseId}: ${item.description} (${item.details})`).join('; ')
    throw new Error(`process plant acceptance failed: ${details}`)
  }
  if (failedPerformanceChecks.length > 0) {
    const details = failedPerformanceChecks.map(item => `${item.description} (${item.details})`).join('; ')
    throw new Error(`process plant acceptance performance failed: ${details}`)
  }
  console.log(`process plant acceptance passed ${checks.length}/${checks.length} checks`)
  console.log(`trace: ${traceSvgPath}`)
  console.log(`csv: ${traceCsvPath}`)
  console.log(`summary: ${summaryJsonPath}`)
  console.log(`realtime factor: ${realtimeFactor.toFixed(1)}x`)
}

await main()
