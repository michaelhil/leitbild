// Bounds and honest refusals (design §6.4). Every certificate is a counting argument a reader can redo:
//   1. temporal propagation (links, releases, window, calendars, span limits as pairwise max-lags,
//      overload of one-at-a-time resources) to a fixpoint; an empty window is a temporal certificate;
//   2. chain: one after another, the work of a chain exceeds the working slots of its calendars' union;
//   3. sliding-window span energy: for every possible first-out slot s of a limited span, the work that
//      must fall inside [s, s + limit) exceeds the capacity of the eligible resources there.
// Lane K re-verifies every certificate independently.
import type { Certificate } from '../plan/schema.ts'
import type { CompileIndex } from './compile.ts'
import { prepare, unitMs, type Prepared } from './decode.ts'
import type { BoundSource, NormalizedProblem } from './problem.ts'

export interface Windows {
  readonly ok: boolean
  readonly est: Int32Array
  readonly eft: Int32Array
  readonly lst: Int32Array
  readonly lft: Int32Array
  /** modeOk[a][m]: the mode can still be placed inside the activity's window. */
  readonly modeOk: readonly Uint8Array[]
  readonly failure?: { readonly activity: number; readonly via: 'link' | 'window' | 'release' | 'lock' | 'span-limit' | 'overload'; readonly resource?: number }
}

export interface SpanWindow {
  readonly span: string
  readonly rule?: string
  /** First-out slots that pass temporal propagation, as [from, to) in slots. */
  readonly from: number
  readonly to: number
  readonly feasibleStarts: number
}

/** One stretch of a refusal's chain: a job at its earliest, as logic and calendars place it. */
export interface ChainStep {
  readonly job: string
  readonly start: string
  readonly finish: string
  /** What ties this job to the one before it in the chain (the first job: the span limit). */
  readonly via: 'span-limit' | 'link' | 'bracket' | 'support-order'
}
export interface SpanRefusal {
  readonly rule: string
  readonly limitHours: number
  /** The least span possible with no limit, its first-out and last-back times, and the chain that sets the end. */
  readonly leastHours: number
  readonly firstOut: string
  readonly lastBack: string
  readonly path: readonly ChainStep[]
  /** The least span over every later first-out slot, and the chain that sets its end (why later does not help). */
  readonly later?: { readonly firstOut: string; readonly lastBack: string; readonly hours: number; readonly path: readonly ChainStep[] }
  readonly alsoProven?: Certificate
}

export interface BoundsResult {
  readonly certificate?: Certificate
  /** Per goal: a lower bound on the raw metric in internal units (no threshold applied), and its source. */
  readonly goals: ReadonlyArray<{ readonly value: number | readonly number[]; readonly source: BoundSource }>
  readonly spanWindows: readonly SpanWindow[]
  /**
   * For a refusal by a span limit: the least span logic and calendars allow without the limit, the
   * first-out and last-back times that give it, and a second, independent proof when one exists.
   */
  readonly span?: SpanRefusal
  /** The resource whose work binds the finish most (crew energy), for "no plan found" answers. */
  readonly busiest?: { readonly resource: string; readonly finishBy: string; readonly loadShare: number }
}

interface Helpers { readonly next: Int32Array[] }

const nextWorking = (prep: Prepared): Int32Array[] => prep.cal.map(k => {
  const next = new Int32Array(prep.H + 1).fill(prep.H)
  for (let t = prep.H - 1; t >= 0; t--) next[t] = k.pos[t]! >= 0 ? t : next[t + 1]!
  return next
})

/** Earliest start >= lo of mode m whose finish is >= ffLo, with that finish; [-1, -1] if none. */
const earliest = (prep: Prepared, help: Helpers, a: number, m: number, lo: number, ffLo: number, pausable: boolean): [number, number] => {
  const mode = prep.problem.activities[a]!.modes[m]!
  const H = prep.H
  lo = Math.max(0, lo)
  if (mode.work === 0) { const t = Math.max(lo, ffLo); return t <= H ? [t, t] : [-1, -1] }
  const k = prep.cal[mode.calendar]!
  if (mode.continuous && !pausable) {
    let t = Math.max(lo, ffLo - mode.work)
    while (t < H) {
      if (k.run[t]! >= mode.work) return [t, t + mode.work]
      t += k.run[t]! + 1
    }
    return [-1, -1]
  }
  if (lo >= H) return [-1, -1]
  let p = k.prefix[lo]!
  if (ffLo > 0) p = Math.max(p, k.prefix[Math.min(H, ffLo - 1)]! - mode.work + 1)
  if (p + mode.work - 1 >= k.list.length) return [-1, -1]
  void help
  return [k.list[p]!, k.list[p + mode.work - 1]! + 1]
}

