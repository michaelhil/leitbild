import type { TilebuildConfig } from './types.ts'

// Tippecanoe subprocess wrapper. The runner is injectable so tests stub it
// without invoking the binary; the default runner spawns the real process.

export interface TippecanoeRunResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

export type TippecanoeRunner = (cmd: string, args: ReadonlyArray<string>) => Promise<TippecanoeRunResult>

export const defaultTippecanoeRunner: TippecanoeRunner = async (cmd, args) => {
  const proc = Bun.spawn([cmd, ...args], { stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  const exitCode = await proc.exited
  return { exitCode, stdout, stderr }
}

export interface BuildTilesArgs {
  readonly inputGeoJsonPath: string
  readonly outputPmtilesPath: string
  readonly config: TilebuildConfig
  readonly binary?: string
  readonly runner?: TippecanoeRunner
}

const flagArgs = (config: TilebuildConfig): string[] => {
  // Polygon-friendly defaults:
  //   --minimum-zoom / --maximum-zoom: fixed range from the dataset config.
  //   --drop-densest-as-needed: thin features when a tile would otherwise
  //     overflow the 500 KB MVT cap.
  //   --no-feature-limit: keep all 455+ ENOR polygons in a single tile when
  //     they fit, without artificial per-tile feature caps.
  //   --simplification: aggressive Douglas-Peucker (10) trims jagged airspace
  //     boundaries to keep tiles small at low zooms.
  // We DO NOT use --no-tile-size-limit or --extend-zooms-if-still-dropping:
  // for ENOR they pushed the PMTiles archive past 400 MB by extending zoom
  // well beyond globalMaxZoom and refusing to drop anything.
  const args: string[] = [
    '-o', '__placeholder__',
    '--layer', config.outputLayer,
    '--minimum-zoom', String(config.globalMinZoom),
    '--maximum-zoom', String(config.globalMaxZoom),
    '--drop-densest-as-needed',
    '--no-feature-limit',
    '--simplification', '10',
    '--force',
  ]
  return args
}

export const buildTiles = async (args: BuildTilesArgs): Promise<TippecanoeRunResult> => {
  const runner = args.runner ?? defaultTippecanoeRunner
  const binary = args.binary ?? 'tippecanoe'
  const cliArgs = flagArgs(args.config)
  // Replace the placeholder with the actual output path.
  const outIndex = cliArgs.indexOf('__placeholder__')
  cliArgs[outIndex] = args.outputPmtilesPath
  cliArgs.push(args.inputGeoJsonPath)
  const result = await runner(binary, cliArgs)
  if (result.exitCode !== 0) {
    throw new Error(`tippecanoe failed (exit ${result.exitCode}): ${result.stderr.trim() || result.stdout.trim() || '<no output>'}`)
  }
  return result
}
