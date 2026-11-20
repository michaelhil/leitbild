/** TEST-ONLY multi-unit driver `ld01-multi-unit` (plan r4, X5, lanes MULTI and SOAK): N real ld01-unit children
 * through the World host, exchanged the way the Run adapter exchanges them (sim/adapter.ts
 * exchangeNativePlantsOnce): one tick, every unit's ADVANCE at once, the tick done when the last settles.
 * Nothing here is registered in a Pack, the Runtime Hub or the deployer; it needs an artifact named on its
 * command line and changes no plant, solver, pin or criterion. Contention evidence only on macOS.
 *
 * Usage:
 *   bun scripts/ld01-multi-unit.ts --artifact <dir> --out <new dir> --units T1@5,T1@5,T1@5,T1@5 --span-s 70
 *       [--exchange-ms 100|1000] [--pace real|max] [--lead-s 2] [--via engine|adapter] [--grid on|off] [--pin-cores 2,3,4,5]
 *       [--rollup-s 60 --stop-file <path> [--channel-log-s 600] [--exchange-rows on|off]]
 *
 * --units  one spec per unit: H (hold), T1@<run s> (turbine trip, the graph's TG.turbineTrip), C4@<run s>
 *          (the PZR relief fails open, PZR.reliefStuckOpen). Every spec's command is written before the exchange
 *          that reaches <run s>, so specs with the same time go on the same exchange.
 * --pace   real (default): exchange k starts at t0 + k * exchange, the next one late if the last ran over;
 *          max: no waiting (maximum pace). Lag is measured against real time in both.
 * --via    engine (default): connectNativeProcessPlantEngine for each unit, the exchange in this file.
 *          adapter: the Halden four-unit Scenario (src/scenarios/halden-power-complex) with its Plants made LD-01,
 *          compiled by the World's Scenario compiler and run through the World's runtime hub: the real Pack adapters,
 *          each tick an exact advancement followed by the Run's commit of every emission to every Pack (the
 *          maximum-pace slice of core/simulation-runs/runtime.ts), paced here. No per-unit reply header: a unit's
 *          ADVANCE wall is its CPU plus runnable time over the tick (proc_pid_rusage), the tick's wall bounds it.
 * --grid   on (adapter only): the Scenario's Electric Grid and its Electrical Connections, so each unit takes the
 *          World Grid's boundary at its exchanges as the live Pack does (R4-GRID). Off (default): no Grid.
 * --pin-cores  one core per unit on Linux (taskset, -c N). macOS has no core affinity: refused here.
 *
 * Soak recording (plan-x5 soak rule r2), with --rollup-s, --via adapter only (macOS: its counters and machine
 * protection read macOS):
 * - rollups.ndjson: per unit per rollup interval: frames, worst and p99 unit wall, worst tick wall, worst lag,
 *   frames lagging, worst-frame and total instructions, CPU, resident and footprint at the interval's end, the
 *   worst admission valve position and opening, the Tavg range, the worst |e| of the rod law's own error, the frames
 *   outside its dead band and those not corrected by the bank, the bank range, the machine's mean busy and load.
 * - channels.ndjson: per unit every --channel-log-s (and at the start and the stop): the channels the drift line names.
 * - worst.json: per unit the 200 worst frames by unit wall and by instructions, each with its machine-load sample.
 * - start.json (at connect: each unit's composition read from its delivered channels, the rod line's numbers) and
 *   run.json (at the stop, with each unit's rod and valve lines, soak rule r2 amendment A7. Rod: e = LD01.CORE.BANK.ERROR,
 *   the law's own error; every AUTO frame |e| ≤ deadBand_K or the bank's travel over the interval its decision is in force
 *   reduces |e|; every frame |e| < maximumSpeedError_K; the bank moves at least once; both numbers from the wiki block
 *   ld01-rod-control the unit reads. Valve: LD01.TG.ADM.OPENING < 1 every frame, with the worst LD01.TG.ADM.POS).
 * It stops, keeps every receipt and restarts nothing on: a unit's failure (child death, refused exchange, the 10 s
 * ADVANCE limit, time-stopped), a named end, a refused advance, the stop file (checked once per rollup interval),
 * machine protection (free disk under 2 GiB, or memory pressure critical for 60 s: r2 A1, the Mac), or the span's end.
 * --exchange-rows on keeps the per-exchange rows in run.json as well (off by default with --rollup-s).
 *
 * What it records, per unit per exchange (`exchanges` rows, columns in the receipt): the child's own wall and CPU
 * for the ADVANCE (its reply header), the driver's send-to-reply wall, lag against real time, instructions and P-core
 * instructions (proc_pid_rusage, read from outside), runnable time, resident size and physical footprint, and
 * steps/residuals/jacobians. Instructions are the cost measure; wall clock is lag only.
 * Machine load: per-core busy every second, the load average at both ends, this run's own busy core-seconds. */
import { dlopen, FFIType, ptr, toArrayBuffer } from 'bun:ffi'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statfsSync, statSync, writeFileSync } from 'node:fs'
import { basename, join, relative } from 'node:path'
import { cpus, loadavg, totalmem, freemem } from 'node:os'
import { ld01UnitArtifactEnv, loadLd01UnitArtifact, type Ld01UnitArtifact } from '../src/packs/process-plant/engine/artifact.ts'
import { connectNativeProcessPlantEngine, type NativeAdvanceReceipt, type NativeProcessPlantEngine } from '../src/packs/process-plant/engine/native-engine.ts'
import type { VariablePath } from '../src/packs/process-plant/graph/index.ts'
import { compileProcessPlant } from '../src/packs/process-plant/plant-compiler.ts'
import { createLocalProcessPlantPackRuntimeAdapter, processPlantControlWriteCommandKind } from '../src/packs/process-plant/index.ts'
import { processPlantPack } from '../src/packs/process-plant/pack.ts'
import { electricGridPack } from '../src/packs/electric-grid/pack.ts'
import { createLocalElectricGridPackRuntimeAdapter } from '../src/packs/electric-grid/sim/adapter.ts'
import type { ActorId, CommandEnvelope, CommandId, EventId, IsoTimestamp, SimulationRunEvent, SimulationRunId } from '../src/core/model/index.ts'
import { createSimulationClock, type SimulationClock, type SimulationClockState } from '../src/core/model/time.ts'
import { compileScenarioDefinition } from '../src/core/scenarios/compiler.ts'
import { createScenarioRuntimeResolver } from '../src/core/scenarios/runtime-resolver.ts'
import { createDirectRoutingAdapter } from '../src/routing/direct-adapter.ts'
import { builtinScenarioDefinitions } from '../src/scenarios/definitions.ts'
import type { PackRuntimeConnection } from '../src/simulation/protocol.ts'
import { unrestrictedQueryReadPolicy } from '../src/simulation/query-read-policy.ts'
import { createRuntimeHub } from '../src/simulation/runtime-hub.ts'
import { configurationBlock } from './reference-design-source-laws.ts'

