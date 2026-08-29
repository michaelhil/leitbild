import { mkdir, writeFile } from 'node:fs/promises'
import { cpus, hostname, platform, release } from 'node:os'
import { dirname } from 'node:path'
import {
  compileProcessPlantSystem,
  createProcessPlantMultiSystemTestbed,
  processPlantPwrReferenceAssemblyRef,
  type ProcessPlantMultiSystemConfig,
  type ProcessPlantTelemetrySeries,
  type VariablePath,
} from '../../src/packs/process-plant/index.ts'

interface BenchmarkResult {
  readonly label: string
  readonly systemCount: number
  readonly componentCount: number
  readonly linkCount: number
  readonly variableCount: number
  readonly simulatedMs: number
  readonly wallMs: number
  readonly wallMsSamples: ReadonlyArray<number>
  readonly realtimeFactor: number
}

interface BenchmarkEnvironment {
  readonly hostname: string
  readonly platform: string
  readonly release: string
  readonly bunVersion: string
  readonly cpuCount: number
  readonly cpuModel: string
}

const durationMs = 300_000
const stepMs = 1_000
const sampleIntervalMs = 5_000
const artifactRoot = process.env.PROCESS_PLANT_BENCHMARK_ARTIFACT_ROOT ?? 'docs/assets'
const shouldWriteArtifacts = process.env.PROCESS_PLANT_BENCHMARK_WRITE_ARTIFACTS !== 'false'
const shouldWriteCsvTrace = process.env.PROCESS_PLANT_BENCHMARK_WRITE_CSV === '1'
const minRealtimeFactor = Number(process.env.PROCESS_PLANT_BENCHMARK_MIN_REALTIME_FACTOR ?? 20)
const traceSvgPath = `${artifactRoot}/process-plant-six-unit-trace.svg`
const traceCsvPath = `${artifactRoot}/process-plant-six-unit-trace.csv`
const performanceJsonPath = `${artifactRoot}/process-plant-six-unit-performance.json`

if (!Number.isFinite(minRealtimeFactor) || minRealtimeFactor <= 0) {
  throw new Error('PROCESS_PLANT_BENCHMARK_MIN_REALTIME_FACTOR must be a positive number when provided')
}

const telemetryVariables = [
  'core.powerMw',
  'sgA.levelPercent',
  'turbine.electricMw',
] as const satisfies ReadonlyArray<string>

const variablePath = (value: string): VariablePath => value as VariablePath

const compiledSystem = (id: string) => compileProcessPlantSystem({
  id,
  pack: 'process-plant',
  componentLibrary: 'process-plant',
  assemblyRef: processPlantPwrReferenceAssemblyRef,
  assemblyConfig: { loopCount: 4, title: `Benchmark ${id}` },
})

const telemetryConfig = {
  sampleIntervalMs,
  variables: telemetryVariables.map(variablePath),
}