/** Latest start <= hiS of mode m whose finish is <= hiF, with that finish; [-1, -1] if none. */
const latest = (prep: Prepared, a: number, m: number, hiS: number, hiF: number, pausable: boolean): [number, number] => {
  const mode = prep.problem.activities[a]!.modes[m]!
  const H = prep.H
  hiF = Math.min(hiF, H)
  if (mode.work === 0) { const t = Math.min(hiS, hiF); return t >= 0 ? [t, t] : [-1, -1] }
  const k = prep.cal[mode.calendar]!
  if (mode.continuous && !pausable) {
    for (let t = Math.min(hiS, hiF - mode.work, H - 1); t >= 0; t--) if (k.run[t]! >= mode.work) return [t, t + mode.work]
    return [-1, -1]
  }
  if (hiF <= 0 || hiS < 0) return [-1, -1]
  let p = k.prefix[hiF]! - mode.work
  p = Math.min(p, k.prefix[Math.min(H, hiS + 1)]! - 1)
  if (p < 0) return [-1, -1]
  return [k.list[p]!, k.list[p + mode.work - 1]! + 1]
}

/**
 * SS lags count the predecessor's own working time (decode.ts). The earliest slot by which a predecessor
 * starting no earlier than `est` has done `lag` slots, over its usable modes: a sound lower bound, never
 * earlier than the clock reading est + lag.
 */
const ssReady = (prep: Prepared, a: number, est: number, lag: number, modeOk: Uint8Array): number => {
  if (lag <= 0) return est
  let least = Infinity
  prep.problem.activities[a]!.modes.forEach((mode, m) => {
    if (!modeOk[m]) return
    if (lag >= mode.work || mode.continuous) { least = Math.min(least, est + Math.min(lag, mode.work)); return }
    const k = prep.cal[mode.calendar]!
    const p = k.prefix[Math.min(prep.H, Math.max(0, est))]! + lag - 1
    least = Math.min(least, p < k.list.length ? k.list[p]! + 1 : prep.H)
  })
  return least === Infinity ? est + lag : Math.max(est + lag, least)
}
/** The latest start of predecessor a that has done `lag` slots by `by`, over its usable modes (sound upper bound). */
const ssLatest = (prep: Prepared, a: number, by: number, lag: number, modeOk: Uint8Array): number => {
  if (lag <= 0) return by
  let most = -Infinity
  prep.problem.activities[a]!.modes.forEach((mode, m) => {
    if (!modeOk[m]) return
    if (lag >= mode.work || mode.continuous) { most = Math.max(most, by - Math.min(lag, mode.work)); return }
    const k = prep.cal[mode.calendar]!
    const p = k.prefix[Math.min(prep.H, Math.max(0, by))]! - lag
    most = Math.max(most, p >= 0 ? k.list[p]! : -1)
  })
  return most === -Infinity ? by - lag : Math.min(by - lag, most)
}

/** Resources with at most one unit at any slot, and the activities that need them in every mode. */
const unitResources = (prep: Prepared): Array<{ resource: number; activities: number[]; prefix: Int32Array }> => {
  const { problem, H } = prep
  return problem.resources.flatMap((resource, r) => {
    let max = 0
    for (let t = 0; t < H; t++) max = Math.max(max, resource.capacity[t]!)
    if (max > 1) return []
    const activities = problem.activities.flatMap((activity, a) =>
      activity.modes.every(mode => mode.work > 0 && mode.demands.some(d => d.resource === r && d.when < 0)) ? [a] : [])
    if (activities.length < 2) return []
    const prefix = new Int32Array(H + 1)
    for (let t = 0; t < H; t++) prefix[t + 1] = prefix[t]! + (resource.capacity[t]! > 0 ? 1 : 0)
    return [{ resource: r, activities, prefix }]
  })
}

const minWork = (prep: Prepared, a: number, modeOk?: Uint8Array): number => {
  let best = Infinity
  prep.problem.activities[a]!.modes.forEach((mode, m) => { if (modeOk === undefined || modeOk[m]) best = Math.min(best, mode.work) })
  return best === Infinity ? 0 : best
}

export interface PropagationOptions {
  /** Raised earliest starts and lowered latest finishes (one assumed first-out slot of a span). */
  readonly floor?: Int32Array
  readonly cap?: Int32Array
  /** Span limits as pairwise max-lags (default on). */
  readonly spans?: boolean
  /** One-at-a-time resources checked for overload (default all; [] turns the check off). */
  readonly units?: ReturnType<typeof unitResources>
  /** Let continuous jobs pause: a relaxation, so everything it proves still holds. */
  readonly pausable?: boolean
  readonly help?: Helpers
}

/**
 * One forward pass from the releases and one backward pass from the deadlines, each ignoring the other:
 * earliest starts and latest finishes that hold even when the two cannot meet (the chain test's input).
 */