const quietRatio = 14.32e9
const casePaths: Readonly<Record<string, VariablePath>> = {
  T1: 'TG.turbineTrip' as VariablePath,
  C4: 'PZR.reliefStuckOpen' as VariablePath,
}
const plantDefinition = (id: string) => ({ id, model: { ref: 'process-plant.ld01', parameters: {} }, operatingPoint: { ref: 'process-plant.ld01.s3-settled' }, automation: { ref: 'process-plant.ld01.kernel' } })
/** The Scenario the adapter path runs: Halden's four bays, the Grid that connects them, its Electrical Connections. */
const haldenScenarioId = 'halden-power-complex'
/** Soak rule r2's data limits and machine protection. */
const worstKept = 200
const diskFloorBytes = 2 * 2 ** 30
/** r2 amendment A1 (owner, 18 Nov), the Mac only: memory pressure at critical (level 4), held for 60 s, stops the run. */
const pressureStop = { sysctl: 'kern.memorystatus_vm_pressure_level', level: 4, name: 'critical', heldS: 60 } as const

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
  readonly grid: boolean
  readonly pinCores: ReadonlyArray<number> | null
  /** Soak recording: the rollup interval (s), or null for none. */
  readonly rollupS: number | null
  readonly channelLogS: number
  readonly stopFile: string | null
  readonly exchangeRows: boolean
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
  const onOff = (name: string, fallback: 'on' | 'off'): boolean => {
    const value = flags.get(name) ?? fallback
    if (value !== 'on' && value !== 'off') throw new Error(`--${name} is on or off`)
    return value === 'on'
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
  const grid = onOff('grid', 'off')
  if (grid && via !== 'adapter') throw new Error('--grid on runs through the World host: --via adapter')
  const pinText = flags.get('pin-cores')
  const pinCores = pinText === undefined ? null : pinText.split(',').map(Number)
  if (pinCores !== null && process.platform !== 'linux') throw new Error('--pin-cores: only Linux can pin a process to a core (taskset); macOS has no core affinity')
  if (pinCores !== null && pinCores.length !== units.length) throw new Error('--pin-cores names one core per unit')
  if (pinCores !== null && via === 'adapter') throw new Error('--pin-cores: the adapter starts its own children')
  const rollupS = flags.has('rollup-s') ? number('rollup-s', 60) : null
  const channelLogS = number('channel-log-s', 600)
  const stopFile = flags.get('stop-file') ?? null
  if (rollupS === null && (flags.has('channel-log-s') || stopFile !== null || flags.has('exchange-rows'))) throw new Error('--channel-log-s, --stop-file and --exchange-rows belong to soak recording: --rollup-s')
  if (rollupS !== null) {
    if (via !== 'adapter') throw new Error('--rollup-s: the soak runs through the World host: --via adapter')
    if (process.platform !== 'darwin') throw new Error('--rollup-s: its counters and machine protection read macOS (proc_pid_rusage, kern.memorystatus_vm_pressure_level); Linux collection is plan-x5 B')
    for (const [name, seconds] of [['rollup-s', rollupS], ['channel-log-s', channelLogS]] as const) {
      if (!(seconds > 0) || Math.round(seconds * 1_000) % exchangeMs !== 0) throw new Error(`--${name} is a positive whole number of exchanges`)
    }
    if (stopFile === null) throw new Error('--rollup-s needs --stop-file: the named file whose presence closes the run')
    if (existsSync(stopFile)) throw new Error(`--stop-file ${stopFile} exists already`)
  }
  const out = required('out')
  if (existsSync(out)) throw new Error(`--out ${out} exists: receipts are write-once`)
  return {
    artifact: required('artifact'), out, units, spanS: number('span-s', 60), exchangeMs, pace, leadS: number('lead-s', 2), via, grid, pinCores,
    rollupS, channelLogS, stopFile, exchangeRows: onOff('exchange-rows', rollupS === null ? 'on' : 'off'),
  }
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
    sysctlbyname: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u64], returns: FFIType.i32 },
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
  const pressureName = Buffer.from('kern.memorystatus_vm_pressure_level\0')
  const pressureValue = new Int32Array(1), pressureSize = new BigUint64Array(1)
  /** The kernel's memory pressure level: 1 normal, 2 warn, 4 critical. */
  const memoryPressure = (): number => {
    pressureSize[0] = 4n
    if (library.sysctlbyname(ptr(pressureName), ptr(pressureValue), ptr(pressureSize), null, 0n) !== 0) throw new Error('sysctl kern.memorystatus_vm_pressure_level failed')
    return pressureValue[0]!
  }
  return { kind: 'darwin' as const, read, coreTicks, memoryPressure, secondsPerTick }
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

interface LoadSample { readonly tS: number; readonly busy: ReadonlyArray<number>; readonly load1: number; readonly pressure: number }

/**
 * Per-core busy fraction and the memory pressure level sampled every second (macOS). It keeps every sample only
 * when asked (the per-exchange receipt); a soak keeps the latest, each rollup interval's mean busy, and how long the
 * pressure has stood at the stop's level (pressureStop) or above.
 */
const createLoadSampler = (keep: boolean) => {
  const samples: LoadSample[] = []
  let latest: LoadSample | null = null
  let intervalBusy = 0
  let intervalCount = 0
  let pressureSince: number | null = null
  if (machine.kind !== 'darwin') return { samples, latest: () => latest, interval: () => ({ busyMean: Number.NaN, load1: loadavg()[0]! }), pressureHeldS: () => 0, stop: () => {} }
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
    const tS = (performance.now() - startedAt) / 1_000
    latest = { tS, busy, load1: loadavg()[0]!, pressure: machine.memoryPressure() }
    if (keep) samples.push(latest)
    intervalBusy += busy.reduce((sum, value) => sum + value, 0) / busy.length
    intervalCount += 1
    pressureSince = latest.pressure >= pressureStop.level ? pressureSince ?? tS : null
    last = now
  }
  const timer = setInterval(sample, 1_000)
  return {
    samples,
    latest: () => latest,
    /** The mean busy over the cores since the last call, and the load now; resets the interval. */
    interval: () => {
      const result = { busyMean: intervalCount === 0 ? Number.NaN : intervalBusy / intervalCount, load1: loadavg()[0]! }
      intervalBusy = 0
      intervalCount = 0
      return result
    },
    /** Seconds the pressure has stood at the stop's level or above, by the samples (0 when it is below). */
    pressureHeldS: () => (pressureSince === null || latest === null ? 0 : latest.tS - pressureSince + 1),
    stop: () => clearInterval(timer),
  }
}
type LoadSampler = ReturnType<typeof createLoadSampler>

/** Rows per unit per exchange. */
const columns = ['k', 't_unit_s', 'adv_wall_s', 'adv_cpu_s', 'exchange_wall_s', 'lag_s', 'instructions', 'p_instructions', 'cycles', 'p_cycles', 'user_s', 'system_s', 'p_user_s', 'p_system_s', 'runnable_s', 'resident_bytes', 'footprint_bytes', 'steps', 'residuals', 'jacobians', 'restarts_r', 'restarts_s'] as const
type Row = readonly number[]
const c = (name: typeof columns[number]): number => columns.indexOf(name)

const delta = (after: RusageSnapshot | null, before: RusageSnapshot | null, key: keyof RusageSnapshot): number =>
  after === null || before === null ? Number.NaN : after[key] - before[key]

/** A unit's ADVANCE wall for a frame: its reply header, or (adapter) its CPU plus runnable time over the tick. */
const unitWall = (row: Row): number => {
  const header = row[c('adv_wall_s')]!
  return Number.isNaN(header) ? row[c('user_s')]! + row[c('system_s')]! + row[c('runnable_s')]! : header
}

/** One frame's soak readings: the admission valve (its 1 % reading and its opening), Tavg in the rod law's form, the law's own error and its
 * temperature part, the bank and whether AUTO is in force (no HOLD). */
interface FrameReading { readonly admPos: number; readonly opening: number; readonly tavg: number; readonly lawError: number; readonly tavgMinusTref: number; readonly bank: number; readonly auto: boolean }

/** The rod law's two numbers the line judges by (ld01-rod-control, as the unit reads it). */
export interface RodLaw { readonly deadBandK: number; readonly maximumSpeedErrorK: number }

/**
 * The frames between a frame's decision and the start of the travel it puts in force: the AUTO law samples at frame k and the rate it
 * decides there is set at frame k + 1 (R4-ROD-DELAY, operating water-ffi unit/rod_control.rs `RodClient::frame`: "the rate decided at
 * frame k-1 acts now"), so frame k's decision moves the bank over k + 1 -> k + 2 (SOAK7's diag-l8b-1 measured the same).
 */
export const rodDecisionLagFrames = 1

/**
 * Soak rule r2's rod line with amendment A7. e is the law's own error (LD01.CORE.BANK.ERROR: Tavg − Tref plus the power-mismatch term).
 * An AUTO frame passes when |e| ≤ deadBand_K, or when the bank's travel over the interval its decision is in force (from frame
 * k + lag to k + lag + 1) has the sign that reduces |e| (withdraws for e < 0, inserts for e > 0). Every frame also needs
 * |e| < maximumSpeedError_K, and the bank must move at least once. Frames under HOLD are counted, not judged.
 */
