import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import {
  compileProcessPlantSystem,
  createProcessPlantMultiSystemTestbed,
  processPlantPwrReferenceAssemblyRef,
  type CompiledComponent,
  type CompiledProcessPlantSystem,
  type ProcessPlantMultiSystemConfig,
  type ProcessPlantMultiSystemSnapshot,
  type ProcessPlantScheduledAction,
  type ProcessPlantTelemetrySeries,
  type VariablePath,
} from '../../src/packs/process-plant/index.ts'

const durationMs = 600_000
const stepMs = 1_000
const sampleIntervalMs = 2_000
const artifactRoot = process.env.PROCESS_PLANT_CREDIBILITY_ARTIFACT_ROOT ?? 'docs/assets'
const summaryJsonPath = `${artifactRoot}/process-plant-pwr-credibility-summary.json`
const reportSvgPath = `${artifactRoot}/process-plant-pwr-credibility-report.svg`

const variablePath = (value: string): VariablePath => value as VariablePath

type SourceRefId =
  | 'nrc-srp-ch15'
  | 'iaea-ssg-2'
  | 'nrc-trace'
  | 'oecd-nea-mslb'
  | 'leitbild-pwr-scope'

interface SourceRef {
  readonly id: SourceRefId
  readonly title: string
  readonly url: string
  readonly note: string
}

const sourceRefs: Readonly<Record<SourceRefId, SourceRef>> = {
  'nrc-srp-ch15': {
    id: 'nrc-srp-ch15',
    title: 'NRC NUREG-0800 Chapter 15',
    url: 'https://www.nrc.gov/reading-rm/doc-collections/nuregs/staff/sr0800/ch15/index.html',
    note: 'Event-family taxonomy for LWR transient and accident analysis.',
  },
  'iaea-ssg-2': {
    id: 'iaea-ssg-2',
    title: 'IAEA SSG-2 Rev. 1 deterministic safety analysis guide',
    url: 'https://nucleus.iaea.org/sites/committees/Set%20of%20valid%20safety%20standards%20202409/safety%20standards_%20valid%20set/SSG-2%20Rev%201%20Deterministic%20Safety%20Analysis%20for%20Nuclear%20Power%20Plants.pdf',
    note: 'Verification, validation, input qualification, assumptions, and documentation discipline.',
  },
  'nrc-trace': {
    id: 'nrc-trace',
    title: 'NRC thermal-hydraulic computer codes',
    url: 'https://www.nrc.gov/about-nrc/regulatory/research/safetycodes.html',
    note: 'Boundary marker for phenomena handled by licensing-grade system codes, not by Leitbild.',
  },
  'oecd-nea-mslb': {
    id: 'oecd-nea-mslb',
    title: 'OECD/NEA PWR Main Steam-Line Break benchmark',
    url: 'https://harbor.oecd-nea.org/jcms/pl_32205/pressurised-water-reactor-main-steam-line-break-mslb-benchmark',
    note: 'Benchmark pattern for event sequence, setpoints, plant conditions, and trace comparisons.',
  },
  'leitbild-pwr-scope': {
    id: 'leitbild-pwr-scope',
    title: 'Leitbild PWR operational-simulator scope',
    url: 'docs/wiki/pwr-ops.md',
    note: 'Local scope boundary: deterministic lumped operational simulator, not a licensing-basis safety-analysis code.',
  },
}

type CaseId =
  | 'steady-power'
  | 'loss-feedwater-afw'
  | 'sgtr'
  | 'small-loca'
  | 'all-rcp-trip'
  | 'loss-offsite-power'

interface CredibilityCase {
  readonly id: CaseId
  readonly title: string
  readonly eventFamily: string
  readonly description: string
  readonly sourceRefs: ReadonlyArray<SourceRefId>
  readonly parameters?: Record<string, Record<string, unknown>>
  readonly initialState?: Record<string, unknown>
  readonly actions: (system: CompiledProcessPlantSystem) => ReadonlyArray<ProcessPlantScheduledAction>
}