const unitConfigs = (): ReadonlyArray<ProcessPlantMultiSystemConfig> => [
  {
    system: compiledSystem('unit-1'),
    telemetry: telemetryConfig,
    schedule: { actions: [] },
  },
  {
    system: compiledSystem('unit-2'),
    telemetry: telemetryConfig,
    schedule: {
      actions: [{
        id: 'unit-2-rcp-a-trip',
        atMs: 60_000,
        type: 'tripComponent',
        componentId: 'rcpA' as never,
      }],
    },
  },
  {
    system: compiledSystem('unit-3'),
    telemetry: telemetryConfig,
    schedule: {
      actions: [{
        id: 'unit-3-rcp-b-trip',
        atMs: 120_000,
        type: 'tripComponent',
        componentId: 'rcpB' as never,
      }],
    },
  },
  {
    system: compiledSystem('unit-4'),
    telemetry: telemetryConfig,
    schedule: {
      actions: [
        {
          id: 'unit-4-feed-pump-a-trip',
          atMs: 180_000,
          type: 'tripComponent',
          componentId: 'mainFeedwaterPumpA' as never,
        },
        {
          id: 'unit-4-feed-pump-b-trip',
          atMs: 180_000,
          type: 'tripComponent',
          componentId: 'mainFeedwaterPumpB' as never,
        },
      ],
    },
  },
  {
    system: compiledSystem('unit-5'),
    telemetry: telemetryConfig,
    schedule: {
      actions: [{
        id: 'unit-5-load-reduction',
        atMs: 90_000,
        type: 'setVariable',
        path: variablePath('turbine.loadFraction'),
        value: 0.45,
      }],
    },
  },
  {
    system: compiledSystem('unit-6'),
    telemetry: telemetryConfig,
    schedule: {
      actions: [
        {
          id: 'unit-6-rcp-c-trip',
          atMs: 150_000,
          type: 'tripComponent',
          componentId: 'rcpC' as never,
        },
        {
          id: 'unit-6-feed-pump-a-trip',
          atMs: 240_000,
          type: 'tripComponent',
          componentId: 'mainFeedwaterPumpA' as never,
        },
      ],
    },
  },
]

const median = (values: ReadonlyArray<number>): number => {
  if (values.length === 0) throw new Error('cannot calculate median of an empty benchmark sample')
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.floor(sorted.length / 2)]!
}

const runBenchmarkOnce = (
  label: string,
  configs: ReadonlyArray<ProcessPlantMultiSystemConfig>,
): { readonly result: BenchmarkResult; readonly traces: ReturnType<ReturnType<typeof createProcessPlantMultiSystemTestbed>['runFor']> } => {
  const started = performance.now()
  const traces = createProcessPlantMultiSystemTestbed(configs).runFor(durationMs, stepMs)
  const wallMs = performance.now() - started
  const graph = configs[0]?.system.graph
  if (!graph) throw new Error('process plant benchmark requires at least one system')
  return {
    traces,
    result: {
      label,
      systemCount: configs.length,
      componentCount: graph.components.length * configs.length,
      linkCount: graph.links.length * configs.length,
      variableCount: graph.variables.length * configs.length,
      simulatedMs: durationMs,
      wallMs,
      wallMsSamples: [wallMs],
      realtimeFactor: durationMs / wallMs,
    },
  }
}

const runBenchmark = (
  label: string,
  configFactory: () => ReadonlyArray<ProcessPlantMultiSystemConfig>,
): { readonly result: BenchmarkResult; readonly traces: ReturnType<ReturnType<typeof createProcessPlantMultiSystemTestbed>['runFor']> } => {
  const repeatCount = 3
  runBenchmarkOnce(label, configFactory())
  const runs = Array.from({ length: repeatCount }, () => runBenchmarkOnce(label, configFactory()))
  const wallMsSamples = runs.map(run => run.result.wallMs)
  const selected = runs.at(-1)
  if (!selected) throw new Error('benchmark produced no measured runs')
  const wallMs = median(wallMsSamples)
  return {
    traces: selected.traces,
    result: {
      ...selected.result,
      wallMs,
      wallMsSamples,
      realtimeFactor: durationMs / wallMs,
    },
  }
}

const seriesFor = (
  telemetry: ReadonlyArray<ProcessPlantTelemetrySeries>,
  path: string,
): ProcessPlantTelemetrySeries => {
  const series = telemetry.find(candidate => candidate.path === path)
  if (!series) throw new Error(`missing process plant benchmark telemetry series: ${path}`)
  return series
}

const numericPoints = (
  telemetry: ReadonlyArray<ProcessPlantTelemetrySeries>,
  path: string,
): ReadonlyArray<{ readonly x: number; readonly y: number }> =>
  seriesFor(telemetry, path).points.map(point => {
    if (typeof point.value !== 'number') throw new Error(`benchmark plot variable is not numeric: ${path}`)
    return { x: point.elapsedMs / 1_000, y: point.value }
  })