export const separatePasses = (prep: Prepared): Windows => {
  const { problem, n, H } = prep
  const help = { next: nextWorking(prep) }
  const est = new Int32Array(n), eft = new Int32Array(n), lst = new Int32Array(n), lft = new Int32Array(n)
  const modeOk = problem.activities.map(activity => new Uint8Array(activity.modes.length).fill(1))
  for (const a of prep.topo) {
    const activity = problem.activities[a]!
    let lo = activity.fixed?.start ?? activity.release, ffLo = 0
    for (const l of prep.preds[a]!) {
      if (l.type === 'FS') lo = Math.max(lo, eft[l.from]! + l.min)
      else if (l.type === 'SS') lo = Math.max(lo, est[l.from]! + l.min)
      else ffLo = Math.max(ffLo, eft[l.from]! + l.min)
    }
    let bestS = H, bestF = H
    activity.modes.forEach((mode, m) => {
      const [t, f] = earliest(prep, help, a, m, Math.max(lo, mode.release), ffLo, false)
      if (t >= 0) { bestS = Math.min(bestS, t); bestF = Math.min(bestF, f) }
    })
    est[a] = bestS; eft[a] = bestF
  }
  for (let i = n - 1; i >= 0; i--) {
    const a = prep.topo[i]!
    const activity = problem.activities[a]!
    let hiF = activity.deadline, hiS = H
    for (const l of prep.succs[a]!) {
      if (l.type === 'FS') hiF = Math.min(hiF, lst[l.to]! - l.min)
      else if (l.type === 'SS') hiS = Math.min(hiS, lst[l.to]! - l.min)
      else hiF = Math.min(hiF, lft[l.to]! - l.min)
    }
    let bestS = -1, bestF = -1
    activity.modes.forEach((_, m) => {
      const [t, f] = latest(prep, a, m, hiS, hiF, false)
      if (t >= 0) { bestS = Math.max(bestS, t); bestF = Math.max(bestF, f) }
    })
    lst[a] = bestS; lft[a] = Math.max(0, bestF)
  }
  return { ok: true, est, eft, lst, lft, modeOk }
}

/** Temporal propagation to a fixpoint over logic, calendars, span limits and one-at-a-time overload. */
export const propagate = (prep: Prepared, options: PropagationOptions = {}): Windows => {
  const { problem, n, H } = prep
  const { floor, cap } = options
  const units = options.units ?? unitResources(prep)
  const help = options.help ?? { next: nextWorking(prep) }
  const pausable = options.pausable === true
  const useSpans = options.spans !== false
  const est = new Int32Array(n), eft = new Int32Array(n), lst = new Int32Array(n).fill(H), lft = new Int32Array(n)
  const modeOk = problem.activities.map(activity => new Uint8Array(activity.modes.length).fill(1))
  problem.activities.forEach((activity, a) => {
    lft[a] = Math.min(activity.deadline, cap?.[a] ?? H)
    if (activity.fixed !== undefined) modeOk[a]!.fill(0)[activity.fixed.mode] = 1
  })
  const topo = prep.topo
  const fail = (activity: number, via: NonNullable<Windows['failure']>['via'], resource?: number): Windows =>
    ({ ok: false, est, eft, lst, lft, modeOk, failure: { activity, via, ...(resource === undefined ? {} : { resource }) } })
  for (let round = 0; round < 60; round++) {
    let changed = false
    for (let i = 0; i < n; i++) {
      const a = topo[i]!
      const activity = problem.activities[a]!
      let lo = Math.max(activity.release, floor?.[a] ?? 0), ffLo = 0
      let via: NonNullable<Windows['failure']>['via'] = 'release'
      for (const l of prep.preds[a]!) {
        if (l.type === 'FS' && eft[l.from]! + l.min > lo) { lo = eft[l.from]! + l.min; via = 'link' }
        else if (l.type === 'SS') { const ready = ssReady(prep, l.from, est[l.from]!, l.min, modeOk[l.from]!); if (ready > lo) { lo = ready; via = 'link' } }
        else if (l.type === 'FF') ffLo = Math.max(ffLo, eft[l.from]! + l.min)
      }
      for (const s of useSpans ? prep.opensSpans[a]! : []) {
        const limit = problem.spans[s]!.limit
        if (limit === undefined) continue
        let lastBack = -1
        for (const c of prep.spanClosers[s]!) lastBack = Math.max(lastBack, eft[c]!)
        if (lastBack - limit > lo) { lo = lastBack - limit; via = 'span-limit' }
      }
      if (activity.fixed !== undefined) { if (activity.fixed.start < lo) return fail(a, 'lock'); lo = activity.fixed.start }
      let bestS = H + 1, bestF = H + 1
      activity.modes.forEach((mode, m) => {
        if (!modeOk[a]![m]) return
        const [t, f] = earliest(prep, help, a, m, Math.max(lo, mode.release), ffLo, pausable)
        if (t < 0 || f > lft[a]! || (activity.fixed !== undefined && t !== activity.fixed.start)) { modeOk[a]![m] = 0; return }
        bestS = Math.min(bestS, t); bestF = Math.min(bestF, f)
      })
      if (bestS > H) return fail(a, lft[a]! >= activity.deadline ? via : 'window')
      if (bestS !== est[a] || bestF !== eft[a]) { est[a] = bestS; eft[a] = bestF; changed = true }
    }
    for (let i = n - 1; i >= 0; i--) {
      const a = topo[i]!
      const activity = problem.activities[a]!
      let hiF = Math.min(activity.deadline, cap?.[a] ?? H), hiS = H
      for (const l of prep.succs[a]!) {
        if (l.type === 'FS') hiF = Math.min(hiF, lst[l.to]! - l.min)
        else if (l.type === 'SS') hiS = Math.min(hiS, ssLatest(prep, a, lst[l.to]!, l.min, modeOk[a]!))
        else hiF = Math.min(hiF, lft[l.to]! - l.min)
      }
      for (const s of useSpans ? prep.closesSpans[a]! : []) {
        const limit = problem.spans[s]!.limit
        if (limit === undefined) continue
        let firstOut = H
        for (const o of prep.spanOpeners[s]!) firstOut = Math.min(firstOut, lst[o]!)
        hiF = Math.min(hiF, firstOut + limit)
      }
      let bestS = -1, bestF = -1
      activity.modes.forEach((_, m) => {
        if (!modeOk[a]![m]) return
        const [t, f] = latest(prep, a, m, hiS, hiF, pausable)
        if (t < 0 || t < est[a]!) { modeOk[a]![m] = 0; return }
        bestS = Math.max(bestS, t); bestF = Math.max(bestF, f)
      })
      if (bestS < 0) return fail(a, 'window')
      if (bestS !== lst[a] || bestF !== lft[a]) { lst[a] = bestS; lft[a] = bestF; changed = true }
    }
    // Overload: jobs that all need one unit of a one-at-a-time resource cannot share its slots.
    for (const unit of units) {
      const list = unit.activities.filter(a => problem.activities[a]!.modes.some((_, m) => modeOk[a]![m]))
      const byLft = [...list].sort((x, y) => lft[x]! - lft[y]!)
      for (const anchor of list) {
        const from = est[anchor]!
        let work = 0
        for (const a of byLft) {
          if (est[a]! < from) continue
          work += minWork(prep, a, modeOk[a])
          const to = lft[a]!
          if (to > from && work > unit.prefix[to]! - unit.prefix[from]!) return fail(a, 'overload', unit.resource)
          if (to <= from && work > 0) return fail(a, 'overload', unit.resource)
        }
      }
    }
    if (!changed) return { ok: true, est, eft, lst, lft, modeOk }
  }
  return { ok: true, est, eft, lst, lft, modeOk }
}