type Measurement =
  | {
      readonly kind: 'point'
      readonly path: VariablePath
      readonly atMs: number
    }
  | {
      readonly kind: 'minAfter'
      readonly path: VariablePath
      readonly afterMs: number
    }
  | {
      readonly kind: 'maxAfter'
      readonly path: VariablePath
      readonly afterMs: number
    }
  | {
      readonly kind: 'delta'
      readonly path: VariablePath
      readonly fromMs: number
      readonly toMs: number
    }

interface TargetRange {
  readonly min?: number
  readonly max?: number
}

interface CredibilityTarget {
  readonly id: string
  readonly caseId: CaseId
  readonly label: string
  readonly signal: string
  readonly expectation: string
  readonly measure: Measurement
  readonly acceptable: TargetRange
  readonly severity: 'gate' | 'watch'
  readonly sourceRefs: ReadonlyArray<SourceRefId>
}

interface TargetResult {
  readonly targetId: string
  readonly caseId: CaseId
  readonly label: string
  readonly signal: string
  readonly expectation: string
  readonly observed: number
  readonly acceptable: TargetRange
  readonly passed: boolean
  readonly severity: CredibilityTarget['severity']
  readonly sourceRefs: ReadonlyArray<SourceRefId>
}

const scheduledComponentTrip = (
  id: string,
  atMs: number,
  componentId: string,
): ProcessPlantScheduledAction => ({
  id,
  atMs,
  type: 'tripComponent',
  componentId: componentId as never,
})

const setVariable = (
  id: string,
  atMs: number,
  path: string,
  value: number | boolean,
): ProcessPlantScheduledAction => ({
  id,
  atMs,
  type: 'setVariable',
  path: variablePath(path),
  value,
})

const componentsMatching = (
  system: CompiledProcessPlantSystem,
  predicate: (component: CompiledComponent) => boolean,
): ReadonlyArray<CompiledComponent> =>
  system.graph.components.filter(predicate)

const tripComponentsMatching = (
  system: CompiledProcessPlantSystem,
  atMs: number,
  idPrefix: string,
  predicate: (component: CompiledComponent) => boolean,
): ReadonlyArray<ProcessPlantScheduledAction> =>
  componentsMatching(system, predicate).map(component =>
    scheduledComponentTrip(`${idPrefix}-${component.id}`, atMs, String(component.id)),
  )

const setValvePositionsMatching = (
  system: CompiledProcessPlantSystem,
  atMs: number,
  idPrefix: string,
  positionFraction: number,
  predicate: (component: CompiledComponent) => boolean,
): ReadonlyArray<ProcessPlantScheduledAction> =>
  componentsMatching(system, predicate).map(component =>
    setVariable(`${idPrefix}-${component.id}`, atMs, `${component.id}.positionFraction`, positionFraction),
  )

const isMainFeedwaterPump = (component: CompiledComponent): boolean =>
  component.kind === 'centrifugalPump' && String(component.id).startsWith('mainFeedwaterPump')

const isAuxFeedwaterPump = (component: CompiledComponent): boolean =>
  component.kind === 'centrifugalPump' && String(component.id).startsWith('auxFeedwaterPump')

const isAuxFeedwaterValve = (component: CompiledComponent): boolean =>
  component.kind === 'processValve' && String(component.id).startsWith('auxFeedwaterValve')

const isReactorCoolantPump = (component: CompiledComponent): boolean =>
  component.kind === 'centrifugalPump' && String(component.id).startsWith('rcp')

