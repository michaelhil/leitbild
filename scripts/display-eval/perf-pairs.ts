/** Performance pairs (plan v5 §5.8): production and a candidate stack measured alternately, so machine load falls on
 * both alike, then compared (every metric within +20 % of production).
 *
 *   bun scripts/display-eval/perf-pairs.ts --baseline=<origin>,<workspace>,<mature Run>[,<label>]
 *       [--candidate=<origin>,<workspace>,<mature Run>[,<label>]] --out=<dir> [--pairs=3] [--seconds=60] [--port=44331]
 *       [--floor-ms=0] [--max-load=6] [--wait-load=600]
 *
 * For each pair it measures the baseline, then the candidate (`perf.ts measure`: first open, deck opens, switches,
 * samples while the Run plays, main thread, pop-over or faceplate opens, bundle sizes; 1920 × 1080 with the chat
 * open), each after the machine's one-minute load average falls under `max-load` (waiting at most `wait-load` s;
 * the load is recorded either way). Then `perf.ts summarize` for each side (the median of its measurements) and
 * `perf.ts compare --baseline=<baseline summary> <candidate summary>`. Without a candidate it measures the baseline
 * `pairs` times and writes its summary only (production's reference before the candidate exists).
 *
 * Writes <out>/<label>-<n>.json, <label>-summary.json and compare.txt; exits 1 when the comparison fails. Loopback only;
 * no model is called; the mature Runs advance by `seconds` per measurement and are left paused. */
import { loadavg } from 'node:os'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'
import { loopbackOrigin, options, sleep } from './browser.ts'

interface Side { readonly origin: string; readonly workspaceId: string; readonly runId: string; readonly label: string }
const sideOf = (value: string | undefined, fallback: string): Side | null => {
  if (value === undefined) return null
  const [origin, workspaceId, runId, label] = value.split(',')
  if (origin === undefined || workspaceId === undefined || runId === undefined) throw new Error(`--${fallback}=<origin>,<workspace>,<mature Run>[,<label>]`)
  return { origin: loopbackOrigin(origin), workspaceId, runId, label: label ?? fallback }
}

const PERF = join(import.meta.dir, 'perf.ts')
const run = (args: ReadonlyArray<string>): { readonly code: number; readonly out: string } => {
  const child = Bun.spawnSync(['bun', PERF, ...args], { stdout: 'pipe', stderr: 'pipe' })
  return { code: child.exitCode ?? 1, out: child.stdout.toString() + child.stderr.toString() }
}

const quiet = async (maxLoad: number, waitS: number): Promise<number> => {
  const until = Date.now() + waitS * 1_000
  while (loadavg()[0]! > maxLoad && Date.now() < until) await sleep(10_000)
  return Math.round(loadavg()[0]! * 10) / 10
}

if (import.meta.main) {
  const argv = options(Bun.argv.slice(2))
  const baseline = sideOf(argv.get('baseline'), 'baseline')
  const candidate = sideOf(argv.get('candidate'), 'candidate')
  const out = argv.get('out')
  if (baseline === null || out === undefined) throw new Error('usage: perf-pairs.ts --baseline=… [--candidate=…] --out=<dir> (see the header)')
  mkdirSync(out, { recursive: true })
  const pairs = Number(argv.get('pairs') ?? 3)
  const maxLoad = Number(argv.get('max-load') ?? 6), waitS = Number(argv.get('wait-load') ?? 600)
  const common = [`--seconds=${argv.get('seconds') ?? 60}`, `--port=${argv.get('port') ?? 44331}`]
  const files: Record<string, string[]> = { [baseline.label]: [], ...(candidate === null ? {} : { [candidate.label]: [] }) }
  const log: string[] = []
  for (let pair = 1; pair <= pairs; pair += 1) {
    for (const side of candidate === null ? [baseline] : [baseline, candidate]) {
      const load = await quiet(maxLoad, waitS)
      const file = join(out, `${side.label}-${pair}.json`)
      const started = Date.now()
      const result = run(['measure', `--origin=${side.origin}`, `--workspace=${side.workspaceId}`, `--run=${side.runId}`, `--out=${file}`, `--label=${side.label}-${pair}`, ...common])
      const line = `pair ${pair} ${side.label}: ${result.code === 0 ? 'measured' : `FAILED (${result.out.slice(-300)})`} in ${Math.round((Date.now() - started) / 1000)} s at load ${load}`
      log.push(line)
      console.log(line)
      if (result.code === 0) files[side.label]!.push(file)
    }
  }
  const summaries: Record<string, string> = {}
  for (const [label, list] of Object.entries(files)) {
    if (list.length === 0) continue
    summaries[label] = join(out, `${label}-summary.json`)
    const summarized = run(['summarize', `--out=${summaries[label]}`, ...list])
    log.push(`${label} summary (${list.length} measurements): ${summarized.code === 0 ? summaries[label] : summarized.out.slice(-300)}`)
  }
  let pass = true
  if (candidate !== null && summaries[baseline.label] && summaries[candidate.label]) {
    const compared = run(['compare', `--baseline=${summaries[baseline.label]}`, summaries[candidate.label]!, `--floor-ms=${argv.get('floor-ms') ?? 0}`])
    pass = compared.code === 0
    log.push(`compare ${candidate.label} against ${baseline.label} (+20 % gate): ${pass ? 'PASS' : 'FAIL'}`, compared.out)
  }
  await Bun.write(join(out, 'compare.txt'), log.join('\n') + '\n')
  // The measurements were printed as they came; now the summaries and the comparison.
  console.log(log.filter(line => !line.startsWith('pair ')).join('\n'))
  process.exit(pass ? 0 : 1)
}
