import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import {
  compileProcessPlantSystem,
  createProcessPlantTelemetryRecorder,
  createProcessPlantRuntime,
  processPlantPwrReferenceAssemblyRef,
  type ProcessPlantTelemetrySeries,
  type VariablePath,
} from '../../src/packs/process-plant/index.ts'

const durationMs = 180_000
const stepMs = 100
const sampleIntervalMs = 1_000
const artifactRoot = process.env.PROCESS_PLANT_BALANCE_ARTIFACT_ROOT ?? '/private/tmp/leitbild-process-plant'
const svgPath = `${artifactRoot}/feedwater-sg-condenser-balance.svg`
const csvPath = `${artifactRoot}/feedwater-sg-condenser-balance.csv`

const variablePath = (value: string): VariablePath => value as VariablePath

const telemetryVariables = [
  'feedwaterTank.inventoryKg',
  'feedwater-tank-to-main-feedwater-pump-a.flowKgPerS',
  'feedwater-tank-to-main-feedwater-pump-b.flowKgPerS',
  'sgA.secondaryInventoryKg',
  'sgA.steamMassKg',
  'sgA.feedwaterFlowKgPerS',
  'sgA.steamFlowKgPerS',
  'sg-a-steam-to-msiv-a.flowKgPerS',
  'condenser.condensateInventoryKg',
  'condenser.condensateProductionKgPerS',
  'condenser-to-condensate-pump-a.flowKgPerS',
  'condenser-to-condensate-pump-b.flowKgPerS',
] as const satisfies ReadonlyArray<string>

interface Point {
  readonly x: number
  readonly y: number
}

interface PlotSeries {
  readonly label: string
  readonly color: string
  readonly points: ReadonlyArray<Point>
}

const seriesFor = (
  telemetry: ReadonlyArray<ProcessPlantTelemetrySeries>,
  path: string,
): ProcessPlantTelemetrySeries => {
  const series = telemetry.find(candidate => candidate.path === path)
  if (!series) throw new Error(`missing process plant balance telemetry series: ${path}`)
  return series
}

const numericPoints = (
  telemetry: ReadonlyArray<ProcessPlantTelemetrySeries>,
  path: string,
  scale: number,
): ReadonlyArray<Point> =>
  seriesFor(telemetry, path).points.map(point => {
    if (typeof point.value !== 'number') throw new Error(`balance trace variable is not numeric: ${path}`)
    return { x: point.elapsedMs / 1_000, y: point.value * scale }
  })

const combinedPoints = (
  telemetry: ReadonlyArray<ProcessPlantTelemetrySeries>,
  paths: ReadonlyArray<string>,
  scale: number,
): ReadonlyArray<Point> => {
  const sourceSeries = paths.map(path => seriesFor(telemetry, path))
  const pointCount = sourceSeries[0]?.points.length ?? 0
  return Array.from({ length: pointCount }, (_, index) => {
    const firstPoint = sourceSeries[0]?.points[index]
    if (!firstPoint) throw new Error('balance trace source series is empty')
    let total = 0
    for (const series of sourceSeries) {
      const point = series.points[index]
      if (!point) throw new Error(`balance trace series ${series.path} is shorter than its peers`)
      if (typeof point.value !== 'number') throw new Error(`balance trace variable is not numeric: ${series.path}`)
      total += point.value
    }
    return { x: firstPoint.elapsedMs / 1_000, y: total * scale }
  })
}

const svgEscape = (value: string): string =>
  value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')

const scaledPath = (
  points: ReadonlyArray<Point>,
  bounds: { readonly x: number; readonly y: number; readonly width: number; readonly height: number },
  yMin: number,
  yMax: number,
): string => {
  const ySpan = yMax - yMin
  if (ySpan <= 0) throw new Error('balance plot y span must be positive')
  return points.map((point, index) => {
    const x = bounds.x + (point.x / (durationMs / 1_000)) * bounds.width
    const y = bounds.y + bounds.height - ((point.y - yMin) / ySpan) * bounds.height
    return `${index === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`
  }).join(' ')
}