const cases: ReadonlyArray<CredibilityCase> = [
  {
    id: 'steady-power',
    title: 'Steady Power Operation',
    eventFamily: 'Normal full-power operation',
    description: 'Six hundred seconds without a fault should stay close to the reference operating band.',
    sourceRefs: ['iaea-ssg-2', 'leitbild-pwr-scope'],
    actions: () => [],
  },
  {
    id: 'loss-feedwater-afw',
    title: 'Loss Of Feedwater With AFW',
    eventFamily: 'NRC SRP 15.2.7 loss of normal feedwater flow',
    description: 'Main feedwater trips; auxiliary feedwater starts and should preserve a secondary heat sink.',
    sourceRefs: ['nrc-srp-ch15', 'iaea-ssg-2', 'leitbild-pwr-scope'],
    actions: system => [
      ...tripComponentsMatching(system, 60_000, 'trip-main-feedwater', isMainFeedwaterPump),
      ...componentsMatching(system, isAuxFeedwaterPump).map(component =>
        setVariable(`start-${component.id}`, 180_000, `${component.id}.running`, true),
      ),
      ...setValvePositionsMatching(system, 180_000, 'open-aux-feedwater-valve', 1, isAuxFeedwaterValve),
    ],
  },
  {
    id: 'sgtr',
    title: 'Steam Generator Tube Leak',
    eventFamily: 'NRC SRP 15.6.3 steam generator tube failure indication',
    description: 'Primary-to-secondary leakage should drain RCS inventory and produce affected-secondary radiation.',
    sourceRefs: ['nrc-srp-ch15', 'iaea-ssg-2', 'leitbild-pwr-scope'],
    actions: () => [
      setVariable('open-sg-a-tube-leak', 90_000, 'sgA.tubeLeakFraction', 0.18),
    ],
  },
  {
    id: 'small-loca',
    title: 'Small LOCA With Accumulator Response',
    eventFamily: 'NRC SRP 15.6.5 loss-of-coolant accident spectrum',
    description: 'A primary boundary leak should depressurize, send mass to containment, and actuate passive inventory support.',
    sourceRefs: ['nrc-srp-ch15', 'nrc-trace', 'iaea-ssg-2', 'leitbild-pwr-scope'],
    actions: () => [
      setVariable('open-hot-leg-a-boundary-leak', 90_000, 'rcs-hot-leg-a.leak.areaFraction', 0.45),
    ],
  },
  {
    id: 'all-rcp-trip',
    title: 'Loss Of Forced Primary Flow',
    eventFamily: 'NRC SRP 15.3.1 loss of forced reactor coolant flow',
    description: 'All reactor coolant pumps trip; loop flow should coast down and core cooling indicators should respond.',
    sourceRefs: ['nrc-srp-ch15', 'nrc-trace', 'iaea-ssg-2', 'leitbild-pwr-scope'],
    actions: system => tripComponentsMatching(system, 90_000, 'trip-rcp', isReactorCoolantPump),
  },
  {
    id: 'loss-offsite-power',
    title: 'Loss Of Offsite Power',
    eventFamily: 'NRC SRP 15.2.6 loss of nonemergency AC power',
    description: 'Offsite power is lost; emergency diesels should restore safety buses and essential loads.',
    sourceRefs: ['nrc-srp-ch15', 'iaea-ssg-2', 'leitbild-pwr-scope'],
    actions: () => [
      { id: 'loss-of-offsite-power', atMs: 90_000, type: 'lossOfOffsitePower' },
      setVariable('start-diesel-a', 110_000, 'dieselGeneratorA.startCommand', true),
      setVariable('start-diesel-b', 110_000, 'dieselGeneratorB.startCommand', true),
    ],
  },
]

const telemetryVariables = [
  'core.powerMw',
  'core.totalThermalPowerMw',
  'core.decayHeatMw',
  'core.coreCoolingAvailabilityFraction',
  'core.coreHeatRemovalDeficitMw',
  'core.fuelHeatupRateCPerS',
  'vessel.primaryCoolantInventoryKg',
  'vessel.primaryLeakFlowKgPerS',
  'vessel.safetyInjectionFlowKgPerS',
  'vessel.tubeLeakFlowKgPerS',
  'vessel-release-to-containment.flowKgPerS',
  'pressurizer.pressureMPa',
  'pressurizer.levelPercent',
  'sgA.levelPercent',
  'sgA.feedwaterFlowKgPerS',
  'sgA.steamOutflowKgPerS',
  'sgA.pressureMPa',
  'sgA.primaryToSecondaryLeakKgPerS',
  'sgA.secondaryRadiationMSvPerH',
  'rcpA.loopFlowKgPerS',
  'turbine.electricMw',
  'turbine.steamAvailabilityFraction',
  'condenser.backPressurePa',
  'containment.pressureMPa',
  'containment.incomingMassKgPerS',
  'containment.sumpInventoryKg',
  'containment.radiationSourceTermMSvPerH',
  'safetyAccumulatorA.outletFlowKgPerS',
  'safetyAccumulatorA.liquidInventoryKg',
  'motor-afw-pump-to-header.flowKgPerS',
  'aux-feedwater-valve-a-to-sg-a.flowKgPerS',
  'safetyBusA.voltageFraction',
  'safetyBusB.voltageFraction',
  'plantControlsLoadA.servedFraction',
  'plantControlsLoadB.servedFraction',
] as const satisfies ReadonlyArray<string>