const slotIso = (index: CompileIndex, slot: number): string => new Date(index.origin + slot * index.slotMs).toISOString()
const hours = (index: CompileIndex, slots: number): number => slots * index.slotMs / 3_600_000
const jobKey = (problem: NormalizedProblem, index: CompileIndex, a: number): string => index.jobs[a] ?? problem.activities[a]!.id.replace(/[^A-Za-z0-9._-]/g, '-')

/** The union of every mode calendar an activity may use. */
const activityMask = (prep: Prepared, a: number, modeOk?: Uint8Array): number[] =>
  [...new Set(prep.problem.activities[a]!.modes.flatMap((mode, m) => (modeOk === undefined || modeOk[m] ? [mode.calendar] : [])))]

/** Chain certificate: work done one after another against the working slots of the union of the chain's calendars. */
export const chainCertificate = (prep: Prepared, windows: Windows, index: CompileIndex): Certificate | undefined => {
  const { problem, n } = prep
  const work = problem.activities.map((_, a) => minWork(prep, a, windows.modeOk[a]))
  const cals = problem.activities.map((_, a) => activityMask(prep, a, windows.modeOk[a]))
  let best: { margin: number; path: number[]; work: number; available: number; from: number; to: number } | undefined
  const order = prep.topo
  const position = new Int32Array(n)
  order.forEach((a, i) => { position[a] = i })
  for (const s of order) {
    if (work[s]! === 0) continue
    const total = new Float64Array(n).fill(-1), parent = new Int32Array(n).fill(-1)
    total[s] = work[s]!
    for (let i = position[s]!; i < n; i++) {
      const a = order[i]!
      if (total[a]! < 0) continue
      for (const l of prep.succs[a]!) {
        if (l.type !== 'FS') continue
        const candidate = total[a]! + work[l.to]!
        if (candidate > total[l.to]!) { total[l.to] = candidate; parent[l.to] = a }
      }
    }
    const from = windows.est[s]!
    for (let j = 0; j < n; j++) {
      if (total[j]! <= 0) continue
      const to = windows.lft[j]!
      if (to <= from) continue
      const path: number[] = []
      for (let x = j; x >= 0; x = x === s ? -1 : parent[x]!) path.push(x)
      const calendars = [...new Set(path.flatMap(a => cals[a]!))]
      const counts = calendars.map(c => prep.cal[c]!.prefix[to]! - prep.cal[c]!.prefix[from]!)
      if (total[j]! <= Math.max(0, ...counts)) continue
      let available = counts.reduce((x, y) => x + y, 0)
      if (total[j]! <= available) {
        available = 0
        for (let t = from; t < to; t++) if (calendars.some(c => prep.cal[c]!.pos[t]! >= 0)) available++
      }
      // The chain that runs to the latest finish, then the widest margin, then the most work: for V1
      // the whole SW A sequence from the crane's arrival to the reconnect (37 h against 32 h).
      const margin = total[j]! - available
      const wins = best === undefined || to > best.to || (to === best.to && (margin > best.margin || (margin === best.margin && total[j]! > best.work)))
      if (margin > 0 && wins) best = { margin, path: path.reverse(), work: total[j]!, available, from, to }
    }
  }
  if (best === undefined) return undefined
  const calendarKeys = [...new Set(best.path.flatMap(a => problem.activities[a]!.modes.flatMap(mode => mode.demands.flatMap(d => index.resourceCalendars[d.resource] ?? []))))]
  return {
    kind: 'chain', jobs: best.path.map(a => jobKey(problem, index, a)).slice(0, 64), workHours: hours(index, best.work), calendars: calendarKeys,
    availableHours: hours(index, best.available), from: slotIso(index, best.from), by: slotIso(index, best.to),
  }
}