export const createRodLine = (law: RodLaw, lag = rodDecisionLagFrames) => {
  // The last lag + 2 frames: the oldest is judged once the travel over its in-force interval is known.
  const recent: Array<{ readonly k: number; readonly e: number; readonly bank: number; readonly auto: boolean }> = []
  const totals = { framesRead: 0, notAuto: 0, outsideBand: 0, notCorrecting: 0, atOrOverMaximum: 0, worstAbsE: -Infinity, worstAtK: -1, bankMin: Infinity, bankMax: -Infinity }
  let interval = { outsideBand: 0, notCorrecting: 0 }
  let firstMove: { readonly k: number; readonly direction: 'withdraw' | 'insert'; readonly fromM: number; readonly toM: number } | null = null
  return {
    note: (k: number, e: number, bank: number, auto = true): void => {
      totals.framesRead += 1
      const size = Math.abs(e)
      if (size > totals.worstAbsE) { totals.worstAbsE = size; totals.worstAtK = k }
      if (!(size < law.maximumSpeedErrorK)) totals.atOrOverMaximum += 1
      totals.bankMin = Math.min(totals.bankMin, bank)
      totals.bankMax = Math.max(totals.bankMax, bank)
      const previous = recent.at(-1)
      if (previous !== undefined && firstMove === null && bank !== previous.bank) firstMove = { k, direction: bank > previous.bank ? 'withdraw' : 'insert', fromM: previous.bank, toM: bank }
      recent.push({ k, e, bank, auto })
      if (recent.length < lag + 2) return
      const judged = recent.shift()!
      if (!judged.auto) { totals.notAuto += 1; return }
      if (Math.abs(judged.e) <= law.deadBandK) return
      totals.outsideBand += 1
      interval.outsideBand += 1
      // recent[i] is frame judged.k + 1 + i: the in-force interval runs from frame k + lag to k + lag + 1.
      const travel = recent[lag]!.bank - (lag === 0 ? judged.bank : recent[lag - 1]!.bank)
      if (!(travel !== 0 && Math.sign(travel) === -Math.sign(judged.e))) { totals.notCorrecting += 1; interval.notCorrecting += 1 }
    },
    /** The counts judged since the last call (a frame is judged once its decision's travel interval has passed). */
    takeInterval: (): { readonly outsideBand: number; readonly notCorrecting: number } => {
      const taken = interval
      interval = { outsideBand: 0, notCorrecting: 0 }
      return taken
    },
    summary: (frames: number) => {
      const unjudged = recent.filter(frame => frame.auto && Math.abs(frame.e) > law.deadBandK).length
      const bankMoved = totals.bankMax > totals.bankMin
      return {
        dead_band_k: law.deadBandK, maximum_speed_error_k: law.maximumSpeedErrorK, e: 'LD01.CORE.BANK.ERROR', decision_lag_frames: lag, frames, frames_read: totals.framesRead,
        frames_not_auto: totals.notAuto, frames_outside_band: totals.outsideBand, frames_outside_band_not_correcting: totals.notCorrecting,
        frames_at_or_over_maximum_speed_error: totals.atOrOverMaximum, final_frames_outside_band_unjudged: unjudged,
        worst_abs_e_k: totals.worstAbsE, worst_at_k: totals.worstAtK, first_bank_move: firstMove, bank_min: totals.bankMin, bank_max: totals.bankMax, bank_moved: bankMoved,
        holds: totals.framesRead === frames && totals.notCorrecting === 0 && totals.atOrOverMaximum === 0 && unjudged === 0 && bankMoved,
      }
    },
  }
}
type RodLine = ReturnType<typeof createRodLine>

/**
 * r2's valve line with amendment A7: the governor's admission opening at full precision (LD01.TG.ADM.OPENING, a fraction, 1 fully open)
 * stays below its full-open stop every frame. The 1 % indication LD01.TG.ADM.POS is reported with its worst value.
 */
export const createValveLine = () => {
  const totals = { framesRead: 0, atOrOverStop: 0, worstOpening: -Infinity, worstOpeningAtK: -1, worstPosition: -Infinity, worstPositionAtK: -1 }
  return {
    note: (k: number, opening: number, position: number): void => {
      totals.framesRead += 1
      if (opening > totals.worstOpening) { totals.worstOpening = opening; totals.worstOpeningAtK = k }
      if (position > totals.worstPosition) { totals.worstPosition = position; totals.worstPositionAtK = k }
      if (!(opening < 1)) totals.atOrOverStop += 1
    },
    summary: (frames: number) => ({
      opening: 'LD01.TG.ADM.OPENING', frames, frames_read: totals.framesRead, frames_at_or_over_stop: totals.atOrOverStop,
      worst_opening: totals.worstOpening, worst_opening_at_k: totals.worstOpeningAtK, worst_adm_pos: totals.worstPosition, worst_adm_pos_at_k: totals.worstPositionAtK,
      holds: totals.framesRead === frames && totals.atOrOverStop === 0,
    }),
  }
}
type ValveLine = ReturnType<typeof createValveLine>

interface Extreme { value: number; k: number }
const highest = (): Extreme => ({ value: -Infinity, k: -1 })
const raise = (extreme: Extreme, value: number, k: number): void => { if (value > extreme.value) { extreme.value = value; extreme.k = k } }

/** The rollup interval's running figures for one unit. */
const newInterval = () => ({ frames: 0, walls: [] as number[], exchangeWorst: 0, lagWorst: 0, lagging: 0, instructionsWorst: 0, instructions: 0, cpuS: 0, admWorst: -Infinity, openingWorst: -Infinity, tavgMin: Infinity, tavgMax: -Infinity, rodErrorWorst: -Infinity, bankMin: Infinity, bankMax: -Infinity })

/** A worst-frame entry: the frame and the machine-load sample standing when it was noted. */
const worstColumns = ['k', 't_unit_s', 'unit_wall_s', 'exchange_wall_s', 'lag_s', 'instructions', 'p_instructions', 'cpu_s', 'runnable_s', 'load_t_s', 'load1', 'memory_pressure', 'core_busy'] as const
type WorstEntry = readonly [number, number, number, number, number, number, number, number, number, number, number, number, ReadonlyArray<number>]
const keepWorst = (list: WorstEntry[], entry: WorstEntry, by: number): void => {
  list.push(entry)
  if (list.length >= 2 * worstKept) {
    list.sort((a, b) => (b[by] as number) - (a[by] as number))
    list.length = worstKept
  }
}
const worstOf = (list: ReadonlyArray<WorstEntry>, by: number): ReadonlyArray<WorstEntry> => [...list].sort((a, b) => (b[by] as number) - (a[by] as number)).slice(0, worstKept)

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
  /** Whole-run figures, kept per frame whether or not the rows are. */
  frames: number
  lastT: number
  readonly wallWorst: Extreme
  readonly exchangeWorst: Extreme
  readonly lagWorst: Extreme
  lagging: number
  readonly instructionsWorst: Extreme
  readonly fiveWorst: Extreme
  readonly five: number[]
  readonly admWorst: Extreme
  /** The rod line (A2), fed every frame read; null without the rod law's numbers (not a soak). */
  readonly rodLine: RodLine | null
  /** The valve line (A7), fed every frame read; null when the rod line is (not a soak). */
  readonly valveLine: ValveLine | null
  totals: { instructions: number; pInstructions: number; userS: number; systemS: number; cpuHeaderS: number; runnableS: number; steps: number; jacobians: number; restartsR: number }
  readonly resident: { first: number | null; max: number; last: number | null }
  readonly footprint: { first: number | null; max: number; last: number | null }
  interval: ReturnType<typeof newInterval>
  readonly byWall: WorstEntry[]
  readonly byInstructions: WorstEntry[]
}

const newRecord = (index: number, spec: UnitSpec, plantId: string, law: RodLaw | null): UnitRecord => ({
  index, plantId, spec, pid: 0, connectCost: null, rows: [], frameInstructions: [], instants: [],
  hasher: new Bun.CryptoHasher('sha256'), eventsHasher: new Bun.CryptoHasher('sha256'),
  firstFrameT: Number.NaN, commandT: null, failure: null, ended: null, last: null, first: null,
  frames: 0, lastT: Number.NaN, wallWorst: highest(), exchangeWorst: highest(), lagWorst: highest(), lagging: 0, instructionsWorst: highest(), fiveWorst: highest(), five: [], admWorst: highest(), rodLine: law === null ? null : createRodLine(law), valveLine: law === null ? null : createValveLine(),
  totals: { instructions: 0, pInstructions: 0, userS: 0, systemS: 0, cpuHeaderS: 0, runnableS: 0, steps: 0, jacobians: 0, restartsR: 0 },
  resident: { first: null, max: -Infinity, last: null }, footprint: { first: null, max: -Infinity, last: null },
  interval: newInterval(), byWall: [], byInstructions: [],
})

const finiteOr0 = (value: number): number => (Number.isFinite(value) ? value : 0)