const targets: ReadonlyArray<CredibilityTarget> = [
  {
    id: 'steady-pzr-pressure-band',
    caseId: 'steady-power',
    label: 'Pressurizer pressure remains in the reference operating band',
    signal: 'pressurizer.pressureMPa final value',
    expectation: 'Stable PWR operation should remain close to nominal RCS pressure.',
    measure: { kind: 'point', path: variablePath('pressurizer.pressureMPa'), atMs: durationMs },
    acceptable: { min: 14.8, max: 15.8 },
    severity: 'gate',
    sourceRefs: ['iaea-ssg-2', 'leitbild-pwr-scope'],
  },
  {
    id: 'steady-sg-level-band',
    caseId: 'steady-power',
    label: 'Steam-generator level remains controllable',
    signal: 'sgA.levelPercent final value',
    expectation: 'Normal operation should not drift toward dryout or high-level challenge.',
    measure: { kind: 'point', path: variablePath('sgA.levelPercent'), atMs: durationMs },
    acceptable: { min: 45, max: 70 },
    severity: 'gate',
    sourceRefs: ['iaea-ssg-2', 'leitbild-pwr-scope'],
  },
  {
    id: 'steady-turbine-output-band',
    caseId: 'steady-power',
    label: 'Electric output remains in the reference plant range',
    signal: 'turbine.electricMw final value',
    expectation: 'The reference plant should produce a plausible large-PWR electrical output at power.',
    measure: { kind: 'point', path: variablePath('turbine.electricMw'), atMs: durationMs },
    acceptable: { min: 650, max: 950 },
    severity: 'watch',
    sourceRefs: ['leitbild-pwr-scope'],
  },
  {
    id: 'lofw-level-decline',
    caseId: 'loss-feedwater-afw',
    label: 'Loss of feedwater visibly lowers SG level before recovery',
    signal: 'sgA.levelPercent delta from T+80s to T+170s',
    expectation: 'Normal feedwater loss should deplete secondary inventory before AFW recovery.',
    measure: { kind: 'delta', path: variablePath('sgA.levelPercent'), fromMs: 80_000, toMs: 170_000 },
    acceptable: { max: -8 },
    severity: 'gate',
    sourceRefs: ['nrc-srp-ch15', 'iaea-ssg-2'],
  },
  {
    id: 'lofw-afw-flow',
    caseId: 'loss-feedwater-afw',
    label: 'Auxiliary feedwater reaches the affected SG branch',
    signal: 'aux-feedwater-valve-a-to-sg-a.flowKgPerS max after T+190s',
    expectation: 'AFW should provide a visible secondary heat-sink recovery path.',
    measure: { kind: 'maxAfter', path: variablePath('aux-feedwater-valve-a-to-sg-a.flowKgPerS'), afterMs: 190_000 },
    acceptable: { min: 20 },
    severity: 'gate',
    sourceRefs: ['nrc-srp-ch15', 'leitbild-pwr-scope'],
  },
  {
    id: 'lofw-no-dryout',
    caseId: 'loss-feedwater-afw',
    label: 'AFW recovery avoids SG dryout in the demo window',
    signal: 'sgA.levelPercent min after T+60s',
    expectation: 'The modeled recovery should preserve a usable heat sink during the scenario.',
    measure: { kind: 'minAfter', path: variablePath('sgA.levelPercent'), afterMs: 60_000 },
    acceptable: { min: 5 },
    severity: 'gate',
    sourceRefs: ['iaea-ssg-2', 'leitbild-pwr-scope'],
  },
  {
    id: 'sgtr-leak-flow',
    caseId: 'sgtr',
    label: 'SGTR produces measurable primary-to-secondary leakage',
    signal: 'sgA.primaryToSecondaryLeakKgPerS max after T+100s',
    expectation: 'A tube leak should create an affected-SG leak path without contaminating unrelated SGs.',
    measure: { kind: 'maxAfter', path: variablePath('sgA.primaryToSecondaryLeakKgPerS'), afterMs: 100_000 },
    acceptable: { min: 40, max: 220 },
    severity: 'watch',
    sourceRefs: ['nrc-srp-ch15', 'leitbild-pwr-scope'],
  },
  {
    id: 'sgtr-primary-inventory-loss',
    caseId: 'sgtr',
    label: 'SGTR drains primary inventory',
    signal: 'vessel.primaryCoolantInventoryKg delta from T+80s to final',
    expectation: 'Primary-to-secondary leakage should produce a durable RCS inventory consequence.',
    measure: { kind: 'delta', path: variablePath('vessel.primaryCoolantInventoryKg'), fromMs: 80_000, toMs: durationMs },
    acceptable: { min: -80_000, max: -8_000 },
    severity: 'gate',
    sourceRefs: ['nrc-srp-ch15', 'iaea-ssg-2'],
  },
  {
    id: 'sgtr-radiation-indication',
    caseId: 'sgtr',
    label: 'Affected secondary radiation rises',
    signal: 'sgA.secondaryRadiationMSvPerH max after T+100s',
    expectation: 'SGTR diagnosis should be visible through affected secondary radiation.',
    measure: { kind: 'maxAfter', path: variablePath('sgA.secondaryRadiationMSvPerH'), afterMs: 100_000 },
    acceptable: { min: 20 },
    severity: 'gate',
    sourceRefs: ['nrc-srp-ch15', 'leitbild-pwr-scope'],
  },
  {
    id: 'loca-primary-release',
    caseId: 'small-loca',
    label: 'Primary boundary leak creates containment release flow',
    signal: 'vessel-release-to-containment.flowKgPerS max after T+100s',
    expectation: 'A primary-boundary break should move mass from RCS to containment.',
    measure: { kind: 'maxAfter', path: variablePath('vessel-release-to-containment.flowKgPerS'), afterMs: 100_000 },
    acceptable: { min: 50 },
    severity: 'gate',
    sourceRefs: ['nrc-srp-ch15', 'nrc-trace'],
  },
  {
    id: 'loca-containment-pressure-rise',
    caseId: 'small-loca',
    label: 'Containment pressure rises after release',
    signal: 'containment.pressureMPa delta from T+80s to final',
    expectation: 'Containment should respond thermodynamically to primary mass-energy release.',
    measure: { kind: 'delta', path: variablePath('containment.pressureMPa'), fromMs: 80_000, toMs: durationMs },
    acceptable: { min: 0.01 },
    severity: 'gate',
    sourceRefs: ['nrc-srp-ch15', 'iaea-ssg-2'],
  },
  {
    id: 'loca-accumulator-flow',
    caseId: 'small-loca',
    label: 'Accumulator injects after depressurization',
    signal: 'safetyAccumulatorA.outletFlowKgPerS max after T+100s',
    expectation: 'Passive safety injection should become visible as RCS pressure falls below the accumulator head.',
    measure: { kind: 'maxAfter', path: variablePath('safetyAccumulatorA.outletFlowKgPerS'), afterMs: 100_000 },
    acceptable: { min: 1 },
    severity: 'gate',
    sourceRefs: ['nrc-srp-ch15', 'leitbild-pwr-scope'],
  },
  {
    id: 'rcp-coastdown',
    caseId: 'all-rcp-trip',
    label: 'Forced primary flow coasts down rather than teleporting to zero',
    signal: 'rcpA.loopFlowKgPerS delta from T+88s to T+110s',
    expectation: 'RCP trip should show inertia/coastdown, not an instant hydraulic collapse.',
    measure: { kind: 'delta', path: variablePath('rcpA.loopFlowKgPerS'), fromMs: 88_000, toMs: 110_000 },
    acceptable: { min: -5_000, max: -500 },
    severity: 'gate',
    sourceRefs: ['nrc-srp-ch15', 'leitbild-pwr-scope'],
  },
  {
    id: 'rcp-cooling-availability-response',
    caseId: 'all-rcp-trip',
    label: 'Core cooling availability responds to loss of forced flow',
    signal: 'core.coreCoolingAvailabilityFraction min after T+120s',
    expectation: 'Loss of forced primary flow should be visible in core cooling diagnostics.',
    measure: { kind: 'minAfter', path: variablePath('core.coreCoolingAvailabilityFraction'), afterMs: 120_000 },
    acceptable: { min: 0.04, max: 0.35 },
    severity: 'gate',
    sourceRefs: ['nrc-srp-ch15', 'nrc-trace', 'leitbild-pwr-scope'],
  },
  {
    id: 'rcp-fuel-heatup-bounded',
    caseId: 'all-rcp-trip',
    label: 'Fuel heatup remains bounded in the demo window',
    signal: 'core.fuelHeatupRateCPerS max after T+120s',
    expectation: 'The compact model should show thermal consequence without claiming severe-accident fidelity.',
    measure: { kind: 'maxAfter', path: variablePath('core.fuelHeatupRateCPerS'), afterMs: 120_000 },
    acceptable: { min: 0.01, max: 2.0 },
    severity: 'watch',
    sourceRefs: ['nrc-trace', 'leitbild-pwr-scope'],
  },
  {
    id: 'loop-safety-bus-a-recovery',
    caseId: 'loss-offsite-power',
    label: 'Safety bus A recovers after diesel start',
    signal: 'safetyBusA.voltageFraction min after T+150s',
    expectation: 'LOOP should be visible but recover essential safety bus voltage after EDG start.',
    measure: { kind: 'minAfter', path: variablePath('safetyBusA.voltageFraction'), afterMs: 150_000 },
    acceptable: { min: 0.9 },
    severity: 'gate',
    sourceRefs: ['nrc-srp-ch15', 'leitbild-pwr-scope'],
  },
  {
    id: 'loop-safety-bus-b-recovery',
    caseId: 'loss-offsite-power',
    label: 'Safety bus B recovers after diesel start',
    signal: 'safetyBusB.voltageFraction min after T+150s',
    expectation: 'LOOP should be visible but recover redundant safety bus voltage after EDG start.',
    measure: { kind: 'minAfter', path: variablePath('safetyBusB.voltageFraction'), afterMs: 150_000 },
    acceptable: { min: 0.9 },
    severity: 'gate',
    sourceRefs: ['nrc-srp-ch15', 'leitbild-pwr-scope'],
  },
  {
    id: 'loop-essential-loads-served',
    caseId: 'loss-offsite-power',
    label: 'Essential plant-control loads remain served after recovery',
    signal: 'plantControlsLoadA.servedFraction min after T+150s',
    expectation: 'Emergency power recovery should preserve essential control loads.',
    measure: { kind: 'minAfter', path: variablePath('plantControlsLoadA.servedFraction'), afterMs: 150_000 },
    acceptable: { min: 0.99 },
    severity: 'gate',
    sourceRefs: ['nrc-srp-ch15', 'leitbild-pwr-scope'],
  },
]

