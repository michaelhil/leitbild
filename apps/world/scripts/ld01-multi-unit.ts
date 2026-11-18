/** TEST-ONLY multi-unit driver `ld01-multi-unit` (plan r4, X5, lane MULTI): N real ld01-unit children
 * through the World host, exchanged the way the Run adapter exchanges them (sim/adapter.ts
 * exchangeNativePlantsOnce): one tick, every unit's ADVANCE at once, the tick done when the last settles.
 * Nothing here is registered in a Pack, the Runtime Hub or the deployer; it needs an artifact named on its
 * command line and changes no plant, solver, pin or criterion. Contention evidence only on macOS.
 *
 * Usage:
 *   bun scripts/ld01-multi-unit.ts --artifact <dir> --out <new dir> --units T1@5,T1@5,T1@5,T1@5 --span-s 70
 *       [--exchange-ms 100|1000] [--pace real|max] [--lead-s 2] [--via engine|adapter] [--pin-cores 2,3,4,5]
 *
 * --units  one spec per unit: H (hold), T1@<run s> (turbine trip, the graph's TG.turbineTrip), C4@<run s>
 *          (the PZR relief fails open, PZR.reliefStuckOpen). Every spec's command is written before the exchange
 *          that reaches <run s>, so specs with the same time go on the same exchange.
 * --pace   real (default): exchange k starts at t0 + k * exchange, the next one late if the last ran over;
 *          max: no waiting (maximum pace). Lag is measured against real time in both.
 * --via    engine (default): connectNativeProcessPlantEngine for each unit, the exchange in this file.
 *          adapter: the real Pack adapter (createLocalProcessPlantPackRuntimeAdapter, advanceTo, sendCommand): no
 *          per-unit reply header; per-unit rusage and the exchange wall only.
 * --pin-cores  one core per unit on Linux (taskset, -c N). macOS has no core affinity: refused here.
 *
 * What it records, per unit per exchange (`exchanges` rows, columns in the receipt): the child's own wall and CPU
 * for the ADVANCE (its reply header), the driver's send-to-reply wall, lag against real time, instructions and P-core
 * instructions (proc_pid_rusage, read from outside), runnable time, resident size and physical footprint, and
 * steps/residuals/jacobians. Instructions are the cost measure; wall clock is lag only.
 * Machine load: per-core busy every second, the load average at both ends, this run's own busy core-seconds. */
import { dlopen, FFIType, ptr, toArrayBuffer } from 'bun:ffi'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { cpus, loadavg, totalmem, freemem } from 'node:os'
import { ld01UnitArtifactEnv, loadLd01UnitArtifact, type Ld01UnitArtifact } from '../src/packs/process-plant/engine/artifact.ts'
import { connectNativeProcessPlantEngine, type NativeAdvanceReceipt, type NativeProcessPlantEngine } from '../src/packs/process-plant/engine/native-engine.ts'
import type { VariablePath } from '../src/packs/process-plant/graph/index.ts'
import { compileProcessPlant } from '../src/packs/process-plant/plant-compiler.ts'
import { createLocalProcessPlantPackRuntimeAdapter, processPlantControlWriteCommandKind } from '../src/packs/process-plant/index.ts'
import { processPlantPack } from '../src/packs/process-plant/pack.ts'
import type { ActorId, CommandEnvelope, CommandId, IsoTimestamp, OperationalObject, SimulationRunId } from '../src/core/model/index.ts'
import { createSimulationClock, type SimulationClock, type SimulationClockState } from '../src/core/model/time.ts'
import type { PackRuntimeConnection, PackRuntimeStateStore } from '../src/simulation/protocol.ts'

const quietRatio = 14.32e9
const casePaths: Readonly<Record<string, VariablePath>> = {
  T1: 'TG.turbineTrip' as VariablePath,
  C4: 'PZR.reliefStuckOpen' as VariablePath,
}
const plantDefinition = (id: string) => ({ id, model: { ref: 'process-plant.ld01', parameters: {} }, operatingPoint: { ref: 'process-plant.ld01.s3-settled' }, automation: { ref: 'process-plant.ld01.kernel' } })