const scaledPath = (
  points: ReadonlyArray<{ readonly x: number; readonly y: number }>,
  bounds: { readonly x: number; readonly y: number; readonly width: number; readonly height: number },
  yMin: number,
  yMax: number,
): string => {
  const span = yMax - yMin
  if (span <= 0) throw new Error('benchmark plot y-axis span must be positive')
  return points.map((point, index) => {
    const x = bounds.x + (point.x / (durationMs / 1_000)) * bounds.width
    const y = bounds.y + bounds.height - ((point.y - yMin) / span) * bounds.height
    return `${index === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`
  }).join(' ')
}

const svgEscape = (value: string): string =>
  value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')

const renderSvg = (
  traces: ReturnType<ReturnType<typeof createProcessPlantMultiSystemTestbed>['runFor']>,
  performance: ReadonlyArray<BenchmarkResult>,
): string => {
  const width = 1200
  const height = 760
  const panelWidth = 350
  const panelHeight = 185
  const xStart = 70
  const yStart = 92
  const gapX = 35
  const gapY = 55
  const coreColor = '#2563eb'
  const levelColor = '#0f766e'
  const turbineColor = '#dc2626'
  const panels = traces.map((trace, index) => {
    if (!trace.telemetry) throw new Error(`benchmark trace ${trace.systemId} has no telemetry`)
    const col = index % 3
    const row = Math.floor(index / 3)
    const bounds = {
      x: xStart + col * (panelWidth + gapX),
      y: yStart + row * (panelHeight + gapY),
      width: panelWidth,
      height: panelHeight,
    }
    const core = numericPoints(trace.telemetry, 'core.powerMw')
    const level = numericPoints(trace.telemetry, 'sgA.levelPercent')
    const turbine = numericPoints(trace.telemetry, 'turbine.electricMw')
    return `
      <g>
        <rect x="${bounds.x - 12}" y="${bounds.y - 36}" width="${bounds.width + 24}" height="${bounds.height + 56}" rx="10" fill="#ffffff" stroke="#d1d5db"/>
        <text x="${bounds.x}" y="${bounds.y - 14}" font-family="Inter, system-ui, sans-serif" font-size="16" font-weight="700" fill="#111827">${svgEscape(trace.systemId)}</text>
        <line x1="${bounds.x}" y1="${bounds.y + bounds.height}" x2="${bounds.x + bounds.width}" y2="${bounds.y + bounds.height}" stroke="#9ca3af"/>
        <line x1="${bounds.x}" y1="${bounds.y}" x2="${bounds.x}" y2="${bounds.y + bounds.height}" stroke="#9ca3af"/>
        <path d="${scaledPath(core, bounds, 2500, 3200)}" fill="none" stroke="${coreColor}" stroke-width="2.4"/>
        <path d="${scaledPath(level, bounds, 45, 65)}" fill="none" stroke="${levelColor}" stroke-width="2.4"/>
        <path d="${scaledPath(turbine, bounds, 0, 1000)}" fill="none" stroke="${turbineColor}" stroke-width="2.4"/>
        <text x="${bounds.x}" y="${bounds.y + bounds.height + 16}" font-family="Inter, system-ui, sans-serif" font-size="11" fill="#6b7280">T+0 to T+300s</text>
      </g>`
  }).join('')
  const single = performance.find(result => result.label === 'single-unit')
  const multiSystem = performance.find(result => result.label === 'six-system')
  if (!single || !multiSystem) throw new Error('benchmark performance summary is incomplete')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title desc">
  <title id="title">Multi-system process plant benchmark trace</title>
  <desc id="desc">A two by three grid of process variable traces for six independently scheduled process plant units.</desc>
  <rect width="100%" height="100%" fill="#f8fafc"/>
  <text x="70" y="38" font-family="Inter, system-ui, sans-serif" font-size="22" font-weight="700" fill="#111827">Multi-system process plant benchmark</text>
  <text x="70" y="62" font-family="Inter, system-ui, sans-serif" font-size="13" fill="#4b5563">Single system ${single.wallMs.toFixed(1)} ms; six systems ${multiSystem.wallMs.toFixed(1)} ms; wall-clock ratio ${(multiSystem.wallMs / single.wallMs).toFixed(2)}x; simulated ${durationMs / 1000}s.</text>
  ${panels}
  <g font-family="Inter, system-ui, sans-serif" font-size="13" fill="#374151">
    <line x1="70" y1="640" x2="100" y2="640" stroke="${coreColor}" stroke-width="3"/><text x="110" y="644">Core power MW, scaled 2500-3200</text>
    <line x1="330" y1="640" x2="360" y2="640" stroke="${levelColor}" stroke-width="3"/><text x="370" y="644">SG A level %, scaled 45-65</text>
    <line x1="610" y1="640" x2="640" y2="640" stroke="${turbineColor}" stroke-width="3"/><text x="650" y="644">Turbine electric MW, scaled 0-1000</text>
  </g>
</svg>
`
}

const renderCsv = (
  traces: ReturnType<ReturnType<typeof createProcessPlantMultiSystemTestbed>['runFor']>,
): string => {
  const rows = ['systemId,seconds,corePowerMw,sgALevelPercent,turbineElectricMw']
  for (const trace of traces) {
    if (!trace.telemetry) throw new Error(`benchmark trace ${trace.systemId} has no telemetry`)
    const core = numericPoints(trace.telemetry, 'core.powerMw')
    const level = numericPoints(trace.telemetry, 'sgA.levelPercent')
    const turbine = numericPoints(trace.telemetry, 'turbine.electricMw')
    for (const [index, point] of core.entries()) {
      rows.push([
        trace.systemId,
        point.x.toFixed(0),
        point.y.toFixed(2),
        level[index]?.y.toFixed(2) ?? '',
        turbine[index]?.y.toFixed(2) ?? '',
      ].join(','))
    }
  }
  return `${rows.join('\n')}\n`
}

const benchmarkEnvironment = (): BenchmarkEnvironment => {
  const firstCpu = cpus()[0]
  return {
    hostname: hostname(),
    platform: platform(),
    release: release(),
    bunVersion: Bun.version,
    cpuCount: cpus().length,
    cpuModel: firstCpu?.model ?? 'unknown',
  }
}

const main = async (): Promise<void> => {
  const oneUnit = runBenchmark('single-unit', () => [unitConfigs()[0]!])
  const sixUnit = runBenchmark('six-system', unitConfigs)
  const performance = [oneUnit.result, sixUnit.result]
  if (shouldWriteArtifacts) {
    await mkdir(dirname(traceSvgPath), { recursive: true })
    await writeFile(traceSvgPath, renderSvg(sixUnit.traces, performance), 'utf8')
    if (shouldWriteCsvTrace) await writeFile(traceCsvPath, renderCsv(sixUnit.traces), 'utf8')
    await writeFile(performanceJsonPath, `${JSON.stringify(performance, null, 2)}\n`, 'utf8')
  }
  const slowResults = performance.filter(result => result.realtimeFactor < minRealtimeFactor)
  if (slowResults.length > 0) {
    const details = slowResults.map(result => `${result.label}=${result.realtimeFactor.toFixed(1)}x`).join(', ')
    throw new Error(`process plant benchmark below realtime guardrail ${minRealtimeFactor.toFixed(1)}x: ${details}`)
  }
  console.log(JSON.stringify({
    environment: benchmarkEnvironment(),
    minRealtimeFactor,
    artifacts: shouldWriteArtifacts
      ? {
          traceSvgPath,
          ...(shouldWriteCsvTrace ? { traceCsvPath } : {}),
          performanceJsonPath,
        }
      : null,
    performance,
  }, null, 2))
}

await main()