/** Every frame's row enters here: the whole-run figures, the rollup interval, the worst lists, and the rows if kept. */
const noteRow = (config: Config, load: LoadSampler, record: UnitRecord, row: Row, reading: FrameReading | null): void => {
  if (config.exchangeRows) record.rows.push(row)
  const k = row[0]!
  const stepS = config.exchangeMs / 1_000
  const wall = unitWall(row)
  const exchangeWall = row[c('exchange_wall_s')]!
  const lag = row[c('lag_s')]!
  const instructions = row[c('instructions')]!
  const cpuS = row[c('user_s')]! + row[c('system_s')]!
  record.frames += 1
  record.lastT = row[c('t_unit_s')]!
  raise(record.wallWorst, wall, k)
  raise(record.exchangeWorst, exchangeWall, k)
  raise(record.lagWorst, lag, k)
  if (lag > 0) record.lagging += 1
  raise(record.instructionsWorst, instructions, k)
  record.five.push(instructions / quietRatio / stepS)
  if (record.five.length > 5) record.five.shift()
  if (record.five.length === 5) raise(record.fiveWorst, record.five.reduce((sum, value) => sum + value, 0) / 5, k - 4)
  const totals = record.totals
  totals.instructions += finiteOr0(instructions)
  totals.pInstructions += finiteOr0(row[c('p_instructions')]!)
  totals.userS += finiteOr0(row[c('user_s')]!)
  totals.systemS += finiteOr0(row[c('system_s')]!)
  totals.cpuHeaderS += finiteOr0(row[c('adv_cpu_s')]!)
  totals.runnableS += finiteOr0(row[c('runnable_s')]!)
  totals.steps += finiteOr0(row[c('steps')]!)
  totals.jacobians += finiteOr0(row[c('jacobians')]!)
  totals.restartsR += finiteOr0(row[c('restarts_r')]!)
  for (const [kept, value] of [[record.resident, row[c('resident_bytes')]!], [record.footprint, row[c('footprint_bytes')]!]] as const) {
    if (Number.isNaN(value)) continue
    kept.first ??= value
    kept.max = Math.max(kept.max, value)
    kept.last = value
  }
  if (reading !== null) {
    raise(record.admWorst, reading.admPos, k)
    record.rodLine?.note(k, reading.lawError, reading.bank, reading.auto)
    record.valveLine?.note(k, reading.opening, reading.admPos)
  }
  if (config.rollupS === null) return
  const interval = record.interval
  interval.frames += 1
  // A unit that died in this tick has no counters for it (NaN): its failure is the stop, not a frame figure.
  if (Number.isFinite(wall)) interval.walls.push(wall)
  interval.exchangeWorst = Math.max(interval.exchangeWorst, exchangeWall)
  interval.lagWorst = Math.max(interval.lagWorst, lag)
  if (lag > 0) interval.lagging += 1
  interval.instructionsWorst = Math.max(interval.instructionsWorst, finiteOr0(instructions))
  interval.instructions += finiteOr0(instructions)
  interval.cpuS += finiteOr0(cpuS)
  if (reading !== null) {
    interval.admWorst = Math.max(interval.admWorst, reading.admPos)
    interval.openingWorst = Math.max(interval.openingWorst, reading.opening)
    interval.tavgMin = Math.min(interval.tavgMin, reading.tavg)
    interval.tavgMax = Math.max(interval.tavgMax, reading.tavg)
    interval.rodErrorWorst = Math.max(interval.rodErrorWorst, Math.abs(reading.lawError))
    interval.bankMin = Math.min(interval.bankMin, reading.bank)
    interval.bankMax = Math.max(interval.bankMax, reading.bank)
  }
  const sample = load.latest()
  const entry: WorstEntry = [k, row[c('t_unit_s')]!, wall, exchangeWall, lag, instructions, row[c('p_instructions')]!, cpuS, row[c('runnable_s')]!,
    sample?.tS ?? Number.NaN, sample?.load1 ?? Number.NaN, sample?.pressure ?? Number.NaN, sample?.busy ?? []]
  if (Number.isFinite(wall)) keepWorst(record.byWall, entry, 2)
  if (Number.isFinite(instructions)) keepWorst(record.byInstructions, entry, 5)
}

/** One unit's reply folded into its record: the same rows whichever transport produced it. */
const noteFrame = (config: Config, load: LoadSampler, record: UnitRecord, k: number, frame: NativeAdvanceReceipt['frame'], cost: NativeAdvanceReceipt['cost'], sentAt: number, doneAt: number, lagS: number, stepS: number, reading: FrameReading | null): void => {
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
    if (after !== null && config.exchangeRows) record.frameInstructions.push([frame.t - stepS, before?.instructions ?? after.instructions])
  }
  const events = frame.events as { readonly instants?: ReadonlyArray<readonly [number, string, ReadonlyArray<string>]> } | null
  for (const instant of events?.instants ?? []) record.instants.push({ t_s: instant[0], class: instant[1] })
  const counts = frame.counts
  noteRow(config, load, record, [
    k, frame.t, cost.wallS, cost.cpuS, (doneAt - sentAt) / 1_000, lagS,
    delta(after, before, 'instructions'), delta(after, before, 'pInstructions'), delta(after, before, 'cycles'), delta(after, before, 'pCycles'),
    delta(after, before, 'userS'), delta(after, before, 'systemS'), delta(after, before, 'pUserS'), delta(after, before, 'pSystemS'), delta(after, before, 'runnableS'),
    after?.residentBytes ?? Number.NaN, after?.footprintBytes ?? Number.NaN,
    Number(counts.steps), Number(counts.residuals), Number(counts.jacobians), Number(counts.r_instants), Number(counts.s_instants),
  ], reading)
  if (after !== null && config.exchangeRows) record.frameInstructions.push([frame.t, after.instructions])
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
  const walls = record.rows.map(unitWall)
  const totals = record.totals
  return {
    unit: record.index,
    plant: record.plantId,
    spec: record.spec.text,
    frames: record.frames,
    frames_sha256: record.hasher.copy().digest('hex'),
    events_sha256: record.eventsHasher.copy().digest('hex'),
    failure: record.failure,
    ended: record.ended,
    wall_is_lag_only: {
      worst_advance_wall_s: record.wallWorst.value,
      worst_advance_wall_at_k: record.wallWorst.k,
      worst_advance_wall_over_real_time: record.wallWorst.value / stepS,
      worst_exchange_wall_s: record.exchangeWorst.value,
      worst_exchange_wall_at_k: record.exchangeWorst.k,
      worst_lag_s: record.lagWorst.value,
      frames_lagging: record.lagging,
      // Over every frame only when the rows are kept; a soak has them per rollup interval.
      adv_wall_p99_s: walls.length === 0 ? null : percentile(walls, 0.99),
      adv_wall_median_s: walls.length === 0 ? null : percentile(walls, 0.5),
    },
    instructions_are_cost: {
      total_g: totals.instructions / 1e9,
      worst_frame_g: record.instructionsWorst.value / 1e9,
      worst_frame_at_k: record.instructionsWorst.k,
      worst_frame_quiet_cpu_per_s: record.instructionsWorst.value / quietRatio / stepS,
      worst_0_5_s_quiet_cpu_per_s: record.fiveWorst.value,
      worst_0_5_s_at_k: record.fiveWorst.k,
      p_core_instruction_share: totals.instructions === 0 ? null : totals.pInstructions / totals.instructions,
    },
    admission_valve_worst: record.admWorst.k < 0 ? null : { value: record.admWorst.value, at_k: record.admWorst.k },
    // Soak rule r2's rod and valve lines with amendment A7 (createRodLine, createValveLine).
    rod_line: record.rodLine?.summary(record.frames) ?? null,
    valve_line: record.valveLine?.summary(record.frames) ?? null,
    cpu_s_total_by_rusage: totals.userS + totals.systemS,
    cpu_s_total_by_child_header: totals.cpuHeaderS,
    runnable_wait_s_total: totals.runnableS,
    connect: record.connectCost,
    resident_bytes: record.resident,
    footprint_bytes: record.footprint,
    steps_total: totals.steps, jacobians_total: totals.jacobians, restarts_r_total: totals.restartsR,
  }
}

const percentile = (values: ReadonlyArray<number>, q: number): number => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? Number.NaN
}

const stringifyError = (error: unknown): string => (error instanceof Error ? error.message : String(error))
const rounded = (value: number): number | null => (Number.isFinite(value) ? Number(value.toPrecision(7)) : null)

/** Why the run stopped. Every stop keeps its receipts; nothing restarts. */
interface Stop {
  readonly kind: 'span end' | 'stop file' | 'unit failure' | 'named end' | 'refusal' | 'runtime failure' | 'machine protection'
  readonly message: string
  readonly unit?: number
  readonly plantId?: string
  readonly pid?: number
  readonly atK: number
  readonly atIso: string
}
/** The signals a Pack emits when a unit or a runtime stops: each stops the run (a named end only a soak's). */
const stoppingSignals: ReadonlySet<string> = new Set(['process-plant.engine.failed', 'process-plant.engine.ended', 'process-plant.runtime.failed', 'electric-grid.runtime.failed'])
const exitCodeOf = (stop: Stop): number => (stop.kind === 'span end' || stop.kind === 'stop file' ? 0 : stop.kind === 'machine protection' ? 3 : 1)

/** The channels the soak reads: each frame (the rod law's Tavg and Tref, valve, Tavg's legs, bank) and every channel-log interval (the drift line). */
const frameChannels = ['LD01.CORE.BANK.ERROR', 'LD01.CORE.BANK.TAVG', 'LD01.CORE.BANK.TREF', 'LD01.CORE.BANK.HOLD', 'LD01.TG.ADM.OPENING', 'LD01.TG.ADM.POS', 'LD01.RCS.A.THOT', 'LD01.RCS.A.TCOLD', 'LD01.RCS.B.THOT', 'LD01.RCS.B.TCOLD', 'LD01.ROD.TRAVEL.MEAN'] as const
const logChannels = [...frameChannels, 'LD01.PZR.PRESSURE', 'LD01.PZR.LEVEL.COLLAPSED', 'LD01.SG.A.LEVEL.COLLAPSED', 'LD01.SG.B.LEVEL.COLLAPSED',
  'LD01.SG.A.LT.NR1', 'LD01.SG.B.LT.NR1', 'LD01.TG.GEN.WT', 'LD01.CORE.RELEASED_POWER', 'LD01.TG.LOAD.REQUEST', 'LD01.GRID.FREQUENCY', 'LD01.GRID.VOLTAGE', 'LD01.GRID.NET_EXPORT', 'LD01.GRID.OFFSITE_LOST'] as const