const compiledSystem = (testCase: CredibilityCase): CompiledProcessPlantSystem =>
  compileProcessPlantSystem({
    id: testCase.id,
    pack: 'process-plant',
    componentLibrary: 'process-plant',
    assemblyRef: processPlantPwrReferenceAssemblyRef,
    assemblyConfig: { loopCount: 4, title: `Credibility ${testCase.title}` },
    ...(testCase.parameters === undefined ? {} : { parameters: testCase.parameters }),
    ...(testCase.initialState === undefined ? {} : { initialState: testCase.initialState }),
  })

const configs = (): ReadonlyArray<ProcessPlantMultiSystemConfig> =>
  cases.map(testCase => {
    const system = compiledSystem(testCase)
    return {
      system,
      schedule: { actions: testCase.actions(system) },
      telemetry: {
        sampleIntervalMs,
        variables: telemetryVariables.map(variablePath),
      },
    }
  })

const seriesFor = (
  telemetry: ReadonlyArray<ProcessPlantTelemetrySeries>,
  path: VariablePath,
): ProcessPlantTelemetrySeries => {
  const series = telemetry.find(candidate => candidate.path === path)
  if (!series) throw new Error(`missing PWR credibility telemetry series: ${path}`)
  return series
}

const numericValue = (series: ProcessPlantTelemetrySeries, index: number): number => {
  const point = series.points[index]
  if (!point) throw new Error(`missing PWR credibility telemetry point ${series.path} at index ${index}`)
  if (typeof point.value !== 'number') throw new Error(`PWR credibility variable is not numeric: ${series.path}`)
  return point.value
}