const renderPanel = (config: {
  readonly title: string
  readonly yLabel: string
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  readonly yMin: number
  readonly yMax: number
  readonly series: ReadonlyArray<PlotSeries>
}): string => {
  const plotBounds = { x: config.x + 52, y: config.y + 46, width: config.width - 76, height: config.height - 88 }
  const paths = config.series.map(series => `
    <path d="${scaledPath(series.points, plotBounds, config.yMin, config.yMax)}" fill="none" stroke="${series.color}" stroke-width="2.4"/>`).join('')
  const legend = config.series.map((series, index) => `
    <g transform="translate(${config.x + 58 + index * 188}, ${config.y + config.height - 24})">
      <line x1="0" y1="0" x2="22" y2="0" stroke="${series.color}" stroke-width="3"/>
      <text x="30" y="4" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#374151">${svgEscape(series.label)}</text>
    </g>`).join('')
  return `
    <g>
      <rect x="${config.x}" y="${config.y}" width="${config.width}" height="${config.height}" rx="12" fill="#ffffff" stroke="#d1d5db"/>
      <text x="${config.x + 24}" y="${config.y + 28}" font-family="Inter, system-ui, sans-serif" font-size="17" font-weight="700" fill="#111827">${svgEscape(config.title)}</text>
      <text x="${config.x + 24}" y="${config.y + 50}" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#6b7280">${svgEscape(config.yLabel)}</text>
      <line x1="${plotBounds.x}" y1="${plotBounds.y + plotBounds.height}" x2="${plotBounds.x + plotBounds.width}" y2="${plotBounds.y + plotBounds.height}" stroke="#9ca3af"/>
      <line x1="${plotBounds.x}" y1="${plotBounds.y}" x2="${plotBounds.x}" y2="${plotBounds.y + plotBounds.height}" stroke="#9ca3af"/>
      <text x="${plotBounds.x - 8}" y="${plotBounds.y + 4}" text-anchor="end" font-family="Inter, system-ui, sans-serif" font-size="11" fill="#6b7280">${config.yMax.toFixed(0)}</text>
      <text x="${plotBounds.x - 8}" y="${plotBounds.y + plotBounds.height + 4}" text-anchor="end" font-family="Inter, system-ui, sans-serif" font-size="11" fill="#6b7280">${config.yMin.toFixed(0)}</text>
      ${paths}
      ${legend}
    </g>`
}