interface UnitSpec { readonly text: string; readonly caseName: string | null; readonly atS: number | null }
interface Config {
  readonly artifact: string
  readonly out: string
  readonly units: ReadonlyArray<UnitSpec>
  readonly spanS: number
  readonly exchangeMs: number
  readonly pace: 'real' | 'max'
  readonly leadS: number
  readonly via: 'engine' | 'adapter'
  readonly pinCores: ReadonlyArray<number> | null
}

const parseArgs = (argv: ReadonlyArray<string>): Config => {
  const flags = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]
    const value = argv[index + 1]
    if (key === undefined || !key.startsWith('--') || value === undefined) throw new Error(`arguments are --name value pairs, at ${key ?? 'end'}`)
    flags.set(key.slice(2), value)
  }
  const required = (name: string): string => {
    const value = flags.get(name)
    if (value === undefined) throw new Error(`--${name} is required`)
    return value
  }
  const number = (name: string, fallback: number): number => {
    const value = flags.get(name)
    const parsed = value === undefined ? fallback : Number(value)
    if (!Number.isFinite(parsed)) throw new Error(`--${name} is not a number`)
    return parsed
  }
  const units = required('units').split(',').map((text): UnitSpec => {
    if (text === 'H') return { text, caseName: null, atS: null }
    const match = /^([A-Z0-9]+)@([0-9.]+)$/u.exec(text)
    if (match === null || !(match[1]! in casePaths)) throw new Error(`unit spec ${text}: H, T1@<s> or C4@<s>`)
    return { text, caseName: match[1]!, atS: Number(match[2]) }
  })
  const exchangeMs = number('exchange-ms', 100)
  if (!Number.isInteger(exchangeMs) || exchangeMs <= 0 || exchangeMs % 100 !== 0) throw new Error('--exchange-ms is a positive multiple of 100')
  const pace = flags.get('pace') ?? 'real'
  if (pace !== 'real' && pace !== 'max') throw new Error('--pace is real or max')
  const via = flags.get('via') ?? 'engine'
  if (via !== 'engine' && via !== 'adapter') throw new Error('--via is engine or adapter')
  const pinText = flags.get('pin-cores')
  const pinCores = pinText === undefined ? null : pinText.split(',').map(Number)
  if (pinCores !== null && process.platform !== 'linux') throw new Error('--pin-cores: only Linux can pin a process to a core (taskset); macOS has no core affinity')
  if (pinCores !== null && pinCores.length !== units.length) throw new Error('--pin-cores names one core per unit')
  const out = required('out')
  if (existsSync(out)) throw new Error(`--out ${out} exists: receipts are write-once`)
  return { artifact: required('artifact'), out, units, spanS: number('span-s', 60), exchangeMs, pace, leadS: number('lead-s', 2), via, pinCores }
}