/** Tavg as the rod law forms it (operating water-ffi unit/rod_control.rs): per loop the mean of hot and cold, the loops' mean. */
const tavgOf = (values: ReadonlyMap<string, number>): number =>
  ((values.get('LD01.RCS.A.THOT')! + values.get('LD01.RCS.A.TCOLD')!) / 2 + (values.get('LD01.RCS.B.THOT')! + values.get('LD01.RCS.B.TCOLD')!) / 2) / 2
const tavgBasis = 'per loop the mean of LD01.RCS.<loop>.THOT and .TCOLD, the loops\' mean, unlagged: the rod law\'s form on the delivered leg channels. The law reads HOT.A.UPSTREAM where THOT.A is mass-weighted over HOT.A.*; the law\'s own lagged Tavg and its reference are LD01.CORE.BANK.TAVG and LD01.CORE.BANK.TREF, logged beside it'

/** Graph variable paths by the channel each reads (the artifact's tag map), refused when the map names none. */
const pathsByChannel = (artifact: Ld01UnitArtifact): ReadonlyMap<string, VariablePath> => {
  const byChannel = new Map<string, VariablePath>()
  for (const [path, bound] of Object.entries(artifact.tagMap.channels)) {
    const channel = typeof bound === 'string' ? bound : bound.channel
    if (!byChannel.has(channel) && typeof bound === 'string') byChannel.set(channel, path as VariablePath)
  }
  for (const [path, setpoint] of Object.entries(artifact.tagMap.setpoints)) if (!byChannel.has(setpoint.channel)) byChannel.set(setpoint.channel, path as VariablePath)
  return byChannel
}
const pathOf = (byChannel: ReadonlyMap<string, VariablePath>, channel: string): VariablePath => {
  const path = byChannel.get(channel)
  if (path === undefined) throw new Error(`the artifact's tag map binds no variable to ${channel}`)
  return path
}

/** Graph variables of one unit, value and unit by path. */
type UnitValues = ReadonlyMap<string, { readonly value: unknown; readonly unit: string }>
/** Reads one unit's variables: null once the unit has stopped answering (its failure, already the run's stop). */
type UnitReader = (paths: ReadonlyArray<VariablePath>) => Promise<UnitValues | null>

/**
 * Each unit's composition as its delivered channels show it. The engine binds the artifact's tag map against the
 * unit's CHANNELS at LOAD and refuses a channel the unit does not deliver; ld01-unit delivers LD01.CORE.BANK.HOLD only
 * with AUTO rod control composed, LD01.TG.LOAD.* and LD01.TG.ADM.POS only with the governor declared, LD01.DC.* only
 * with the DC groups declared, and LD01.TG.GEN.FIELD.INITIATED from the field controller every unit composes.
 */
const compositionOf = async (byChannel: ReadonlyMap<string, VariablePath>, read: UnitReader) => {
  const dcChannels = [...byChannel.keys()].filter(channel => channel.startsWith('LD01.DC.') && !channel.endsWith('.QUALITY')).sort()
  if (dcChannels.length === 0) throw new Error('the artifact binds no DC channel: no DC groups')
  const groups = {
    rods: ['LD01.CORE.BANK.HOLD', 'LD01.CORE.BANK.ERROR', 'LD01.CORE.BANK.TAVG', 'LD01.CORE.BANK.TREF'],
    governor: ['LD01.TG.LOAD.REQUEST', 'LD01.TG.ADM.OPENING', 'LD01.TG.ADM.POS'],
    dc: dcChannels,
    field_controller: ['LD01.TG.GEN.FIELD.INITIATED'],
  }
  const values = await read([...new Set(Object.values(groups).flat())].map(channel => pathOf(byChannel, channel)))
  if (values === null) return null
  return Object.fromEntries(Object.entries(groups).map(([name, channels]) => [name, channels.map(channel => {
    const read = values.get(pathOf(byChannel, channel))
    return { channel, path: pathOf(byChannel, channel), value: read?.value ?? null, unit: read?.unit ?? null }
  })]))
}

/** The soak's receipts on disk: written as the run goes, so a stop at any point keeps them. */
const createSoakFiles = (config: Config, records: ReadonlyArray<UnitRecord>, load: LoadSampler, stepS: number) => {
  const rollupColumns = ['unit', 'interval', 'end_k', 't_unit_s', 'frames', 'unit_wall_worst_s', 'unit_wall_p99_s', 'exchange_wall_worst_s', 'lag_worst_s', 'frames_lagging',
    'instructions_worst_frame', 'instructions_total', 'cpu_s', 'resident_bytes', 'footprint_bytes', 'adm_pos_worst', 'opening_worst', 'tavg_min', 'tavg_max', 'rod_error_worst_k', 'rod_frames_outside_band', 'rod_frames_not_correcting', 'bank_min', 'bank_max', 'core_busy_mean', 'load1'] as const
  const rollups = join(config.out, 'rollups.ndjson')
  const channels = join(config.out, 'channels.ndjson')
  writeFileSync(rollups, `${JSON.stringify({ columns: rollupColumns, rollup_s: config.rollupS, unit_wall_basis: 'the unit\'s CPU plus runnable time over the tick (proc_pid_rusage); the exchange wall bounds it', exchange_wall_basis: 'the tick: every unit\'s exchange at once, then the commit to every Pack' })}\n`)
  let interval = 0
  const writeRollups = (k: number): void => {
    const machineInterval = load.interval()
    const lines = records.map(record => {
      const figures = record.interval
      record.interval = newInterval()
      const rod = record.rodLine?.takeInterval() ?? null
      const finite = (value: number): number | null => (Number.isFinite(value) ? rounded(value) : null)
      return JSON.stringify([record.index, interval, k, rounded(record.lastT), figures.frames,
        finite(Math.max(...figures.walls)), figures.walls.length === 0 ? null : rounded(percentile(figures.walls, 0.99)), rounded(figures.exchangeWorst), rounded(figures.lagWorst), figures.lagging,
        figures.instructionsWorst, figures.instructions, rounded(figures.cpuS), record.resident.last, record.footprint.last,
        finite(figures.admWorst), finite(figures.openingWorst), finite(figures.tavgMin), finite(figures.tavgMax), finite(figures.rodErrorWorst), rod?.outsideBand ?? null, rod?.notCorrecting ?? null, finite(figures.bankMin), finite(figures.bankMax), rounded(machineInterval.busyMean), rounded(machineInterval.load1)])
    })
    appendFileSync(rollups, `${lines.join('\n')}\n`)
    interval += 1
  }
  let channelHeader = false
  const writeChannels = (k: number, logged: ReadonlyArray<UnitValues | null>, byChannel: ReadonlyMap<string, VariablePath>): void => {
    if (!channelHeader) {
      const units = logged.find(values => values !== null)
      writeFileSync(channels, `${JSON.stringify({ columns: ['unit', 'k', 'run_s', 'tavg', ...logChannels], units: Object.fromEntries(logChannels.map(channel => [channel, units?.get(pathOf(byChannel, channel))?.unit ?? null])), tavg: tavgBasis, channel_log_s: config.channelLogS })}\n`)
      channelHeader = true
    }
    const lines = logged.flatMap((values, index) => {
      if (values === null) return []
      const byId = new Map(logChannels.map(channel => [channel, Number(values.get(pathOf(byChannel, channel))?.value)]))
      return [JSON.stringify([index, k, rounded((k + 1) * stepS), rounded(tavgOf(byId)), ...logChannels.map(channel => {
        const value = values.get(pathOf(byChannel, channel))?.value
        return typeof value === 'boolean' ? (value ? 1 : 0) : typeof value === 'number' ? value : null
      })])]
    })
    if (lines.length > 0) appendFileSync(channels, `${lines.join('\n')}\n`)
  }
  const writeWorst = (): void => {
    writeFileSync(join(config.out, 'worst.json'), `${JSON.stringify({ columns: worstColumns, kept: worstKept, units: records.map(record => ({ unit: record.index, plant: record.plantId, by_unit_wall: worstOf(record.byWall, 2), by_instructions: worstOf(record.byInstructions, 5) })) })}\n`)
  }
  /** Every soak check at the end of tick k: the rollup, the stop file, the disk, the memory pressure. */
  const check = (k: number): Stop | null => {
    const atIso = new Date().toISOString()
    if (load.pressureHeldS() >= pressureStop.heldS) return { kind: 'machine protection', message: `memory pressure ${pressureStop.name} for ${load.pressureHeldS().toFixed(0)} s (${pressureStop.sysctl} ${load.latest()?.pressure})`, atK: k, atIso }
    const rollupFrames = Math.round(config.rollupS! / stepS)
    if ((k + 1) % rollupFrames !== 0) return null
    writeRollups(k)
    if (config.stopFile !== null && existsSync(config.stopFile)) return { kind: 'stop file', message: `stop file ${config.stopFile}`, atK: k, atIso }
    const disk = statfsSync(config.out)
    const free = disk.bavail * disk.bsize
    if (free < diskFloorBytes) return { kind: 'machine protection', message: `free disk ${(free / 2 ** 30).toFixed(2)} GiB under 2 GiB`, atK: k, atIso }
    return null
  }
  const channelLogDue = (k: number): boolean => k === 0 || (k + 1) % Math.round(config.channelLogS / stepS) === 0
  /** At the stop: the partial interval, the final worst lists. */
  const close = (k: number): void => {
    if (records.some(record => record.interval.frames > 0)) writeRollups(k)
    writeWorst()
  }
  return { check, channelLogDue, writeChannels, writeWorst, close }
}
type SoakFiles = ReturnType<typeof createSoakFiles>