const valueAtOrAfter = (
  telemetry: ReadonlyArray<ProcessPlantTelemetrySeries>,
  path: VariablePath,
  elapsedMs: number,
): number => {
  const series = seriesFor(telemetry, path)
  const index = series.points.findIndex(point => point.elapsedMs >= elapsedMs)
  if (index < 0) throw new Error(`missing PWR credibility point for ${path} at ${elapsedMs}ms`)
  return numericValue(series, index)
}

const valuesAfter = (
  telemetry: ReadonlyArray<ProcessPlantTelemetrySeries>,
  path: VariablePath,
  elapsedMs: number,
): ReadonlyArray<number> => {
  const series = seriesFor(telemetry, path)
  const values = series.points
    .filter(point => point.elapsedMs >= elapsedMs)
    .map(point => {
      if (typeof point.value !== 'number') throw new Error(`PWR credibility variable is not numeric: ${path}`)
      return point.value
    })
  if (values.length === 0) throw new Error(`missing PWR credibility points for ${path} after ${elapsedMs}ms`)
  return values
}

const measureValue = (
  telemetry: ReadonlyArray<ProcessPlantTelemetrySeries>,
  measure: Measurement,
): number => {
  if (measure.kind === 'point') return valueAtOrAfter(telemetry, measure.path, measure.atMs)
  if (measure.kind === 'minAfter') return Math.min(...valuesAfter(telemetry, measure.path, measure.afterMs))
  if (measure.kind === 'maxAfter') return Math.max(...valuesAfter(telemetry, measure.path, measure.afterMs))
  return valueAtOrAfter(telemetry, measure.path, measure.toMs) - valueAtOrAfter(telemetry, measure.path, measure.fromMs)
}