/** Candidate resource pools: each resource alone, and with every resource that can stand in for it. */
/**
 * Candidate resource pools: each resource alone, and with every resource that can stand in for it in some
 * need (anyOf), including one with no hours in this sub-solve (it counts with zero capacity).
 */
const pools = (prep: Prepared, index: CompileIndex): number[][] => {
  const { problem } = prep
  const seen = new Set<string>()
  const out: number[][] = []
  const add = (pool: number[]): void => { const key = [...pool].sort((x, y) => x - y).join(','); if (!seen.has(key)) { seen.add(key); out.push([...pool].sort((x, y) => x - y)) } }
  problem.resources.forEach((_, r) => {
    add([r])
    const closure = new Set([r])
    for (const needs of index.needs) for (const anyOf of needs) if (anyOf.includes(r)) for (const other of anyOf) closure.add(other)
    add([...closure])
  })
  return out
}

/** Per mode: the least amount of pool resources every worked slot needs (0 if some slot needs none). */
const poolPerSlot = (prep: Prepared, a: number, m: number, pool: ReadonlySet<number>): number => {
  const mode = prep.problem.activities[a]!.modes[m]!
  const onPool = mode.demands.filter(d => pool.has(d.resource))
  if (onPool.length === 0 || mode.work === 0) return 0
  if (onPool.some(d => d.when < 0)) return onPool.filter(d => d.when < 0).reduce((sum, d) => sum + d.amount, 0)
  // Split demands (handover): every working slot of the mode is served by exactly one of them.
  const k = prep.cal[mode.calendar]!
  let least = Infinity
  for (let p = 0; p < k.list.length; p++) {
    const x = k.list[p]!
    let sum = 0
    for (const d of onPool) if (prep.cal[d.when]!.pos[x]! >= 0) sum += d.amount
    least = Math.min(least, sum)
    if (least === 0) break
  }
  return least === Infinity ? 0 : least
}

/** Work of activity a (pool units x slots) that must fall inside [from, to), given its window. */
const insideWork = (prep: Prepared, windows: Windows, a: number, from: number, to: number, perSlot: (m: number) => number): number => {
  const activity = prep.problem.activities[a]!
  let least = Infinity
  activity.modes.forEach((mode, m) => {
    if (!windows.modeOk[a]![m]) return
    const amount = perSlot(m)
    if (amount === 0) { least = 0; return }
    const k = prep.cal[mode.calendar]!
    const lo = windows.est[a]!, hi = windows.lft[a]!
    const before = lo < from ? k.prefix[Math.min(from, hi)]! - k.prefix[lo]! : 0
    const after = hi > to ? k.prefix[hi]! - k.prefix[Math.max(to, lo)]! : 0
    least = Math.min(least, amount * Math.max(0, mode.work - before - after))
  })
  return least === Infinity ? 0 : least
}

const capacityIn = (prep: Prepared, pool: readonly number[], from: number, to: number): number => {
  let sum = 0
  for (const r of pool) { const capacity = prep.problem.resources[r]!.capacity; for (let t = Math.max(0, from); t < Math.min(to, prep.H); t++) sum += capacity[t]! }
  return sum
}

interface SpanScan {
  readonly window: SpanWindow
  /** Feasible first-out slots and, for each, the least span length logic and calendars allow. */
  readonly lengths: ReadonlyArray<{ readonly start: number; readonly length: number }>
  readonly energy?: { readonly pool: number[]; readonly required: number; readonly available: number; readonly jobs: number[] }
  readonly allTemporal: boolean
}

/**
 * Tries every first-out slot of span s; checks logic, overload and (with a limit) the span's energy for
 * each. `pausable` scans the relaxation where continuous jobs may pause, which keeps a slot that only
 * continuity rules out, so the energy count is tested there too.
 */