/** One channel-log row per unit (none for a unit that has stopped answering), and the worst lists. */
const logChannelsAt = async (files: SoakFiles, k: number, byChannel: ReadonlyMap<string, VariablePath>, readers: ReadonlyArray<UnitReader>): Promise<void> => {
  const paths = logChannels.map(channel => pathOf(byChannel, channel))
  files.writeChannels(k, await Promise.all(readers.map(async read => await read(paths))), byChannel)
  files.writeWorst()
}

/** The soak's per-tick work after the frames are noted: the channel log when due, then every stop check. */
const soakTick = async (files: SoakFiles | null, k: number, byChannel: ReadonlyMap<string, VariablePath>, readers: ReadonlyArray<UnitReader>): Promise<Stop | null> => {
  if (files === null) return null
  if (files.channelLogDue(k)) await logChannelsAt(files, k, byChannel, readers)
  return files.check(k)
}

/** One frame's soak readings, or null for a unit that has stopped answering. */
const readFrame = async (read: UnitReader, byChannel: ReadonlyMap<string, VariablePath>): Promise<FrameReading | null> => {
  const values = await read(frameChannels.map(channel => pathOf(byChannel, channel)))
  if (values === null) return null
  const byId = new Map<string, number>(frameChannels.map(channel => [channel, Number(values.get(pathOf(byChannel, channel))?.value)]))
  return {
    admPos: byId.get('LD01.TG.ADM.POS')!, opening: byId.get('LD01.TG.ADM.OPENING')!, tavg: tavgOf(byId), lawError: byId.get('LD01.CORE.BANK.ERROR')!,
    tavgMinusTref: byId.get('LD01.CORE.BANK.TAVG')! - byId.get('LD01.CORE.BANK.TREF')!, bank: byId.get('LD01.ROD.TRAVEL.MEAN')!, auto: byId.get('LD01.CORE.BANK.HOLD') === 0,
  }
}

const connectEngine = async (config: Config, artifact: Ld01UnitArtifact, record: UnitRecord): Promise<NativeProcessPlantEngine> => {
  const pinned = config.pinCores === null ? [artifact.binary] : ['taskset', '-c', String(config.pinCores[record.index]), artifact.binary]
  const before = new Set(childPids())
  const engine = await connectNativeProcessPlantEngine({
    plant: compileProcessPlant(plantDefinition(record.plantId) as never),
    tagMap: artifact.tagMap, load: artifact.load, gridExchangeS: null, artifactSha256: artifact.manifestSha256, command: pinned,
    onFailure: failure => { record.failure = failure.reason },
  })
  const added = childPids().filter(pid => !before.has(pid))
  if (added.length !== 1) throw new Error(`connecting unit ${record.index} added ${added.length} child processes: ${added.join(',')}`)
  record.pid = added[0]!
  record.connectCost = engine.connectCost
  record.last = counters(record.pid)
  return engine
}

interface Connected {
  readonly composition: ReadonlyArray<unknown>
  readonly scenario: Record<string, unknown>
}
type OnConnected = (connected: Connected) => void

const runEngines = async (config: Config, artifact: Ld01UnitArtifact, records: ReadonlyArray<UnitRecord>): Promise<Record<string, unknown>> => {
  const engines: NativeProcessPlantEngine[] = []
  for (const record of records) engines.push(await connectEngine(config, artifact, record))
  const load = createLoadSampler(config.exchangeRows)
  const hostAtStart = counters(process.pid)
  const exchanges: Array<readonly number[]> = []
  const stepMs = config.exchangeMs
  const stepS = stepMs / 1_000
  const count = Math.round(config.spanS * 1_000 / stepMs)
  const t0 = performance.now() + config.leadS * 1_000
  let commanded = false
  const refusals: string[] = []
  let stop: Stop | null = null
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
        // The engine counts the Run's whole milliseconds in frames (R4-GRID's frame rule), so each tick of `exchangeMs`
        // is one exchange of exactly that many frames.
        const sentAt = performance.now()
        const receipt = await engine.advance(stepMs)
        const doneAt = performance.now()
        if (Number.isNaN(record.commandT) && receipt.frame !== null) record.commandT = receipt.frame.t - stepS
        noteFrame(config, load, record, k, receipt.frame, receipt.cost, sentAt, doneAt, Math.max(0, (doneAt - deadline) / 1_000), stepS, null)
        const ended = engine.ended()
        if (ended !== null) record.ended = ended.reason
      }))
      const endedAt = performance.now()
      if (config.exchangeRows) exchanges.push([k, (scheduled - t0) / 1_000, (startedAt - t0) / 1_000, (endedAt - t0) / 1_000, Math.max(0, (endedAt - deadline) / 1_000)])
      const refused = settled.flatMap((outcome, index) => outcome.status === 'rejected' ? [`unit ${index}: ${stringifyError(outcome.reason)}`] : [])
      if (refused.length > 0) {
        for (const line of refused) console.error(line)
        refusals.push(...refused)
        const index = settled.findIndex(outcome => outcome.status === 'rejected')
        const record = records[index]!
        stop = { kind: record.failure !== null ? 'unit failure' : 'refusal', message: record.failure ?? refused[0]!, unit: index, plantId: record.plantId, pid: record.pid, atK: k, atIso: new Date().toISOString() }
        break
      }
    }
  } finally {
    load.stop()
    for (const engine of engines) await engine.close().catch(() => undefined)
  }
  const hostAtEnd = counters(process.pid)
  return { exchanges_columns: ['k', 'scheduled_s', 'started_s', 'ended_s', 'overrun_s'], exchanges, commanded, refusals, stop: stop ?? { kind: 'span end', message: `${count} exchanges`, atK: count - 1, atIso: new Date().toISOString() }, load: load.samples, host_cpu_s: hostAtStart === null || hostAtEnd === null ? null : (hostAtEnd.userS + hostAtEnd.systemS) - (hostAtStart.userS + hostAtStart.systemS), host_instructions_g: hostAtStart === null || hostAtEnd === null ? null : (hostAtEnd.instructions - hostAtStart.instructions) / 1e9 }
}

/**
 * The adapter path's Scenario: Halden's first N bays with their Plants made LD-01 and, with the Grid, Halden's
 * Electric Grid and the Electrical Connections of those bays; compiled by the World's Scenario compiler.
 */
const ld01Halden = async (units: number, grid: boolean) => {
  const source = builtinScenarioDefinitions.find(definition => definition.id === haldenScenarioId)
  if (source === undefined) throw new Error(`no bundled Scenario ${haldenScenarioId}`)
  const plantPack = source.packs.find(selection => selection.id === 'process-plant')
  const gridPack = source.packs.find(selection => selection.id === 'electric-grid')
  if (plantPack === undefined || gridPack === undefined) throw new Error(`${haldenScenarioId} has no Process Plant or Electric Grid selection`)
  if (units > plantPack.items.length) throw new Error(`--units: ${haldenScenarioId} has ${plantPack.items.length} bays, not ${units}`)
  const plants = plantPack.items.slice(0, units).map(item => ({ ...item, ...plantDefinition(item.id) }))
  const plantIds = new Set(plants.map(plant => plant.id))
  const packs = [processPlantPack, electricGridPack]
  const scenario = await compileScenarioDefinition({
    id: 'ld01-multi-halden', title: `LD-01 multi-unit: ${units} Halden bays${grid ? ' on the Grid' : ''}`, world: source.world, view: source.view,
    packs: [{ ...plantPack, items: plants }, ...(grid ? [gridPack] : [])],
    connections: grid ? source.connections.filter(connection => plantIds.has(connection.system.objectId)) : [],
  }, packs, { routing: createDirectRoutingAdapter() })
  return { scenario, resolved: createScenarioRuntimeResolver({ packs }).resolve(scenario) }
}