const rangeContains = (value: number, range: TargetRange): boolean =>
  (range.min === undefined || value >= range.min)
  && (range.max === undefined || value <= range.max)

const evaluateTarget = (
  trace: ProcessPlantMultiSystemSnapshot,
  target: CredibilityTarget,
): TargetResult => {
  if (!trace.telemetry) throw new Error(`PWR credibility trace missing telemetry for ${trace.systemId}`)
  const observed = measureValue(trace.telemetry, target.measure)
  return {
    targetId: target.id,
    caseId: target.caseId,
    label: target.label,
    signal: target.signal,
    expectation: target.expectation,
    observed,
    acceptable: target.acceptable,
    passed: rangeContains(observed, target.acceptable),
    severity: target.severity,
    sourceRefs: target.sourceRefs,
  }
}

const traceForCase = (
  traces: ReadonlyArray<ProcessPlantMultiSystemSnapshot>,
  caseId: CaseId,
): ProcessPlantMultiSystemSnapshot => {
  const trace = traces.find(candidate => candidate.systemId === caseId)
  if (!trace) throw new Error(`missing PWR credibility trace for case: ${caseId}`)
  return trace
}

const formatRange = (range: TargetRange): string => {
  if (range.min !== undefined && range.max !== undefined) return `${range.min} to ${range.max}`
  if (range.min !== undefined) return `>= ${range.min}`
  if (range.max !== undefined) return `<= ${range.max}`
  return 'record only'
}

const svgEscape = (value: string): string =>
  value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')