const renderSvg = (telemetry: ReadonlyArray<ProcessPlantTelemetrySeries>): string => {
  const feedwaterOut = combinedPoints(telemetry, [
    'feedwater-tank-to-main-feedwater-pump-a.flowKgPerS',
    'feedwater-tank-to-main-feedwater-pump-b.flowKgPerS',
  ], 1)
  const condenserOut = combinedPoints(telemetry, [
    'condenser-to-condensate-pump-a.flowKgPerS',
    'condenser-to-condensate-pump-b.flowKgPerS',
  ], 1)
  const panels = [
    renderPanel({
      title: 'Feedwater Tank Inventory',
      yLabel: 'inventory, tonnes',
      x: 50,
      y: 80,
      width: 530,
      height: 260,
      yMin: 0,
      yMax: 900,
      series: [{
        label: 'inventory',
        color: '#2563eb',
        points: numericPoints(telemetry, 'feedwaterTank.inventoryKg', 1 / 1_000),
      }],
    }),
    renderPanel({
      title: 'Steam Generator A Balance',
      yLabel: 'inventory tonnes, flows kg/s',
      x: 620,
      y: 80,
      width: 530,
      height: 260,
      yMin: 0,
      yMax: 900,
      series: [
        {
          label: 'inventory / 100',
          color: '#0f766e',
          points: numericPoints(telemetry, 'sgA.secondaryInventoryKg', 1 / 100),
        },
        {
          label: 'steam mass / 20',
          color: '#f59e0b',
          points: numericPoints(telemetry, 'sgA.steamMassKg', 1 / 20),
        },
        {
          label: 'feedwater',
          color: '#2563eb',
          points: numericPoints(telemetry, 'sgA.feedwaterFlowKgPerS', 1),
        },
        {
          label: 'steam out',
          color: '#dc2626',
          points: numericPoints(telemetry, 'sg-a-steam-to-msiv-a.flowKgPerS', 1),
        },
      ],
    }),
    renderPanel({
      title: 'Feedwater Flow Sources',
      yLabel: 'flow kg/s',
      x: 50,
      y: 380,
      width: 530,
      height: 260,
      yMin: 0,
      yMax: 900,
      series: [
        {
          label: 'tank outflow',
          color: '#2563eb',
          points: feedwaterOut,
        },
        {
          label: 'SG A feed',
          color: '#0f766e',
          points: numericPoints(telemetry, 'sgA.feedwaterFlowKgPerS', 1),
        },
      ],
    }),
    renderPanel({
      title: 'Condenser Hotwell Balance',
      yLabel: 'inventory tonnes, flows kg/s',
      x: 620,
      y: 380,
      width: 530,
      height: 260,
      yMin: 0,
      yMax: 900,
      series: [
        {
          label: 'inventory / 100',
          color: '#7c3aed',
          points: numericPoints(telemetry, 'condenser.condensateInventoryKg', 1 / 100),
        },
        {
          label: 'production',
          color: '#0f766e',
          points: numericPoints(telemetry, 'condenser.condensateProductionKgPerS', 1),
        },
        {
          label: 'pump out',
          color: '#dc2626',
          points: condenserOut,
        },
      ],
    }),
  ].join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="700" viewBox="0 0 1200 700" role="img" aria-labelledby="title desc">
    <title id="title">Process Plant Feedwater, Steam Generator, and Condenser Balance Trace</title>
    <desc id="desc">Four process trace panels over a 180 second transient with main feedwater pump trips at T+60 seconds.</desc>
    <rect width="1200" height="700" fill="#f3f4f6"/>
    <text x="50" y="42" font-family="Inter, system-ui, sans-serif" font-size="24" font-weight="800" fill="#111827">Feedwater / SG / Condenser Balance Trace</text>
    <text x="50" y="65" font-family="Inter, system-ui, sans-serif" font-size="13" fill="#4b5563">Main feedwater pumps trip at T+60s. The plot is generated from runtime telemetry, not hand-authored data.</text>
    ${panels}
  </svg>`
}

const csvRows = (telemetry: ReadonlyArray<ProcessPlantTelemetrySeries>): string => {
  const headers = ['elapsedMs', ...telemetry.map(series => series.path)]
  const pointCount = telemetry[0]?.points.length ?? 0
  const rows = Array.from({ length: pointCount }, (_, index) => {
    const first = telemetry[0]?.points[index]
    if (!first) throw new Error('balance trace has no telemetry points')
    const values = telemetry.map(series => {
      const point = series.points[index]
      if (!point) throw new Error(`balance trace series ${series.path} is shorter than its peers`)
      return String(point.value)
    })
    return [String(first.elapsedMs), ...values].join(',')
  })
  return [headers.join(','), ...rows].join('\n')
}

const run = async (): Promise<void> => {
  const system = compileProcessPlantSystem({
    id: 'balance-trace',
    pack: 'process-plant',
    componentLibrary: 'process-plant',
    assemblyRef: processPlantPwrReferenceAssemblyRef,
    assemblyConfig: { loopCount: 4, title: 'Feedwater Balance Trace' },
  })
  const runtime = createProcessPlantRuntime({ system })
  const telemetry = createProcessPlantTelemetryRecorder({
    systemId: system.id,
    telemetry: {
      sampleIntervalMs,
      variables: telemetryVariables.map(variablePath),
    },
  })
  telemetry.recordDueSamples(runtime)

  let elapsedMs = 0
  while (elapsedMs < durationMs) {
    elapsedMs += stepMs
    if (elapsedMs === 60_000) {
      runtime.writeCommand({ type: 'setVariable', path: variablePath('mainFeedwaterPumpA.running'), value: false })
      runtime.writeCommand({ type: 'setVariable', path: variablePath('mainFeedwaterPumpB.running'), value: false })
    }
    runtime.tick(stepMs)
    telemetry.recordDueSamples(runtime)
  }

  const series = telemetry.series()
  await mkdir(dirname(svgPath), { recursive: true })
  await writeFile(svgPath, renderSvg(series))
  await writeFile(csvPath, `${csvRows(series)}\n`)
  console.log(`wrote ${svgPath}`)
  console.log(`wrote ${csvPath}`)
}

await run()