// The real Pack adapters through the World's runtime hub: per-unit rusage and the tick wall, no reply header.
const runAdapter = async (config: Config, artifact: Ld01UnitArtifact, records: ReadonlyArray<UnitRecord>, onConnected: OnConnected): Promise<Record<string, unknown>> => {
  process.env[ld01UnitArtifactEnv] = config.artifact
  const { scenario, resolved } = await ld01Halden(records.length, config.grid)
  const startsAt = scenario.world.startsAt
  const simulationRunId = 'run:ld01-multi' as SimulationRunId
  const clock: SimulationClock = createSimulationClock({ currentTime: startsAt, updatedAt: startsAt, paused: true })
  const before = new Set(childPids())
  const hub: PackRuntimeConnection = await createRuntimeHub([createLocalProcessPlantPackRuntimeAdapter(), createLocalElectricGridPackRuntimeAdapter()]).connect({
    simulationRunId,
    runClock: clock,
    scenario: { scenarioId: scenario.id, runtimeIds: resolved.runtimes.map(runtime => runtime.runtimeId), connections: scenario.connections, world: scenario.world, initialObjects: scenario.initialObjects, runtimeConfigByRuntimeId: resolved.runtimeConfigByRuntimeId, runtimeConfig: {} },
  })
  const added = childPids().filter(pid => !before.has(pid)).sort((a, b) => a - b)
  if (added.length !== records.length) throw new Error(`the adapter started ${added.length} children for ${records.length} units`)
  // The children start in the Plants' order (each Plant's engine spawns before its first await), so ascending pids
  // follow the Plants; each pid is named in the receipt with its Plant.
  records.forEach((record, index) => { record.pid = added[index]!; record.last = counters(record.pid) })
  const indexOfPlant = new Map(records.map(record => [record.plantId, record.index]))
  const soak = config.rollupS !== null
  let stop: Stop | null = null
  let k = 0
  let lastK = 0
  // The Run's commit: every object an emission upserts or deletes is committed and observed by every Pack, in order.
  let sequence = 0
  let committed: Promise<void> = Promise.resolve()
  const signals: Array<{ readonly type: string; readonly payload: unknown }> = []
  const unsubscribe = hub.subscribe(emission => {
    const events = emission.events.flatMap((event): SimulationRunEvent[] => {
      if (event.type === 'interaction.signal') {
        const { type, payload } = event.signal
        if (!stoppingSignals.has(type)) return []
        signals.push({ type, payload })
        if (stop === null && (type !== 'process-plant.engine.ended' || soak)) {
          const { plantId, message } = payload as { readonly plantId?: string; readonly message?: string }
          const unit = plantId === undefined ? undefined : indexOfPlant.get(plantId)
          stop = {
            kind: type === 'process-plant.engine.failed' ? 'unit failure' : type === 'process-plant.engine.ended' ? 'named end' : 'runtime failure',
            message: message ?? type, atK: k, atIso: new Date().toISOString(),
            ...(plantId === undefined ? {} : { plantId }), ...(unit === undefined ? {} : { unit, pid: records[unit]!.pid }),
          }
        }
        return []
      }
      if (event.type !== 'object.upserted' && event.type !== 'object.deleted') return []
      sequence += 1
      return [{ ...event, id: `event:ld01-multi:${sequence}` as EventId, simulationRunId, seq: sequence } as SimulationRunEvent]
    })
    if (events.length > 0) committed = committed.then(() => hub.observeCommittedEvents(events))
  })
  const drain = async (): Promise<void> => {
    let seen: Promise<void>
    do {
      seen = committed
      await seen
    } while (seen !== committed)
  }
  const byChannel = pathsByChannel(artifact)
  // A read a live unit refuses is itself a stop, by name; a unit that failed has stopped the run already.
  const readers: ReadonlyArray<UnitReader> = records.map(record => async paths => {
    try {
      const answer = await hub.invokeQuery({ readPolicy: unrestrictedQueryReadPolicy, capabilityId: 'world.process-plant.variables.read', input: { plantId: record.plantId, paths } }) as { readonly variables: ReadonlyArray<{ readonly path: string; readonly value: unknown; readonly unit: string }> }
      return new Map(answer.variables.map(variable => [variable.path, { value: variable.value, unit: variable.unit }]))
    } catch (error) {
      stop ??= { kind: 'runtime failure', message: `${record.plantId} refused a soak read: ${stringifyError(error)}`, unit: record.index, plantId: record.plantId, pid: record.pid, atK: k, atIso: new Date().toISOString() }
      return null
    }
  })
  const composition = soak ? await Promise.all(readers.map(read => compositionOf(byChannel, read))) : []
  // The rod line compares the law's error, a temperature difference, with deadBand_K (kelvin): it reads in K or degC (equal steps).
  // TAVG and TREF, reported beside it, read in one such scale. The valve line compares the opening, a fraction, with 1.
  const unitsOf = (channel: string) => new Set(composition.flatMap(unit => [...(unit?.rods ?? []), ...(unit?.governor ?? [])].filter(read => read.channel === channel).map(read => read.unit)))
  const kelvinSteps = (units: Set<string | null>) => units.size === 1 && ['K', 'degC'].includes([...units][0] ?? '')
  if (soak && !kelvinSteps(unitsOf('LD01.CORE.BANK.ERROR'))) throw new Error(`LD01.CORE.BANK.ERROR reads in ${[...unitsOf('LD01.CORE.BANK.ERROR')].join(', ')}: the rod line needs K or degC`)
  if (soak && !kelvinSteps(new Set([...unitsOf('LD01.CORE.BANK.TAVG'), ...unitsOf('LD01.CORE.BANK.TREF')]))) throw new Error('LD01.CORE.BANK.TAVG and .TREF read in different scales or not in K or degC')
  if (soak && [...unitsOf('LD01.TG.ADM.OPENING')].some(unit => unit !== 'fraction')) throw new Error(`LD01.TG.ADM.OPENING reads in ${[...unitsOf('LD01.TG.ADM.OPENING')].join(', ')}: the valve line needs a fraction`)
  onConnected({
    composition,
    scenario: { id: scenario.id, grid: config.grid, runtimes: resolved.runtimes.map(runtime => runtime.runtimeId), plants: records.map(record => ({ plant: record.plantId, pid: record.pid })), connections: scenario.connections.map(connection => ({ id: connection.id, system: connection.system, network: connection.network })) },
  })
  const load = createLoadSampler(config.exchangeRows)
  const files = soak ? createSoakFiles(config, records, load, config.exchangeMs / 1_000) : null
  const exchanges: Array<readonly number[]> = []
  const stepMs = config.exchangeMs
  const count = Math.round(config.spanS * 1_000 / stepMs)
  const t0 = performance.now() + config.leadS * 1_000
  const hostAtStart = counters(process.pid)
  let commanded = false
  try {
    for (; k < count && stop === null; k += 1) {
      lastK = k
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
          await hub.sendCommand(envelope, { origin: 'person' })
          commanded = true
        }
      }
      const startedAt = performance.now()
      const beforeAdvance = records.map(record => counters(record.pid))
      const next: SimulationClockState = { ...clock.read(), currentTime: new Date(Date.parse(clock.read().currentTime) + stepMs).toISOString() as IsoTimestamp }
      try {
        await hub.advanceTo!(next)
        clock.set(next)
        await drain()
      } catch (error) {
        stop ??= { kind: 'refusal', message: stringifyError(error), atK: k, atIso: new Date().toISOString() }
        break
      }
      const endedAt = performance.now()
      const deadline = t0 + (k + 1) * stepMs
      const readings = soak ? await Promise.all(readers.map(read => readFrame(read, byChannel))) : records.map(() => null)
      records.forEach((record, index) => {
        const after = counters(record.pid)
        const prior = beforeAdvance[index] ?? null
        noteRow(config, load, record, [
          k, (k + 1) * stepMs / 1_000, Number.NaN, Number.NaN, (endedAt - startedAt) / 1_000, Math.max(0, (endedAt - deadline) / 1_000),
          delta(after, prior, 'instructions'), delta(after, prior, 'pInstructions'), delta(after, prior, 'cycles'), delta(after, prior, 'pCycles'),
          delta(after, prior, 'userS'), delta(after, prior, 'systemS'), delta(after, prior, 'pUserS'), delta(after, prior, 'pSystemS'), delta(after, prior, 'runnableS'),
          after?.residentBytes ?? Number.NaN, after?.footprintBytes ?? Number.NaN, Number.NaN, Number.NaN, Number.NaN, Number.NaN, Number.NaN,
        ], readings[index] ?? null)
        if (record.first === null) record.first = prior
        record.last = after
      })
      if (config.exchangeRows) exchanges.push([k, (scheduled - t0) / 1_000, (startedAt - t0) / 1_000, (endedAt - t0) / 1_000, Math.max(0, (endedAt - deadline) / 1_000)])
      if (stop !== null) break
      const checked = await soakTick(files, k, byChannel, readers)
      stop ??= checked
    }
    if (files !== null && !files.channelLogDue(lastK)) await logChannelsAt(files, lastK, byChannel, readers)
  } finally {
    load.stop()
    files?.close(lastK)
    unsubscribe()
    await hub.close()
  }
  for (const record of records) {
    const failed = signals.find(signal => signal.type === 'process-plant.engine.failed' && (signal.payload as { readonly plantId?: string }).plantId === record.plantId)
    const ended = signals.find(signal => signal.type === 'process-plant.engine.ended' && (signal.payload as { readonly plantId?: string }).plantId === record.plantId)
    if (failed !== undefined) record.failure = (failed.payload as { readonly message: string }).message
    if (ended !== undefined) record.ended = (ended.payload as { readonly message: string }).message
  }
  const hostAtEnd = counters(process.pid)
  return { exchanges_columns: ['k', 'scheduled_s', 'started_s', 'ended_s', 'overrun_s'], exchanges, commanded, failed: stop?.kind === 'refusal' ? stop.message : null, stop: stop ?? { kind: 'span end', message: `${count} exchanges`, atK: count - 1, atIso: new Date().toISOString() }, signals, via_adapter: true, load: load.samples, host_cpu_s: hostAtStart === null || hostAtEnd === null ? null : (hostAtEnd.userS + hostAtEnd.systemS) - (hostAtStart.userS + hostAtStart.systemS), host_instructions_g: hostAtStart === null || hostAtEnd === null ? null : (hostAtEnd.instructions - hostAtStart.instructions) / 1e9 }
}