const renderSvg = (
  results: ReadonlyArray<TargetResult>,
  wallMs: number,
): string => {
  const rowHeight = 34
  const grouped = cases.map(testCase => ({
    testCase,
    results: results.filter(result => result.caseId === testCase.id),
  }))
  const height = 138 + grouped.reduce((total, group) => total + 48 + group.results.length * rowHeight, 0)
  const rows = grouped.map((group, groupIndex) => {
    const groupY = 116 + grouped.slice(0, groupIndex).reduce((total, previous) => total + 48 + previous.results.length * rowHeight, 0)
    const targetRows = group.results.map((result, index) => {
      const y = groupY + 42 + index * rowHeight
      const statusColor = result.passed ? '#15803d' : result.severity === 'gate' ? '#b91c1c' : '#a16207'
      const status = result.passed ? 'PASS' : result.severity === 'gate' ? 'FAIL' : 'WATCH'
      return `
        <g transform="translate(52 ${y})">
          <rect x="0" y="-21" width="1096" height="30" rx="4" fill="${index % 2 === 0 ? '#ffffff' : '#f8fafc'}" stroke="#e5e7eb"/>
          <text x="12" y="-2" font-family="Inter, system-ui, sans-serif" font-size="12" font-weight="700" fill="${statusColor}">${status}</text>
          <text x="82" y="-2" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#111827">${svgEscape(result.label)}</text>
          <text x="590" y="-2" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#475569">obs ${result.observed.toFixed(3)} / target ${svgEscape(formatRange(result.acceptable))}</text>
        </g>`
    }).join('')
    return `
      <g>
        <text x="50" y="${groupY}" font-family="Inter, system-ui, sans-serif" font-size="18" font-weight="800" fill="#111827">${svgEscape(group.testCase.title)}</text>
        <text x="50" y="${groupY + 21}" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#64748b">${svgEscape(group.testCase.eventFamily)}</text>
        ${targetRows}
      </g>`
  }).join('')
  const failedGates = results.filter(result => !result.passed && result.severity === 'gate').length
  const failedWatch = results.filter(result => !result.passed && result.severity === 'watch').length
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="${height}" viewBox="0 0 1200 ${height}">
  <rect width="1200" height="${height}" fill="#eef2f7"/>
  <text x="50" y="42" font-family="Inter, system-ui, sans-serif" font-size="26" font-weight="800" fill="#111827">PWR Credibility Target Report</text>
  <text x="50" y="68" font-family="Inter, system-ui, sans-serif" font-size="13" fill="#475569">Source-backed target envelopes against the modular PWR assembly. Gate failures: ${failedGates}; watch misses: ${failedWatch}; wall ${wallMs.toFixed(0)}ms.</text>
  <text x="50" y="92" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#64748b">Scope: operational/training credibility, not licensing-basis safety analysis.</text>
  ${rows}
</svg>`
}

const main = async (): Promise<void> => {
  const runConfigs = configs()
  const started = performance.now()
  const traces = createProcessPlantMultiSystemTestbed(runConfigs).runFor(durationMs, stepMs)
  const wallMs = performance.now() - started
  const results = targets.map(target => evaluateTarget(traceForCase(traces, target.caseId), target))
  const failedGateTargets = results.filter(result => !result.passed && result.severity === 'gate')
  const failedWatchTargets = results.filter(result => !result.passed && result.severity === 'watch')
  const firstGraph = runConfigs[0]?.system.graph

  const summary = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    durationMs,
    stepMs,
    sampleIntervalMs,
    assemblyRef: processPlantPwrReferenceAssemblyRef,
    assemblyConfig: { loopCount: 4 },
    caseCount: cases.length,
    targetCount: targets.length,
    failedGateTargetCount: failedGateTargets.length,
    failedWatchTargetCount: failedWatchTargets.length,
    wallMs,
    realtimeFactor: durationMs * cases.length / wallMs,
    graph: firstGraph === undefined
      ? null
      : {
          componentCount: firstGraph.components.length,
          linkCount: firstGraph.links.length,
          variableCount: firstGraph.variables.length,
        },
    sourceRefs,
    cases,
    results,
    artifacts: {
      summaryJsonPath,
      reportSvgPath,
    },
  }

  await mkdir(dirname(summaryJsonPath), { recursive: true })
  await writeFile(summaryJsonPath, `${JSON.stringify(summary, null, 2)}\n`)
  await writeFile(reportSvgPath, renderSvg(results, wallMs))

  console.log(JSON.stringify({
    caseCount: summary.caseCount,
    targetCount: summary.targetCount,
    failedGateTargetCount: summary.failedGateTargetCount,
    failedWatchTargetCount: summary.failedWatchTargetCount,
    realtimeFactor: summary.realtimeFactor,
    summaryJsonPath,
    reportSvgPath,
  }, null, 2))
}

await main()