const scanSpan = (prep: Prepared, global: Windows, s: number, index: CompileIndex, units: ReturnType<typeof unitResources>, help: Helpers, pausable: boolean): SpanScan & { readonly lastFailure?: Windows } => {
  const { problem, n, H } = prep
  const span = problem.spans[s]!
  const openers = prep.spanOpeners[s]!, closers = prep.spanClosers[s]!
  const info = index.spans[s]!
  const empty: SpanScan = { window: { span: info.id, ...(info.rule === undefined ? {} : { rule: info.rule }), from: 0, to: 0, feasibleStarts: 0 }, lengths: [], allTemporal: false }
  if (openers.length === 0 || closers.length === 0) return empty
  let first = H, last = H
  for (const o of openers) { first = Math.min(first, global.est[o]!); last = Math.min(last, global.lst[o]!) }
  // Widest pools first: a proof must count every resource that could stand in for the work (lane K checks).
  const candidatePools = span.limit === undefined ? [] : pools(prep, index).sort((x, y) => y.length - x.length)
  const lengths: Array<{ start: number; length: number }> = []
  const perPool = candidatePools.map(pool => ({ pool, set: new Set(pool), minRequired: Infinity, maxAvailable: -Infinity, failsEverywhere: true, jobs: new Set<number>() }))
  let temporalOnly = true
  let lo = -1, hi = -1
  let lastFailure: Windows | undefined
  for (let start = first; start <= last; start++) {
    const floor = new Int32Array(n), cap = new Int32Array(n).fill(H)
    for (const o of openers) floor[o] = start
    if (span.limit !== undefined) for (const c of closers) cap[c] = start + span.limit
    const windows = propagate(prep, { floor, cap, units, help, pausable })
    if (!windows.ok) { lastFailure = windows; continue }
    temporalOnly = false
    if (lo < 0) lo = start
    hi = start + 1
    let back = 0
    for (const c of closers) back = Math.max(back, windows.eft[c]!)
    lengths.push({ start, length: back - start })
    if (span.limit === undefined) continue
    const to = start + span.limit
    for (const entry of perPool) {
      if (!entry.failsEverywhere) continue
      let required = 0
      const contributing: number[] = []
      for (let a = 0; a < n; a++) {
        const work = insideWork(prep, windows, a, start, to, m => poolPerSlot(prep, a, m, entry.set))
        if (work > 0) { required += work; contributing.push(a) }
      }
      const available = capacityIn(prep, entry.pool, start, to)
      if (required > available) {
        entry.minRequired = Math.min(entry.minRequired, required)
        entry.maxAvailable = Math.max(entry.maxAvailable, available)
        for (const a of contributing) entry.jobs.add(a)
      } else entry.failsEverywhere = false
    }
  }
  const window: SpanWindow = { span: info.id, ...(info.rule === undefined ? {} : { rule: info.rule }), from: lo < 0 ? first : lo, to: hi < 0 ? first : hi, feasibleStarts: lengths.length }
  const proof = lengths.length === 0 ? undefined : perPool.find(entry => entry.failsEverywhere && entry.minRequired > entry.maxAvailable)
  return {
    window, lengths, allTemporal: temporalOnly && last >= first, ...(lastFailure === undefined ? {} : { lastFailure }),
    ...(proof === undefined ? {} : { energy: { pool: proof.pool, required: proof.minRequired, available: proof.maxAvailable, jobs: [...proof.jobs] } }),
  }
}

type TemporalStep = Extract<Certificate, { kind: 'temporal' }>['steps'][number]
const temporalCertificate = (prep: Prepared, windows: Windows, index: CompileIndex): Certificate => ({ kind: 'temporal', steps: temporalSteps(prep, windows, index) })
const temporalSteps = (prep: Prepared, windows: Windows, index: CompileIndex): TemporalStep[] => {
  const { problem } = prep
  const failure = windows.failure!
  const steps: TemporalStep[] = []
  const viaOf = (via: NonNullable<Windows['failure']>['via']): 'link' | 'span-limit' | 'window' | 'release' | 'lock' => (via === 'overload' ? 'window' : via)
  const viaFirst = viaOf(failure.via)
  steps.push({ job: jobKey(problem, index, failure.activity), via: viaFirst === 'window' && index.dueRules[failure.activity] !== undefined ? 'due' : viaFirst })
  // Walk back the links that set the earliest start, so the reader can follow the chain.
  let a = failure.activity
  for (let hop = 0; hop < 30; hop++) {
    const binding = prep.preds[a]!.find(l => (l.type === 'FS' ? windows.eft[l.from]! + l.min : l.type === 'SS' ? windows.est[l.from]! + l.min : -1) === windows.est[a]!)
    if (binding === undefined) break
    a = binding.from
    steps.push({ job: jobKey(problem, index, a), via: binding.origin === 'bracket' || binding.origin === 'support-order' ? binding.origin : 'link' })
  }
  return steps.slice(0, 32)
}

/**
 * The least span logic and calendars allow for span s with no limit: the first-out slot that gives it, and
 * the chain from that first tag-out to the last test back (each job set by the one before it).
 */