/** deadBand_K and maximumSpeedError_K of the wiki block ld01-rod-control in the wiki the unit reads (its LOAD inputs' wiki root). */
const rodLawOf = (artifact: Ld01UnitArtifact) => {
  const page = join(artifact.load.inputs.wiki_root, 'world/packs/process-plant/reference-designs/ld-01/systems/reactor/control-and-verification.md')
  const text = readFileSync(page, 'utf8')
  const block = configurationBlock(text, 'ld01-rod-control') as { readonly deadBand_K?: unknown; readonly maximumSpeedError_K?: unknown }
  const deadBandK = block.deadBand_K, maximumSpeedErrorK = block.maximumSpeedError_K
  if (typeof deadBandK !== 'number' || !Number.isFinite(deadBandK) || deadBandK <= 0) throw new Error(`ld01-rod-control in ${page}: deadBand_K ${String(deadBandK)} is not a positive number`)
  if (typeof maximumSpeedErrorK !== 'number' || !Number.isFinite(maximumSpeedErrorK) || !(maximumSpeedErrorK > deadBandK)) throw new Error(`ld01-rod-control in ${page}: maximumSpeedError_K ${String(maximumSpeedErrorK)} is not above deadBand_K`)
  return { dead_band_k: deadBandK, maximum_speed_error_k: maximumSpeedErrorK, block: 'ld01-rod-control', page: relative(artifact.directory, page), page_sha256: new Bun.CryptoHasher('sha256').update(text).digest('hex') }
}

const bytesUnder = (directory: string): number => readdirSync(directory).reduce((total, name) => total + statSync(join(directory, name)).size, 0)

const main = async (): Promise<void> => {
  const config = parseArgs(Bun.argv.slice(2))
  mkdirSync(config.out, { recursive: true })
  process.env[ld01UnitArtifactEnv] = config.artifact
  const artifact = loadLd01UnitArtifact(config.artifact)
  const rodLine = config.rollupS === null ? null : rodLawOf(artifact)
  const law: RodLaw | null = rodLine === null ? null : { deadBandK: rodLine.dead_band_k, maximumSpeedErrorK: rodLine.maximum_speed_error_k }
  const records = config.units.map((spec, index) => newRecord(index, spec, config.via === 'adapter' ? `plant:halden-${index + 1}` : `plant:ld01-multi-${index}`, law))
  const startedIso = new Date().toISOString()
  const loadAtStart = loadavg()
  const memoryAtStart = { totalBytes: totalmem(), freeBytes: freemem() }
  const stepS = config.exchangeMs / 1_000
  const identity = {
    config: { ...config, units: config.units.map(unit => unit.text) }, artifact_manifest_sha256: artifact.manifestSha256, rod_line: rodLine,
    artifact_load: { ic: basename(artifact.load.inputs.ic), state: basename(artifact.load.state), packet: basename(artifact.load.inputs.packet), elec: basename(artifact.load.inputs.elec), solver: artifact.load.solver },
  }
  const onConnected: OnConnected = connected => {
    if (config.rollupS === null) return
    writeFileSync(join(config.out, 'start.json'), `${JSON.stringify({
      format: 'ld01-multi-unit-start', started_iso: startedIso, connected_iso: new Date().toISOString(), ...identity, scenario: connected.scenario,
      units: records.map((record, index) => ({ index, plant: record.plantId, pid: record.pid, spec: record.spec.text, composition: connected.composition[index] })),
      composition_basis: 'each unit\'s delivered channels at connect: the engine refuses at LOAD a tag-map channel the unit does not deliver; ld01-unit delivers LD01.CORE.BANK.HOLD only with AUTO rod control composed (0 = AUTO), LD01.TG.LOAD.* and LD01.TG.ADM.POS only with the governor declared, LD01.DC.* only with the DC groups declared, LD01.TG.GEN.FIELD.INITIATED from the field controller every unit composes',
      machine_protection: { free_disk_floor_bytes: diskFloorBytes, memory_pressure_stop: pressureStop, rule: 'soak rule r2 with amendment A1 (the Mac)' },
      load_at_start: loadAtStart, memory_at_start: memoryAtStart,
    }, null, 1)}\n`)
  }
  const run = config.via === 'engine' ? await runEngines(config, artifact, records) : await runAdapter(config, artifact, records, onConnected)
  const load = run.load as ReadonlyArray<LoadSample>
  const coreBusyMean = load.length === 0 ? [] : load[0]!.busy.map((_, core) => load.reduce((sum, sample) => sum + sample.busy[core]!, 0) / load.length)
  const summaries = records.map(record => summarize(record, stepS))
  const stop = run.stop as Stop
  const receipt = {
    format: 'ld01-multi-unit-run', basis: 'NOT-EVIDENCE: contention on this host only; instructions are cost, wall clock is lag', platform: process.platform,
    ...identity, started_iso: startedIso, ended_iso: new Date().toISOString(), stop,
    columns, units: records.map(record => ({ index: record.index, plant: record.plantId, spec: record.spec.text, pid: record.pid, command_t_s: record.commandT, connect_cost: record.connectCost, first_frame_t_s: record.firstFrameT, rows: record.rows })),
    run: { ...run, load: undefined, stop: undefined }, load_samples: load, core_busy_mean: coreBusyMean, load_at_start: loadAtStart, load_at_end: loadavg(), memory_at_start: memoryAtStart, memory_at_end: { totalBytes: totalmem(), freeBytes: freemem() },
    summaries,
  }
  writeFileSync(join(config.out, 'run.json'), `${JSON.stringify(receipt)}\n`)
  if (config.exchangeRows) for (const record of records) writeFileSync(join(config.out, `unit-${record.index}.judge.json`), `${JSON.stringify(judgeReceipt(record, stepS))}\n`)
  const bytes = bytesUnder(config.out)
  const printable = { out: config.out, via: config.via, grid: config.grid, units: config.units.map(unit => unit.text), exchange_ms: config.exchangeMs, pace: config.pace, stop, bytes_written: bytes, load_start: loadAtStart[0], load_end: loadavg()[0], core_busy_mean: coreBusyMean.map(value => Number(value.toFixed(3))), host_cpu_s: run.host_cpu_s, host_instructions_g: run.host_instructions_g, exchanges: (run.exchanges as ReadonlyArray<unknown>).length, summaries }
  console.log(JSON.stringify(printable, null, 1))
  // Every receipt is written first; the exit code says why it stopped: 0 the span or the stop file, 1 a unit or the
  // runtime, 3 machine protection.
  const failed = records.some(record => record.failure !== null) || ((run as { refusals?: ReadonlyArray<string> }).refusals ?? []).length > 0
  process.exit(failed && exitCodeOf(stop) === 0 ? 1 : exitCodeOf(stop))
}

// The line's logic is imported by this script's own tests; the run starts only when the script is run.
if (import.meta.main) await main()