/** macOS counters read from outside each child (proc_pid_rusage, rusage_info_v6). */
const machine = (() => {
  const library = process.platform === 'darwin' ? dlopen('/usr/lib/libSystem.B.dylib', {
    proc_pid_rusage: { args: [FFIType.i32, FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
    mach_timebase_info: { args: [FFIType.ptr], returns: FFIType.i32 },
    mach_host_self: { args: [], returns: FFIType.u32 },
    task_self_trap: { args: [], returns: FFIType.u32 },
    host_processor_info: { args: [FFIType.u32, FFIType.i32, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    vm_deallocate: { args: [FFIType.u32, FFIType.u64, FFIType.u64], returns: FFIType.i32 },
  }).symbols : null
  if (library === null) return { kind: 'linux' as const }
  const timebase = new Uint32Array(2)
  library.mach_timebase_info(ptr(timebase))
  const secondsPerTick = (timebase[0]! / timebase[1]!) / 1e9
  const rusageWords = 96
  const buffer = new BigUint64Array(rusageWords)
  const read = (pid: number): RusageSnapshot | null => {
    if (library.proc_pid_rusage(pid, 6, ptr(buffer)) !== 0) return null
    const word = (byteOffset: number): number => Number(buffer[byteOffset / 8]!)
    return {
      instructions: word(248), pInstructions: word(320), cycles: word(256), pCycles: word(328),
      userS: word(16) * secondsPerTick, systemS: word(24) * secondsPerTick,
      pUserS: word(304) * secondsPerTick, pSystemS: word(312) * secondsPerTick,
      runnableS: word(288) * secondsPerTick,
      residentBytes: word(64), footprintBytes: word(72), lifetimeMaxFootprintBytes: word(240),
    }
  }
  const host = library.mach_host_self()
  const task = library.task_self_trap()
  const count = new Uint32Array(1), array = new BigUint64Array(1), arrayCount = new Uint32Array(1)
  /** Per-core ticks [user, system, idle, nice] since boot. */
  const coreTicks = (): Uint32Array => {
    if (library.host_processor_info(host, 2, ptr(count), ptr(array), ptr(arrayCount)) !== 0) throw new Error('host_processor_info failed')
    const address = Number(array[0]!)
    const words = arrayCount[0]!
    const ticks = new Uint32Array(toArrayBuffer(address as never, 0, words * 4).slice(0))
    library.vm_deallocate(task, BigInt(address), BigInt(words * 4))
    return ticks
  }
  return { kind: 'darwin' as const, read, coreTicks, secondsPerTick }
})()

interface RusageSnapshot {
  readonly instructions: number
  readonly pInstructions: number
  readonly cycles: number
  readonly pCycles: number
  readonly userS: number
  readonly systemS: number
  readonly pUserS: number
  readonly pSystemS: number
  readonly runnableS: number
  readonly residentBytes: number
  readonly footprintBytes: number
  readonly lifetimeMaxFootprintBytes: number
}
const counters = (pid: number): RusageSnapshot | null => (machine.kind === 'darwin' ? machine.read(pid) : null)

const childPids = (): ReadonlyArray<number> => {
  const listed = Bun.spawnSync(['/usr/bin/pgrep', '-P', String(process.pid)]).stdout.toString().trim()
  return listed.length === 0 ? [] : listed.split('\n').map(Number)
}

/** Per-core busy fraction sampled every second (macOS); the run's window busy core-seconds. */
const createLoadSampler = () => {
  const samples: Array<{ readonly tS: number; readonly busy: ReadonlyArray<number>; readonly load1: number }> = []
  if (machine.kind !== 'darwin') return { samples, stop: () => {} }
  const startedAt = performance.now()
  const coreCount = cpus().length
  let last = machine.coreTicks()
  const sample = (): void => {
    const now = machine.coreTicks()
    const busy: number[] = []
    for (let core = 0; core < coreCount; core += 1) {
      const delta = (state: number): number => (now[core * 4 + state]! - last[core * 4 + state]!) >>> 0
      const used = delta(0) + delta(1) + delta(3)
      const idle = delta(2)
      busy.push(used + idle === 0 ? 0 : used / (used + idle))
    }
    samples.push({ tS: (performance.now() - startedAt) / 1_000, busy, load1: loadavg()[0]! })
    last = now
  }
  const timer = setInterval(sample, 1_000)
  return { samples, stop: () => clearInterval(timer) }
}

/** Rows per unit per exchange. */
const columns = ['k', 't_unit_s', 'adv_wall_s', 'adv_cpu_s', 'exchange_wall_s', 'lag_s', 'instructions', 'p_instructions', 'cycles', 'p_cycles', 'user_s', 'system_s', 'p_user_s', 'p_system_s', 'runnable_s', 'resident_bytes', 'footprint_bytes', 'steps', 'residuals', 'jacobians', 'restarts_r', 'restarts_s'] as const
type Row = readonly number[]

const delta = (after: RusageSnapshot | null, before: RusageSnapshot | null, key: keyof RusageSnapshot): number =>
  after === null || before === null ? Number.NaN : after[key] - before[key]

interface UnitRecord {
  readonly index: number
  readonly plantId: string
  readonly spec: UnitSpec
  pid: number
  connectCost: { readonly wallS: number; readonly cpuS: number } | null
  readonly rows: Row[]
  /** [unit time of the frame, cumulative instructions]: the ld01-cost judge's input. */
  readonly frameInstructions: Array<readonly [number, number]>
  readonly instants: Array<{ readonly t_s: number; readonly class: string }>
  readonly hasher: InstanceType<typeof Bun.CryptoHasher>
  readonly eventsHasher: InstanceType<typeof Bun.CryptoHasher>
  firstFrameT: number
  commandT: number | null
  failure: string | null
  ended: string | null
  last: RusageSnapshot | null
  first: RusageSnapshot | null
}

const newRecord = (index: number, spec: UnitSpec): UnitRecord => ({
  index, plantId: `plant:ld01-multi-${index}`, spec, pid: 0, connectCost: null, rows: [], frameInstructions: [], instants: [],
  hasher: new Bun.CryptoHasher('sha256'), eventsHasher: new Bun.CryptoHasher('sha256'),
  firstFrameT: Number.NaN, commandT: null, failure: null, ended: null, last: null, first: null,
})

/** One unit's reply folded into its record: the same rows whichever transport produced it. */
const noteFrame = (record: UnitRecord, k: number, frame: NativeAdvanceReceipt['frame'], cost: NativeAdvanceReceipt['cost'], sentAt: number, doneAt: number, lagS: number, stepS: number): void => {
  const after = counters(record.pid)
  const before = record.last
  record.last = after
  if (record.first === null) record.first = before
  if (frame === null) return
  record.hasher.update(new Uint8Array(frame.values.buffer, frame.values.byteOffset, frame.values.byteLength))
  const tBytes = new Uint8Array(new Float64Array([frame.t]).buffer)
  record.hasher.update(tBytes)
  if (frame.events !== null) record.eventsHasher.update(JSON.stringify(frame.events))
  if (Number.isNaN(record.firstFrameT)) {
    record.firstFrameT = frame.t
    if (after !== null) record.frameInstructions.push([frame.t - stepS, before?.instructions ?? after.instructions])
  }
  const events = frame.events as { readonly instants?: ReadonlyArray<readonly [number, string, ReadonlyArray<string>]> } | null
  for (const instant of events?.instants ?? []) record.instants.push({ t_s: instant[0], class: instant[1] })
  const counts = frame.counts
  record.rows.push([
    k, frame.t, cost.wallS, cost.cpuS, (doneAt - sentAt) / 1_000, lagS,
    delta(after, before, 'instructions'), delta(after, before, 'pInstructions'), delta(after, before, 'cycles'), delta(after, before, 'pCycles'),
    delta(after, before, 'userS'), delta(after, before, 'systemS'), delta(after, before, 'pUserS'), delta(after, before, 'pSystemS'), delta(after, before, 'runnableS'),
    after?.residentBytes ?? Number.NaN, after?.footprintBytes ?? Number.NaN,
    Number(counts.steps), Number(counts.residuals), Number(counts.jacobians), Number(counts.r_instants), Number(counts.s_instants),
  ])
  if (after !== null) record.frameInstructions.push([frame.t, after.instructions])
}

/** Writes the judge input for one unit: `run.ou_frame_instructions`, the same field the harness records. */
const judgeReceipt = (record: UnitRecord, stepS: number) => ({
  case: record.spec.text,
  timeline: record.commandT === null ? {} : { zero_s: record.commandT },
  run: {
    case: record.spec.text,
    configuration: { case_configuration: { jump_diagnostic: false, cost_excludes_case_observer: true } },
    ou_frame_instructions: record.frameInstructions,
    instants: record.instants,
  },
  frame_s: stepS,
})

const summarize = (record: UnitRecord, stepS: number): Record<string, unknown> => {
  const rows = record.rows
  const c = (name: typeof columns[number]): number => columns.indexOf(name)
  const worst = (name: typeof columns[number]): { readonly value: number; readonly k: number } => {
    let value = -Infinity
    let k = -1
    for (const row of rows) {
      if (row[c(name)]! > value) { value = row[c(name)]!; k = row[0]! }
    }
    return { value, k }
  }
  const instructionsPerSecond = rows.map(row => row[c('instructions')]! / quietRatio / stepS)
  let worstFive = 0
  let worstFiveAt = 0
  for (let index = 0; index + 5 <= instructionsPerSecond.length; index += 1) {
    const mean = instructionsPerSecond.slice(index, index + 5).reduce((sum, value) => sum + value, 0) / 5
    if (mean > worstFive) { worstFive = mean; worstFiveAt = rows[index]![0]! }
  }
  const sum = (name: typeof columns[number]): number => rows.reduce((total, row) => total + (Number.isNaN(row[c(name)]!) ? 0 : row[c(name)]!), 0)
  const lagging = rows.filter(row => row[c('lag_s')]! > 0).length
  const worstWall = worst('adv_wall_s')
  const worstExchange = worst('exchange_wall_s')
  const worstInstructions = worst('instructions')
  const rss = rows.map(row => row[c('resident_bytes')]!)
  const footprint = rows.map(row => row[c('footprint_bytes')]!)
  const totalInstructions = sum('instructions')
  return {
    unit: record.index,
    spec: record.spec.text,
    frames: rows.length,
    frames_sha256: record.hasher.copy().digest('hex'),
    events_sha256: record.eventsHasher.copy().digest('hex'),
    failure: record.failure,
    ended: record.ended,
    wall_is_lag_only: {
      worst_advance_wall_s: worstWall.value,
      worst_advance_wall_at_k: worstWall.k,
      worst_advance_wall_over_real_time: worstWall.value / stepS,
      worst_exchange_wall_s: worstExchange.value,
      worst_exchange_wall_at_k: worstExchange.k,
      worst_lag_s: worst('lag_s').value,
      frames_lagging: lagging,
      adv_wall_p99_s: percentile(rows.map(row => row[c('adv_wall_s')]!), 0.99),
      adv_wall_median_s: percentile(rows.map(row => row[c('adv_wall_s')]!), 0.5),
    },
    instructions_are_cost: {
      total_g: totalInstructions / 1e9,
      worst_frame_g: worstInstructions.value / 1e9,
      worst_frame_at_k: worstInstructions.k,
      worst_frame_quiet_cpu_per_s: worstInstructions.value / quietRatio / stepS,
      worst_0_5_s_quiet_cpu_per_s: worstFive,
      worst_0_5_s_at_k: worstFiveAt,
      p_core_instruction_share: totalInstructions === 0 ? null : sum('p_instructions') / totalInstructions,
    },
    cpu_s_total_by_rusage: sum('user_s') + sum('system_s'),
    cpu_s_total_by_child_header: sum('adv_cpu_s'),
    runnable_wait_s_total: sum('runnable_s'),
    connect: record.connectCost,
    resident_bytes: { first: rss[0] ?? null, max: Math.max(...rss), last: rss.at(-1) ?? null },
    footprint_bytes: { first: footprint[0] ?? null, max: Math.max(...footprint), last: footprint.at(-1) ?? null },
    steps_total: sum('steps'), jacobians_total: sum('jacobians'), restarts_r_total: sum('restarts_r'),
  }
}

const percentile = (values: ReadonlyArray<number>, q: number): number => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? Number.NaN
}

const stringifyError = (error: unknown): string => (error instanceof Error ? error.message : String(error))

const connectEngine = async (config: Config, artifact: Ld01UnitArtifact, record: UnitRecord): Promise<NativeProcessPlantEngine> => {
  const pinned = config.pinCores === null ? [artifact.binary] : ['taskset', '-c', String(config.pinCores[record.index]), artifact.binary]
  const before = new Set(childPids())
  const engine = await connectNativeProcessPlantEngine({
    plant: compileProcessPlant(plantDefinition(record.plantId) as never),
    tagMap: artifact.tagMap, load: artifact.load, artifactSha256: artifact.manifestSha256, command: pinned,
    onFailure: failure => { record.failure = failure.reason },
  })
  const added = childPids().filter(pid => !before.has(pid))
  if (added.length !== 1) throw new Error(`connecting unit ${record.index} added ${added.length} child processes: ${added.join(',')}`)
  record.pid = added[0]!
  record.connectCost = engine.connectCost
  record.last = counters(record.pid)
  return engine
}

const runEngines = async (config: Config, artifact: Ld01UnitArtifact, records: ReadonlyArray<UnitRecord>): Promise<Record<string, unknown>> => {
  const engines: NativeProcessPlantEngine[] = []
  for (const record of records) engines.push(await connectEngine(config, artifact, record))
  const load = createLoadSampler()
  const hostAtStart = counters(process.pid)
  const exchanges: Array<readonly number[]> = []
  const stepMs = config.exchangeMs
  const stepS = stepMs / 1_000
  const count = Math.round(config.spanS * 1_000 / stepMs)
  const t0 = performance.now() + config.leadS * 1_000
  let commanded = false
  const refusals: string[] = []
  try {
    for (let k = 0; k < count; k += 1) {
      const scheduled = t0 + k * stepMs
      if (config.pace === 'real') {
        const wait = scheduled - performance.now()
        if (wait > 0) await Bun.sleep(wait)
      }
      // The commands due at this exchange: queued on every unit before any sends, so they go out on the same exchange.
      for (const [index, record] of records.entries()) {
        const { spec } = record
        if (spec.caseName !== null && spec.atS !== null && record.commandT === null && k === Math.round(spec.atS * 1_000 / stepMs)) {
          record.commandT = Number.NaN // set from the frame below
          engines[index]!.runtime.writeCommand({ type: 'setVariable', path: casePaths[spec.caseName]!, value: true })
          commanded = true
        }
      }
      const startedAt = performance.now()
      const deadline = t0 + (k + 1) * stepMs
      const settled = await Promise.allSettled(records.map(async (record, index) => {
        const engine = engines[index]!
        // The engine forms `requested + advanceMs` and goes to the last frame at or before it; adding exactly stepMs can
        // fall short of the next frame by rounding (no exchange this tick, two frames the next). Keep the request on the
        // next frame instant so every tick is one exchange of `exchangeMs`; the unit makes the same steps either way.
        // Past a named end the Run's time goes on and the unit's does not, so the correction no longer applies.
        const onGrid = engine.ended() === null ? stepMs + (engine.runtime.elapsedMs() - engine.runtime.advancedMs()) + 1e-4 : stepMs
        const sentAt = performance.now()
        const receipt = await engine.advance(onGrid)
        const doneAt = performance.now()
        if (Number.isNaN(record.commandT) && receipt.frame !== null) record.commandT = receipt.frame.t - stepS
        noteFrame(record, k, receipt.frame, receipt.cost, sentAt, doneAt, Math.max(0, (doneAt - deadline) / 1_000), stepS)
        const ended = engine.ended()
        if (ended !== null) record.ended = ended.reason
      }))
      const endedAt = performance.now()
      exchanges.push([k, (scheduled - t0) / 1_000, (startedAt - t0) / 1_000, (endedAt - t0) / 1_000, Math.max(0, (endedAt - deadline) / 1_000)])
      const refused = settled.flatMap((outcome, index) => outcome.status === 'rejected' ? [`unit ${index}: ${stringifyError(outcome.reason)}`] : [])
      if (refused.length > 0) {
        for (const line of refused) console.error(line)
        refusals.push(...refused)
        break
      }
    }
  } finally {
    load.stop()
    for (const engine of engines) await engine.close().catch(() => undefined)
  }
  const hostAtEnd = counters(process.pid)
  return { exchanges_columns: ['k', 'scheduled_s', 'started_s', 'ended_s', 'overrun_s'], exchanges, commanded, refusals, load: load.samples, host_cpu_s: hostAtStart === null || hostAtEnd === null ? null : (hostAtEnd.userS + hostAtEnd.systemS) - (hostAtStart.userS + hostAtStart.systemS), host_instructions_g: hostAtStart === null || hostAtEnd === null ? null : (hostAtEnd.instructions - hostAtStart.instructions) / 1e9 }
}

// The real Pack adapter path: per-unit rusage and the exchange wall, no reply header.
const memoryStore = (): PackRuntimeStateStore => {
  let state: unknown | null = null
  return { load: async () => state, save: async next => { state = structuredClone(next) } } as PackRuntimeStateStore
}
const runAdapter = async (config: Config, records: ReadonlyArray<UnitRecord>): Promise<Record<string, unknown>> => {
  process.env[ld01UnitArtifactEnv] = config.artifact
  const startsAt = '2026-01-01T09:00:00.000Z'
  const simulationRunId = 'run:ld01-multi' as SimulationRunId
  const objects: OperationalObject[] = records.map(record => {
    const expanded = processPlantPack.scenario!.expandItem({ ...plantDefinition(record.plantId), pack: 'process-plant', type: 'plant', label: record.plantId, location: [10.4, 59.9 + 0.01 * record.index] } as never, { at: startsAt } as never) as { objects: OperationalObject[] }
    return expanded.objects[0]!
  })
  const clock: SimulationClock = createSimulationClock({ currentTime: startsAt as IsoTimestamp, updatedAt: '2026-01-01T09:00:00.000Z' as IsoTimestamp, paused: true })
  const before = new Set(childPids())
  const connection: PackRuntimeConnection = await createLocalProcessPlantPackRuntimeAdapter().connect({
    simulationRunId,
    scenario: { scenarioId: 'ld01-multi', runtimeIds: ['process-plant.local'], connections: [], world: { startsAt }, initialObjects: objects, runtimeConfig: {} } as never,
    runtimeStateStore: memoryStore(),
    runClock: clock,
  })
  const added = childPids().filter(pid => !before.has(pid))
  if (added.length !== records.length) throw new Error(`the adapter started ${added.length} children for ${records.length} units`)
  records.forEach((record, index) => { record.pid = added[index]!; record.last = counters(record.pid) })
  const load = createLoadSampler()
  const exchanges: Array<readonly number[]> = []
  const stepMs = config.exchangeMs
  const count = Math.round(config.spanS * 1_000 / stepMs)
  const t0 = performance.now() + config.leadS * 1_000
  const hostAtStart = counters(process.pid)
  let commanded = false
  let failed: string | null = null
  try {
    for (let k = 0; k < count; k += 1) {
      const scheduled = t0 + k * stepMs
      if (config.pace === 'real') {
        const wait = scheduled - performance.now()
        if (wait > 0) await Bun.sleep(wait)
      }
      for (const record of records) {
        const { spec } = record
        if (spec.caseName !== null && spec.atS !== null && record.commandT === null && k === Math.round(spec.atS * 1_000 / stepMs)) {
          record.commandT = k * stepMs / 1_000
          const envelope = { id: `command:${record.plantId}:${k}` as CommandId, simulationRunId, actorId: 'actor:human:multi' as ActorId, kind: processPlantControlWriteCommandKind, targetObjectIds: [], issuedAt: startsAt as IsoTimestamp, payload: { plantId: record.plantId, path: casePaths[spec.caseName]!, value: true } } satisfies CommandEnvelope
          await connection.sendCommand(envelope, { origin: 'person' })
          commanded = true
        }
      }
      const startedAt = performance.now()
      const beforeAdvance = records.map(record => counters(record.pid))
      const next: SimulationClockState = { ...clock.read(), currentTime: new Date(Date.parse(clock.read().currentTime) + stepMs).toISOString() as IsoTimestamp }
      try {
        await connection.advanceTo!(next)
      } catch (error) {
        failed = stringifyError(error)
        break
      }
      clock.set(next)
      const endedAt = performance.now()
      const deadline = t0 + (k + 1) * stepMs
      records.forEach((record, index) => {
        const after = counters(record.pid)
        const prior = beforeAdvance[index] ?? null
        record.rows.push([
          k, (k + 1) * stepMs / 1_000, Number.NaN, Number.NaN, (endedAt - startedAt) / 1_000, Math.max(0, (endedAt - deadline) / 1_000),
          delta(after, prior, 'instructions'), delta(after, prior, 'pInstructions'), delta(after, prior, 'cycles'), delta(after, prior, 'pCycles'),
          delta(after, prior, 'userS'), delta(after, prior, 'systemS'), delta(after, prior, 'pUserS'), delta(after, prior, 'pSystemS'), delta(after, prior, 'runnableS'),
          after?.residentBytes ?? Number.NaN, after?.footprintBytes ?? Number.NaN, Number.NaN, Number.NaN, Number.NaN, Number.NaN, Number.NaN,
        ])
        if (record.first === null) record.first = prior
        record.last = after
      })
      exchanges.push([k, (scheduled - t0) / 1_000, (startedAt - t0) / 1_000, (endedAt - t0) / 1_000, Math.max(0, (endedAt - deadline) / 1_000)])
    }
  } finally {
    load.stop()
    await connection.close()
  }
  const hostAtEnd = counters(process.pid)
  return { exchanges_columns: ['k', 'scheduled_s', 'started_s', 'ended_s', 'overrun_s'], exchanges, commanded, failed, via_adapter: true, load: load.samples, host_cpu_s: hostAtStart === null || hostAtEnd === null ? null : (hostAtEnd.userS + hostAtEnd.systemS) - (hostAtStart.userS + hostAtStart.systemS), host_instructions_g: hostAtStart === null || hostAtEnd === null ? null : (hostAtEnd.instructions - hostAtStart.instructions) / 1e9 }
}

const main = async (): Promise<void> => {
  const config = parseArgs(Bun.argv.slice(2))
  mkdirSync(config.out, { recursive: true })
  process.env[ld01UnitArtifactEnv] = config.artifact
  const artifact = loadLd01UnitArtifact(config.artifact)
  const records = config.units.map((spec, index) => newRecord(index, spec))
  const startedIso = new Date().toISOString()
  const loadAtStart = loadavg()
  const memoryAtStart = { totalBytes: totalmem(), freeBytes: freemem() }
  const stepS = config.exchangeMs / 1_000
  const run = config.via === 'engine' ? await runEngines(config, artifact, records) : await runAdapter(config, records)
  const load = run.load as ReadonlyArray<{ readonly tS: number; readonly busy: ReadonlyArray<number>; readonly load1: number }>
  const coreBusyMean = load.length === 0 ? [] : load[0]!.busy.map((_, core) => load.reduce((sum, sample) => sum + sample.busy[core]!, 0) / load.length)
  const summaries = records.map(record => summarize(record, stepS))
  const receipt = {
    format: 'ld01-multi-unit-run', basis: 'NOT-EVIDENCE: contention on this host only; instructions are cost, wall clock is lag', platform: process.platform,
    config: { ...config, units: config.units.map(unit => unit.text) }, artifact_manifest_sha256: artifact.manifestSha256, started_iso: startedIso, ended_iso: new Date().toISOString(),
    columns, units: records.map(record => ({ index: record.index, spec: record.spec.text, pid: record.pid, command_t_s: record.commandT, connect_cost: record.connectCost, first_frame_t_s: record.firstFrameT, rows: record.rows })),
    run: { ...run, load: undefined }, load_samples: load, core_busy_mean: coreBusyMean, load_at_start: loadAtStart, load_at_end: loadavg(), memory_at_start: memoryAtStart, memory_at_end: { totalBytes: totalmem(), freeBytes: freemem() },
    summaries,
  }
  writeFileSync(join(config.out, 'run.json'), `${JSON.stringify(receipt)}\n`)
  for (const record of records) writeFileSync(join(config.out, `unit-${record.index}.judge.json`), `${JSON.stringify(judgeReceipt(record, stepS))}\n`)
  const printable = { out: config.out, via: config.via, units: config.units.map(unit => unit.text), exchange_ms: config.exchangeMs, pace: config.pace, load_start: loadAtStart[0], load_end: loadavg()[0], core_busy_mean: coreBusyMean.map(value => Number(value.toFixed(3))), host_cpu_s: run.host_cpu_s, host_instructions_g: run.host_instructions_g, exchanges: (run.exchanges as ReadonlyArray<unknown>).length, summaries }
  console.log(JSON.stringify(printable, null, 1))
  // A run that ended on a failure has its receipt written first; the exit code still says it failed.
  if (records.some(record => record.failure !== null) || (run as { failed?: string | null }).failed || ((run as { refusals?: ReadonlyArray<string> }).refusals ?? []).length > 0) process.exit(1)
  process.exit(0)
}

await main()