const leastSpan = (prep: Prepared, base: Windows, s: number, units: ReturnType<typeof unitResources>, help: Helpers, index: CompileIndex): Omit<SpanRefusal, 'rule' | 'limitHours' | 'alsoProven'> & { first: number } | undefined => {
  const { problem, n, H } = prep
  const openers = prep.spanOpeners[s]!, closers = prep.spanClosers[s]!
  const at = (start: number): { length: number; windows: Windows } | undefined => {
    const floor = new Int32Array(n)
    for (const o of openers) floor[o] = start
    const windows = propagate(prep, { floor, spans: false, units, help })
    if (!windows.ok) return undefined
    let back = 0
    for (const c of closers) back = Math.max(back, windows.eft[c]!)
    return { length: back - start, windows }
  }
  const chain = (windows: Windows): ChainStep[] => {
    let a = closers.reduce((x, y) => (windows.eft[y]! > windows.eft[x]! ? y : x), closers[0]!)
    const path: Array<{ a: number; via: ChainStep['via'] }> = []
    const openerSet = new Set(openers)
    const implied = (l: NormalizedProblem['links'][number]) => (l.type === 'FS' ? windows.eft[l.from]! + l.min : l.type === 'SS' ? ssReady(prep, l.from, windows.est[l.from]!, l.min, windows.modeOk[l.from]!) : -1)
    for (let hop = 0; hop < 40 && !openerSet.has(a); hop++) {
      const binding = prep.preds[a]!.filter(l => l.type !== 'FF').sort((x, y) => implied(y) - implied(x))[0]
      if (binding === undefined) break
      // Each step says what ties it to the job before it: a planner link, bracketing or support order
      // (tag-before-test is bracketing's own rule and reads as a link, as in temporalSteps).
      path.push({ a, via: binding.origin === 'bracket' || binding.origin === 'support-order' ? binding.origin : 'link' })
      a = binding.from
    }
    path.push({ a, via: 'span-limit' })
    return path.reverse().map(({ a: b, via }) => ({ job: jobKey(problem, index, b), start: slotIso(index, windows.est[b]!), finish: slotIso(index, windows.eft[b]!), via }))
  }
  let best: { start: number; length: number; windows: Windows } | undefined
  let first = H, last = H
  for (const o of openers) { first = Math.min(first, base.est[o]!); last = Math.min(last, base.lst[o]!) }
  for (let start = first; start <= last; start++) {
    const found = at(start)
    if (found !== undefined && (best === undefined || found.length < best.length)) best = { start, ...found }
  }
  if (best === undefined) return undefined
  // Why tagging out later does not help: the least span over every later first-out slot.
  let after: { start: number; length: number; windows: Windows } | undefined
  for (let start = best.start + 1; start <= last; start++) {
    const found = at(start)
    if (found !== undefined && (after === undefined || found.length < after.length)) after = { start, ...found }
  }
  return {
    first: best.start, leastHours: hours(index, best.length), firstOut: slotIso(index, best.start), lastBack: slotIso(index, best.start + best.length), path: chain(best.windows),
    ...(after === undefined ? {} : { later: { firstOut: slotIso(index, after.start), lastBack: slotIso(index, after.start + after.length), hours: hours(index, after.length), path: chain(after.windows) } }),
  }
}

/**
 * All bounds of one compiled sub-solve: a certificate when one proves infeasibility, else per-goal
 * lower bounds on the raw metrics (goal units, no threshold) and the span windows found.
 */
