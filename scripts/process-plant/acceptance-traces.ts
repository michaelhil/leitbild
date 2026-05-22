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
  'vessel.primaryPressureBiasMPa',
  'vessel.primaryCoolantInventoryKg',
  'pressurizer.pressureMPa',
  'pressurizer.steamMassKg',
  'pressurizer.reliefFlowKgPerS',
  'sgA.levelPercent',
  'sgA.pressureMPa',
  'sgA.steamMassKg',
  'sgA.feedwaterFlowKgPerS',
  'sgA.primaryToSecondaryLeakKgPerS',
  'sgA.secondaryRadiationMSvPerH',
  'rcpA.loopFlowKgPerS',
  'turbine.electricMw',
] as const satisfies ReadonlyArray<string>

type CaseId = 'baseline' | 'sgtr' | 'loss-feedwater' | 'rcp-trip' | 'relief-open' | 'load-reduction' | 'mixed-transient'

interface AcceptanceCase {
  readonly id: CaseId
  readonly title: string
  readonly description: string
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

const compiledSystem = (id: string) => compileProcessPlantSystem({
  id,
  pack: 'process-plant',
  componentLibrary: 'process-plant',
  graphRef: processPlantPressurizedWaterReactorGraphRef,
})

const configs = (): ReadonlyArray<ProcessPlantMultiSystemConfig> =>
  cases.map(testCase => ({
    system: compiledSystem(testCase.id),
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

const check = (
  caseId: CaseId,
  description: string,
  passed: boolean,
  details: string,
): AcceptanceCheck => ({ caseId, description, passed, details })

const nonnegativeTelemetryPaths: ReadonlySet<string> = new Set([
  'core.powerMw',
  'vessel.primaryCoolantInventoryKg',
  'pressurizer.pressureMPa',
  'pressurizer.steamMassKg',
  'pressurizer.reliefFlowKgPerS',
  'sgA.levelPercent',
  'sgA.pressureMPa',
  'sgA.steamMassKg',
  'sgA.feedwaterFlowKgPerS',
  'sgA.primaryToSecondaryLeakKgPerS',
  'sgA.secondaryRadiationMSvPerH',
  'rcpA.loopFlowKgPerS',
  'turbine.electricMw',
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
    return [
      check(caseId, 'load reduction lowers turbine output', afterElectric < beforeElectric * 0.7, `before=${beforeElectric.toFixed(1)} end=${afterElectric.toFixed(1)}MW`),
      check(caseId, 'load reduction keeps output nonnegative', minElectric >= 0, `min=${minElectric.toFixed(1)}MW`),
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