export const bounds = (problem: NormalizedProblem, index: CompileIndex, prep: Prepared = prepare(problem)): BoundsResult => {
  const units = unitResources(prep)
  const help = { next: nextWorking(prep) }
  const zeroGoals = problem.goals.map(() => ({ value: 0, source: 'logic+calendars' as const }))
  const spanCertificate = (s: number, scan: SpanScan & { readonly lastFailure?: Windows }): Certificate | undefined => {
    if (problem.spans[s]!.limit === undefined) return undefined
    const key = index.spans[s]!.rule ?? index.spans[s]!.id.replace(/[^A-Za-z0-9._-]/g, '-')
    if (scan.energy !== undefined) {
      const energy = scan.energy
      return {
        kind: 'energy', resources: energy.pool.map(r => index.resources[r]!).slice(0, 8), jobs: energy.jobs.map(a => jobKey(problem, index, a)).slice(0, 128),
        requiredHours: hours(index, energy.required), availableHours: hours(index, energy.available),
        from: slotIso(index, scan.window.from), to: slotIso(index, scan.window.to), span: key,
      }
    }
    if (!scan.allTemporal) return undefined
    // Every first-out slot fails logic and calendars: the span limit is the cause, then the failing chain.
    const tail = scan.lastFailure === undefined ? [] : temporalSteps(prep, scan.lastFailure, index)
    return { kind: 'temporal', steps: [{ job: jobKey(problem, index, prep.spanOpeners[s]![0]!), via: 'span-limit' as const }, ...tail].slice(0, 32) }
  }
  // 1. A chain whose work exceeds its calendars' working slots, from separate forward and backward passes.
  const chain = chainCertificate(prep, separatePasses(prep), index)
  if (chain !== undefined) return { certificate: chain, goals: zeroGoals, spanWindows: [] }
  // 2. Logic, releases, window and calendars alone (no span limit, no overload).
  const plain = propagate(prep, { spans: false, units: [], help })
  if (!plain.ok) return { certificate: temporalCertificate(prep, plain, index), goals: zeroGoals, spanWindows: [] }
  // 3. A span limit no first-out slot can meet by time (logic, calendars, continuity, one at a time):
  //    the refusal names the least span possible against the limit; an energy proof is kept beside it.
  const unlimited = propagate(prep, { spans: false, units, help })
  if (!unlimited.ok) return { certificate: temporalCertificate(prep, unlimited, index), goals: zeroGoals, spanWindows: [] }
  const relaxed = propagate(prep, { units, help, pausable: true })
  for (let s = 0; s < problem.spans.length; s++) {
    const limit = problem.spans[s]!.limit
    if (limit === undefined) continue
    const byTime = scanSpan(prep, unlimited, s, index, units, help, false)
    const energyScan = relaxed.ok ? scanSpan(prep, relaxed, s, index, units, help, true) : undefined
    const energy = energyScan?.energy === undefined ? undefined : spanCertificate(s, { ...energyScan, allTemporal: false })
    if (!byTime.allTemporal) {
      if (energy !== undefined) return { certificate: energy, goals: zeroGoals, spanWindows: [energyScan!.window] }
      continue
    }
    const least = leastSpan(prep, unlimited, s, units, help, index)
    const rule = index.spans[s]!.rule ?? index.spans[s]!.id
    const steps = least === undefined ? [{ job: jobKey(problem, index, prep.spanOpeners[s]![0]!), via: 'span-limit' as const }]
      : least.path.map(step => ({ job: step.job, via: step.via }))
    const { first: _first, ...refusal } = least ?? { first: 0 }
    return {
      certificate: { kind: 'temporal', steps: steps.slice(0, 32) }, goals: zeroGoals, spanWindows: [byTime.window],
      ...(least === undefined ? {} : { span: { rule, limitHours: hours(index, limit), ...(refusal as Omit<SpanRefusal, 'rule' | 'limitHours'>), ...(energy === undefined ? {} : { alsoProven: energy }) } }),
    }
  }
  // 4. Everything together: span limits as max-lags, overload, continuity.
  const global = propagate(prep, { units, help })
  if (!global.ok) return { certificate: temporalCertificate(prep, global, index), goals: zeroGoals, spanWindows: [] }
  const scans = problem.spans.map((_, s) => scanSpan(prep, global, s, index, units, help, false))
  for (const [s, scan] of scans.entries()) {
    const certificate = spanCertificate(s, scan)
    if (certificate !== undefined) return { certificate, goals: zeroGoals, spanWindows: scans.map(entry => entry.window) }
  }
  const goals = problem.goals.map((goal): { value: number | number[]; source: BoundSource } => {
    const scale = goal.metric === 'extra-cost' ? 1 : problem.slotMs / unitMs(goal.unit)
    // span-over: one least length per group (the excess is monotone in each span).
    if (goal.metric === 'span-over') {
      return { value: (goal.spans ?? []).map(s => { const lengths = scans[s]!.lengths; return lengths.length === 0 ? 0 : Math.min(...lengths.map(entry => entry.length)) * scale }), source: 'logic+calendars' }
    }
    if (goal.metric === 'finish') {
      let finish = 0
      for (let a = 0; a < prep.n; a++) finish = Math.max(finish, global.eft[a]!)
      const energy = energyFinish(prep)
      return energy !== undefined && energy.slot > finish ? { value: energy.slot * scale, source: 'crew-energy' } : { value: finish * scale, source: 'logic+calendars' }
    }
    if (goal.metric === 'extra-cost') {
      let fixed = 0
      problem.activities.forEach((activity, a) => {
        let least = Infinity
        activity.modes.forEach((mode, m) => { if (global.modeOk[a]![m]) least = Math.min(least, mode.fixedCost) })
        if (least !== Infinity) fixed += least
      })
      for (const resource of problem.resources) {
        for (const period of resource.periods) if (period.committed) fixed += period.price
        for (const item of resource.once) if (item.committed) fixed += item.price
      }
      return { value: fixed, source: 'fixed-costs' }
    }
    if (goal.metric === 'unavailable-hours') {
      const items = goal.spans === undefined ? problem.items.map((_, i) => i) : [...new Set(goal.spans.flatMap(s => problem.spans[s]!.items))]
      let total = 0
      for (const i of items) {
        const item = problem.items[i]!
        if (item.openers.length === 0 || item.closers.length === 0) continue
        let lastBack = 0, firstOutLatest = prep.H
        for (const c of item.closers) lastBack = Math.max(lastBack, global.eft[c]!)
        for (const o of item.openers) firstOutLatest = Math.min(firstOutLatest, global.lst[o]!)
        total += Math.max(0, lastBack - firstOutLatest)
      }
      return { value: total * scale, source: 'logic+calendars' }
    }
    let late = 0
    for (const a of goal.tagged ?? []) { const target = problem.activities[a]!.target; if (target !== undefined) late += Math.max(0, global.eft[a]! - target) }
    return { value: late * scale, source: 'logic+calendars' }
  })
  const energy = energyFinish(prep)
  return { goals, spanWindows: scans.map(scan => scan.window), ...(energy === undefined ? {} : { busiest: { resource: index.resources[energy.resource]!, finishBy: slotIso(index, energy.slot), loadShare: energy.load } }) }
}

/**
 * Crew-energy finish bound (or's bench bounds): the work that needs resource r in every mode, against r's
 * capacity counted from the start; the last finish is at least the slot where that capacity suffices.
 * Returns the resource that binds most, and its load share of the window's capacity.
 */
export const energyFinish = (prep: Prepared): { readonly resource: number; readonly slot: number; readonly load: number } | undefined => {
  const { problem, H } = prep
  let best: { resource: number; slot: number; load: number } | undefined
  problem.resources.forEach((resource, r) => {
    let need = 0
    for (const activity of problem.activities) {
      if (!activity.modes.every(mode => mode.work === 0 || mode.demands.some(d => d.resource === r && d.when < 0))) continue
      need += Math.min(...activity.modes.map(mode => mode.work * (mode.demands.find(d => d.resource === r)?.amount ?? 0)))
    }
    if (need === 0) return
    let sum = 0, slot = 0
    while (slot < H && sum < need) sum += resource.capacity[slot++]!
    const window = problem.activities.reduce((latest, activity) => Math.max(latest, activity.deadline), 0)
    let capacity = 0
    for (let t = 0; t < window; t++) capacity += resource.capacity[t]!
    const load = capacity > 0 ? need / capacity : Infinity
    if (sum < need) slot = H
    if (best === undefined || slot > best.slot || (slot === best.slot && load > best.load)) best = { resource: r, slot, load }
  })
  return best
}
