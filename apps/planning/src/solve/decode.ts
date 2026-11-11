// Calendar-aware serial schedule generation on the plan grid, ported from or's bench decoder
// (R/or/gate/src/sgs.ts) onto the NormalizedProblem seam. It places activities in list order at their
// earliest slot that meets links (FS/SS/FF clock lags), releases, calendars (pausable or continuous),
// capacity per slot, replaced booked time, maxJobs and keep-in-service rules. A span limit (first
// out to last back) that overruns is repaired by raising the openers' earliest start and restarting.
// The independent checker re-verifies every result; nothing here is trusted for feasibility.
import type { NormalizedProblem, Schedule } from './problem.ts'

const unitMsTable: Readonly<Record<string, number>> = { s: 1_000, min: 60_000, h: 3_600_000 }
/** Milliseconds per time goal unit ('h', 'min', 's'); compile refuses any other time unit. */
export const unitMs = (unit: string): number => {
  const ms = unitMsTable[unit]
  if (ms === undefined) throw new RangeError(`Not a time goal unit: ${unit}`)
  return ms
}

type Link = NormalizedProblem['links'][number]

export interface CalendarIndex {
  /** Working slots in order. */
  readonly list: Int32Array
  /** Position of slot t in `list`, or -1. */
  readonly pos: Int32Array
  /** Consecutive working slots from t. */
  readonly run: Int32Array
  /** prefix[t] = working slots in [0, t). */
  readonly prefix: Int32Array
}

export interface Prepared {
  readonly problem: NormalizedProblem
  readonly n: number
  readonly H: number
  readonly cal: readonly CalendarIndex[]
  readonly preds: ReadonlyArray<readonly Link[]>
  readonly succs: ReadonlyArray<readonly Link[]>
  readonly topo: Int32Array
  /** Per item: openers and closers, its own and every transitive supporter's. */
  readonly itemOpeners: ReadonlyArray<readonly number[]>
  readonly itemClosers: ReadonlyArray<readonly number[]>
  readonly opensItems: ReadonlyArray<readonly number[]>
  readonly closesItems: ReadonlyArray<readonly number[]>
  readonly spanOpeners: ReadonlyArray<readonly number[]>
  readonly spanClosers: ReadonlyArray<readonly number[]>
  readonly opensSpans: ReadonlyArray<readonly number[]>
  readonly closesSpans: ReadonlyArray<readonly number[]>
  /** Equipment keep-in-service rules each activity can take a member out of. */
  readonly opensCoverage: ReadonlyArray<readonly number[]>
  readonly resourceCoverage: ReadonlyArray<readonly number[]>
  readonly purchases: readonly string[]
  /** Per resource and slot: the purchase whose period holds the slot, and the purchase whose use forbids it. */
  readonly periodPurchase: readonly Int16Array[]
  readonly forbiddenBy: readonly Int16Array[]
  /**
   * finish[a][m][t]: the finish of activity a in mode m started at slot t (t in 0..H), or -1. next[a][m][t]:
   * the first t' >= t with a finish, or H + 1. Built per prepare() call from this problem only, so nothing
   * is shared between problems or solves.
   */
  readonly finish: ReadonlyArray<readonly Int32Array[]>
  readonly next: ReadonlyArray<readonly Int32Array[]>
}

const indexCalendar = (work: Uint8Array, H: number): CalendarIndex => {
  const list: number[] = []
  const pos = new Int32Array(H).fill(-1)
  const run = new Int32Array(H + 1)
  const prefix = new Int32Array(H + 1)
  for (let t = 0; t < H; t++) { prefix[t + 1] = prefix[t]! + (work[t] ? 1 : 0); if (work[t]) { pos[t] = list.length; list.push(t) } }
  for (let t = H - 1; t >= 0; t--) run[t] = work[t] ? run[t + 1]! + 1 : 0
  return { list: Int32Array.from(list), pos, run, prefix }
}

export const prepare = (problem: NormalizedProblem): Prepared => {
  const n = problem.activities.length, H = problem.horizon
  const cal = problem.calendars.map(calendar => indexCalendar(calendar.work, H))
  const preds: Link[][] = Array.from({ length: n }, () => [])
  const succs: Link[][] = Array.from({ length: n }, () => [])
  for (const link of problem.links) { preds[link.to]!.push(link); succs[link.from]!.push(link) }
  const indegree = preds.map(list => list.length)
  const topo: number[] = []
  const queue = indegree.flatMap((degree, a) => (degree === 0 ? [a] : []))
  for (let head = 0; head < queue.length; head++) {
    const a = queue[head]!
    topo.push(a)
    for (const link of succs[a]!) if (--indegree[link.to]! === 0) queue.push(link.to)
  }
  if (topo.length !== n) throw new RangeError('The links form a cycle; compile refuses such plans')
  const supporters = (item: number, seen = new Set<number>()): number[] => {
    for (const s of problem.items[item]!.supportedBy) if (!seen.has(s)) { seen.add(s); supporters(s, seen) }
    return [...seen]
  }
  const itemOpeners = problem.items.map((item, i) => [...new Set([...item.openers, ...supporters(i).flatMap(s => problem.items[s]!.openers)])])
  const itemClosers = problem.items.map((item, i) => [...new Set([...item.closers, ...supporters(i).flatMap(s => problem.items[s]!.closers)])])
  const invert = (lists: ReadonlyArray<readonly number[]>): number[][] => {
    const out: number[][] = Array.from({ length: n }, () => [])
    lists.forEach((list, index) => { for (const a of list) out[a]!.push(index) })
    return out
  }
  const spanOpeners = problem.spans.map(span => [...new Set(span.items.flatMap(i => itemOpeners[i]!))])
  const spanClosers = problem.spans.map(span => [...new Set(span.items.flatMap(i => itemClosers[i]!))])
  const opensItems = invert(itemOpeners)
  const opensCoverage = opensItems.map(items => problem.coverage.flatMap((rule, c) => (rule.items.some(i => items.includes(i)) ? [c] : [])))
  const resourceCoverage = problem.resources.map((_, r) => problem.coverage.flatMap((rule, c) => (rule.resources.includes(r) ? [c] : [])))
  const purchases = [...new Set(problem.resources.flatMap(resource => [...resource.periods.map(p => p.purchase), ...resource.forbiddenWhenUsed.map(p => p.purchase)]))]
  const purchaseOf = new Map(purchases.map((key, index) => [key, index]))
  const periodPurchase = problem.resources.map(resource => {
    const slots = new Int16Array(H).fill(-1)
    for (const period of resource.periods) slots.fill(purchaseOf.get(period.purchase)!, period.from, period.to)
    return slots
  })
  const forbiddenBy = problem.resources.map(resource => {
    const slots = new Int16Array(H).fill(-1)
    for (const period of resource.forbiddenWhenUsed) slots.fill(purchaseOf.get(period.purchase)!, period.from, period.to)
    return slots
  })
  const finish = problem.activities.map(activity => activity.modes.map(mode => {
    const table = new Int32Array(H + 1).fill(-1)
    if (mode.work === 0) { for (let t = 0; t <= H; t++) table[t] = t; return table }
    const k = cal[mode.calendar]!
    if (mode.continuous) { for (let t = 0; t < H; t++) if (k.run[t]! >= mode.work) table[t] = t + mode.work; return table }
    for (let p = 0; p + mode.work - 1 < k.list.length; p++) table[k.list[p]!] = k.list[p + mode.work - 1]! + 1
    return table
  }))
  const next = finish.map(modes => modes.map(table => {
    const out = new Int32Array(H + 2).fill(H + 1)
    for (let t = H; t >= 0; t--) out[t] = table[t]! >= 0 ? t : out[t + 1]!
    return out
  }))
  return {
    problem, n, H, cal, preds, succs, topo: Int32Array.from(topo), itemOpeners, itemClosers, opensItems, closesItems: invert(itemClosers),
    spanOpeners, spanClosers, opensSpans: invert(spanOpeners), closesSpans: invert(spanClosers), opensCoverage, resourceCoverage,
    purchases, periodPurchase, forbiddenBy, finish, next,
  }
}

/** Finish slot of activity a in mode m started at t, or -1 when the mode cannot start there. */
export const finishOf = (prep: Prepared, a: number, m: number, t: number): number =>
  t >= 0 && t <= prep.H ? prep.finish[a]![m]![t]! : -1

/** The slots activity a works in mode m from t; finishOf must be >= 0. */
export const workedSlots = (prep: Prepared, a: number, m: number, t: number): Int32Array => {
  const mode = prep.problem.activities[a]!.modes[m]!
  if (mode.work === 0) return new Int32Array(0)
  if (mode.continuous) { const out = new Int32Array(mode.work); for (let i = 0; i < mode.work; i++) out[i] = t + i; return out }
  const k = prep.cal[mode.calendar]!
  const p = k.pos[t]!
  return k.list.subarray(p, p + mode.work)
}

export const applies = (prep: Prepared, when: number, slot: number): boolean => when < 0 || prep.cal[when]!.pos[slot]! >= 0
/**
 * Lags (controls review, coordinator decision): FS is clock time, a wait. SS lag L: the successor may
 * start once the predecessor has done L of its own working time. FF lag L: the successor finishes no
 * earlier than the predecessor and at least L of its working time falls after the predecessor's finish.
 * Each implies the clock-time reading, so clock-time bounds stay sound.
 */
/** The slot by which a (mode m, started at t) has done `work` slots of its own working time. */
export const progressAt = (prep: Prepared, a: number, m: number, t: number, work: number): number => {
  const mode = prep.problem.activities[a]!.modes[m]!
  if (work <= 0) return t
  if (work >= mode.work) return finishOf(prep, a, m, t)
  if (mode.continuous) return t + work
  const k = prep.cal[mode.calendar]!
  return k.list[k.pos[t]! + work - 1]! + 1
}
/** Worked slots of a (mode m, started at t) at or after slot x. */
export const workedFrom = (prep: Prepared, a: number, m: number, t: number, x: number): number => {
  const mode = prep.problem.activities[a]!.modes[m]!
  if (mode.work === 0) return 0
  if (mode.continuous) return Math.max(0, t + mode.work - Math.max(t, x))
  const k = prep.cal[mode.calendar]!
  const p = k.pos[t]!
  return Math.max(0, p + mode.work - Math.max(p, k.prefix[Math.max(0, Math.min(prep.H, x))]!))
}
/** Whether an FF link of `lag` slots holds between a predecessor finish and a placed successor. */
export const ffHolds = (prep: Prepared, a: number, m: number, t: number, predFinish: number, lag: number): boolean => {
  const f = finishOf(prep, a, m, t)
  return f >= predFinish && (lag <= 0 || workedFrom(prep, a, m, t, predFinish) >= lag)
}


/** Why a placement is refused (for explanations): none, a full resource, replaced time, maxJobs, a keep-in-service rule. */
export type Refusal =
  | { readonly kind: 'none' }
  | { readonly kind: 'capacity'; readonly resource: number; readonly slot: number }
  | { readonly kind: 'replaced'; readonly resource: number; readonly purchase: string }
  | { readonly kind: 'max-jobs'; readonly resource: number }
  | { readonly kind: 'coverage'; readonly rule: number }

export interface Decoded {
  readonly start: Int32Array
  readonly finish: Int32Array
  readonly mode: Int32Array
  /** 0 = every modelled rule met by construction (still re-checked independently). */
  readonly penalty: number
  readonly restarts: number
  readonly note: string
}

export interface Evaluation {
  readonly penalty: number
  /** Raw goal metrics in each goal's unit, no threshold applied; span-over gives one span per group. */
  readonly raw: ReadonlyArray<number | readonly number[]>
  readonly cost: number
  /** Purchases with any use, by key. */
  readonly used: readonly string[]
}

const MAX_RESTARTS = 30

export const makeDecoder = (prep: Prepared) => {
  const { problem, n, H } = prep
  const R = problem.resources.length
  const P = prep.purchases.length
  const usage = Array.from({ length: R }, () => new Int16Array(H))
  const jobCount = new Int32Array(R)
  const purchaseUse = new Int32Array(P)
  const forbiddenUse = new Int32Array(P)
  const localUse = new Int32Array(P)
  const localForbidden = new Int32Array(P)
  const extra = new Int16Array(R)
  // inSpan[a]: a span opener, or a descendant of one that also precedes a closer of the same span.
  const inSpan = new Uint8Array(n)
  const isCloser = new Uint8Array(n)
  problem.items.forEach((_, i) => { for (const c of prep.itemClosers[i]!) isCloser[c] = 1 })
  problem.spans.forEach((_, s) => {
    const down = new Set<number>(prep.spanOpeners[s]), stack = [...prep.spanOpeners[s]!]
    while (stack.length > 0) { const x = stack.pop()!; for (const l of prep.succs[x]!) if (!down.has(l.to)) { down.add(l.to); stack.push(l.to) } }
    const up = new Set<number>(prep.spanClosers[s]), back = [...prep.spanClosers[s]!]
    while (back.length > 0) { const x = back.pop()!; for (const l of prep.preds[x]!) if (!up.has(l.from)) { up.add(l.from); back.push(l.from) } }
    for (const x of down) if (up.has(x) && !prep.spanClosers[s]!.includes(x)) inSpan[x] = 1
  })

  const anyForbidden = problem.resources.some(resource => resource.forbiddenWhenUsed.length > 0)
  // Keep-in-service bookkeeping: the rules naming each item, and per opener and rule the items it opens there.
  const rulesOfItem = problem.items.map((_, i) => problem.coverage.flatMap((rule, c) => (rule.items.includes(i) ? [c] : [])))
  const openedIn = problem.activities.map((_, a) => prep.opensCoverage[a]!.map(c => problem.coverage[c]!.items.filter(i => prep.opensItems[a]!.includes(i))))
  // Which decoded schedule the bookings currently hold, so justify and evaluate need not re-book.
  let holding: Decoded | undefined

  /** Whether a fits at t in mode m against current bookings (resources, replaced time, maxJobs, resource keep-in-service). */
  const refusal = (a: number, m: number, t: number): Refusal => {
    const mode = problem.activities[a]!.modes[m]!
    if (mode.demands.length === 0) return { kind: 'none' }
    const slots = workedSlots(prep, a, m, t)
    localUse.fill(0); localForbidden.fill(0)
    for (const d of mode.demands) {
      const resource = problem.resources[d.resource]!
      const u = usage[d.resource]!, k = resource.capacity, own = prep.periodPurchase[d.resource]!, banned = prep.forbiddenBy[d.resource]!
      let any = false
      for (let q = 0; q < slots.length; q++) {
        const x = slots[q]!
        if (!applies(prep, d.when, x)) continue
        any = true
        if (u[x]! + d.amount > k[x]!) return { kind: 'capacity', resource: d.resource, slot: x }
        const p = own[x]!, f = banned[x]!
        if (f >= 0 && (purchaseUse[f]! > 0 || localUse[f]! > 0)) return { kind: 'replaced', resource: d.resource, purchase: prep.purchases[f]! }
        if (p >= 0 && (forbiddenUse[p]! > 0 || localForbidden[p]! > 0)) return { kind: 'replaced', resource: d.resource, purchase: prep.purchases[p]! }
        if (p >= 0) localUse[p]!++
        if (f >= 0) localForbidden[f]!++
      }
      if (any && resource.maxJobs !== undefined && jobCount[d.resource]! >= resource.maxJobs) return { kind: 'max-jobs', resource: d.resource }
    }
    for (const d of mode.demands) {
      for (const c of prep.resourceCoverage[d.resource]!) {
        const rule = problem.coverage[c]!
        for (let q = 0; q < slots.length; q++) {
          const x = slots[q]!
          if (x < rule.from || x >= rule.to) continue
          extra.fill(0)
          for (const e of mode.demands) if (applies(prep, e.when, x)) extra[e.resource] = extra[e.resource]! + e.amount
          let free = 0
          for (const r of rule.resources) if (problem.resources[r]!.capacity[x]! - usage[r]![x]! - extra[r]! > 0) free++
          if (free < rule.atLeast) return { kind: 'coverage', rule: c }
        }
      }
    }
    return { kind: 'none' }
  }
  /**
   * The allocation-free test behind every placement: -1 when a fits at t in mode m; else the slot to try
   * after. A full slot x refuses every start that would also work x, so the scan resumes after x (the
   * latest full slot, found first, skips furthest); any other refusal (replaced time, maxJobs,
   * keep-in-service) resumes at t + 1. `refusal` says why.
   */
  const blockedAt = (a: number, m: number, t: number): number => {
    const mode = problem.activities[a]!.modes[m]!
    const work = mode.work, demands = mode.demands
    if (demands.length === 0 || work === 0) return -1
    const continuous = mode.continuous
    const list = prep.cal[mode.calendar]!.list
    const p0 = continuous ? 0 : prep.cal[mode.calendar]!.pos[t]!
    if (anyForbidden) { localUse.fill(0); localForbidden.fill(0) }
    for (let i = 0; i < demands.length; i++) {
      const d = demands[i]!
      const r = d.resource, amount = d.amount
      const u = usage[r]!, capacity = problem.resources[r]!.capacity
      const when = d.when < 0 ? undefined : prep.cal[d.when]!.pos
      let any = false
      // Latest slot first: the last full slot found gives the longest exact skip.
      for (let q = work - 1; q >= 0; q--) {
        const x = continuous ? t + q : list[p0 + q]!
        if (when !== undefined && when[x]! < 0) continue
        any = true
        if (u[x]! + amount > capacity[x]!) return x + 1
        if (anyForbidden) {
          const own = prep.periodPurchase[r]!, banned = prep.forbiddenBy[r]!
          const p = own[x]!, f = banned[x]!
          if (f >= 0 && (purchaseUse[f]! > 0 || localUse[f]! > 0)) return t + 1
          if (p >= 0 && (forbiddenUse[p]! > 0 || localForbidden[p]! > 0)) return t + 1
          if (p >= 0) localUse[p]!++
          if (f >= 0) localForbidden[f]!++
        }
      }
      const maxJobs = problem.resources[r]!.maxJobs
      if (any && maxJobs !== undefined && jobCount[r]! >= maxJobs) return t + 1
    }
    for (let i = 0; i < demands.length; i++) if (prep.resourceCoverage[demands[i]!.resource]!.length > 0) return refusal(a, m, t).kind === 'none' ? -1 : t + 1
    return -1
  }
  const fits = (a: number, m: number, t: number): boolean => blockedAt(a, m, t) < 0

  const book = (a: number, m: number, t: number, sign: 1 | -1): void => {
    const mode = problem.activities[a]!.modes[m]!
    if (mode.work === 0) return
    const k = prep.cal[mode.calendar]!
    const p0 = mode.continuous ? 0 : k.pos[t]!
    for (const d of mode.demands) {
      const u = usage[d.resource]!, own = prep.periodPurchase[d.resource]!, banned = prep.forbiddenBy[d.resource]!
      const when = d.when < 0 ? undefined : prep.cal[d.when]!.pos
      let any = false
      for (let q = 0; q < mode.work; q++) {
        const x = mode.continuous ? t + q : k.list[p0 + q]!
        if (when !== undefined && when[x]! < 0) continue
        any = true
        u[x] = u[x]! + sign * d.amount
        if (own[x]! >= 0) purchaseUse[own[x]!] = purchaseUse[own[x]!]! + sign * d.amount
        if (banned[x]! >= 0) forbiddenUse[banned[x]!] = forbiddenUse[banned[x]!]! + sign * d.amount
      }
      if (any) jobCount[d.resource] = jobCount[d.resource]! + sign
    }
  }

  const reset = (): void => {
    holding = undefined
    for (const u of usage) u.fill(0)
    jobCount.fill(0); purchaseUse.fill(0); forbiddenUse.fill(0)
  }

  const decode = (list: ArrayLike<number>, modes: ArrayLike<number>): Decoded => {
    const minStart = new Int32Array(n)
    const S = new Int32Array(n), F = new Int32Array(n), M = Int32Array.from(modes)
    let restarts = 0
    for (;;) {
      reset()
      const placed = new Uint8Array(n)
      const spanStart = new Int32Array(problem.spans.length).fill(-1)
      const spanCloserF = new Int32Array(problem.spans.length).fill(-1)
      const itemStarted = new Uint8Array(problem.items.length)
      const closersLeft = Int32Array.from(prep.itemClosers.map(list => list.length))
      // Per keep-in-service rule: its items started and not yet closed (open at every later slot).
      const outCount = new Int32Array(problem.coverage.length)
      const itemEnd = new Int32Array(problem.items.length).fill(-1)
      let penalty = 0, restart = false, note = ''
      const place = (a: number, m: number, t: number, f: number): void => {
        S[a] = t; F[a] = f; M[a] = m; placed[a] = 1
        if (f >= 0 && t < H) book(a, m, t, 1)
        for (const s of prep.opensSpans[a]!) if (spanStart[s]! < 0 || t < spanStart[s]!) spanStart[s] = t
        for (const s of prep.closesSpans[a]!) spanCloserF[s] = Math.max(spanCloserF[s]!, f)
        for (const i of prep.opensItems[a]!) {
          if (!itemStarted[i] && closersLeft[i]! > 0) for (const c of rulesOfItem[i]!) outCount[c]!++
          itemStarted[i] = 1
        }
        for (const i of prep.closesItems[a]!) {
          closersLeft[i]!--
          if (closersLeft[i] === 0 && itemStarted[i]) for (const c of rulesOfItem[i]!) outCount[c]!--
          itemEnd[i] = Math.max(itemEnd[i]!, f)
        }
      }
      const openAt = (c: number, opening: readonly number[], t: number): number => {
        let count = 0
        for (const i of problem.coverage[c]!.items) {
          if (opening.includes(i)) { count++; continue }
          if (itemStarted[i] && (closersLeft[i]! > 0 || itemEnd[i]! > t)) count++
        }
        return count
      }
      const coverageOk = (a: number, t: number): boolean => {
        for (const c of prep.opensCoverage[a]!) {
          const rule = problem.coverage[c]!
          if (t >= rule.to) continue
          if (openAt(c, prep.opensItems[a]!, t) > rule.items.length - rule.atLeast) return false
        }
        return true
      }
      /**
       * The keep-in-service rule that blocks opener a at every slot of its period: the outages still open
       * (started, not yet closed) plus a's own would exceed what the rule lets out. -1 when none blocks.
       */
      const blockingRule = (a: number): number => {
        const rules = prep.opensCoverage[a]!
        for (let k = 0; k < rules.length; k++) {
          const c = rules[k]!
          const rule = problem.coverage[c]!
          let out = outCount[c]!
          for (const i of openedIn[a]![k]!) if (!(itemStarted[i] && closersLeft[i]! > 0)) out++
          if (out > rule.items.length - rule.atLeast) return c
        }
        return -1
      }
      problem.activities.forEach((activity, a) => {
        if (activity.fixed === undefined) return
        place(a, activity.fixed.mode, activity.fixed.start, finishOf(prep, a, activity.fixed.mode, activity.fixed.start))
      })
      // The list in order, with taken entries flagged instead of spliced out: a precedence-feasible list
      // takes its head almost every time, so a pick is O(1) and a pass O(n).
      const order: number[] = []
      for (let i = 0; i < list.length; i++) if (problem.activities[list[i]!]!.fixed === undefined) order.push(list[i]!)
      const taken = new Uint8Array(order.length)
      let head = 0, left = order.length
      while (left > 0 && !restart) {
        // A ready opener that a keep-in-service rule blocks at every slot waits until an outage closes.
        let pick = -1, blocked = -1
        for (let p = head; p < order.length; p++) {
          if (taken[p]) continue
          const a = order[p]!
          let ready = true
          for (const l of prep.preds[a]!) if (!placed[l.from]) { ready = false; break }
          if (!ready) continue
          if (prep.opensCoverage[a]!.length > 0) { const rule = blockingRule(a); if (rule >= 0) { if (blocked < 0) blocked = rule; continue } }
          pick = p; break
        }
        if (pick < 0) {
          // Nothing can go next: every ready job is an opener the rule blocks, and no open outage can close
          // first. The plan is unplaceable in this order; nothing is placed without a slot.
          penalty += 1e6 * left
          note = blocked >= 0 ? `deadlock: ${problem.coverage[blocked]!.id} blocks every ready job` : 'no activity is ready'
          for (let p = head; p < order.length; p++) if (!taken[p]) { const a = order[p]!; S[a] = H; F[a] = H; placed[a] = 1 }
          break
        }
        taken[pick] = 1
        left--
        while (head < order.length && taken[head]) head++
        const a = order[pick]!
        const m = M[a]!
        const activity = problem.activities[a]!
        const mode = activity.modes[m]!
        let lo = Math.max(minStart[a]!, activity.release, mode.release), ffLo = -1
        const ffLinks: Array<{ finish: number; lag: number }> = []
        const upper: Array<{ src: number; kind: 'S' | 'F'; bound: number }> = []
        for (const l of prep.preds[a]!) {
          if (l.type === 'FS') { lo = Math.max(lo, F[l.from]! + l.min); if (l.max !== undefined) upper.push({ src: l.from, kind: 'S', bound: F[l.from]! + l.max }) }
          else if (l.type === 'SS') { lo = Math.max(lo, F[l.from]! >= H ? S[l.from]! + l.min : progressAt(prep, l.from, M[l.from]!, S[l.from]!, l.min)); if (l.max !== undefined) upper.push({ src: l.from, kind: 'S', bound: S[l.from]! + l.max }) }
          else { ffLo = Math.max(ffLo, F[l.from]!); if (l.min > 0) ffLinks.push({ finish: F[l.from]!, lag: l.min }); if (l.max !== undefined) upper.push({ src: l.from, kind: 'F', bound: F[l.from]! + l.max }) }
        }
        for (const s of prep.opensSpans[a]!) {
          const limit = problem.spans[s]!.limit
          if (limit !== undefined && spanCloserF[s]! >= 0) lo = Math.max(lo, spanCloserF[s]! - limit)
        }
        let tStar = -1, fStar = -1
        const last = mode.work === 0 ? H : H - 1
        const finishes = prep.finish[a]![m]!, starts = prep.next[a]![m]!
        // Only slots where the mode can start at all are tried (the next-start table skips the rest).
        const guarded = prep.opensCoverage[a]!.length > 0
        for (let t = starts[Math.min(H + 1, Math.max(0, lo))]!; t <= last;) {
          const f = finishes[t]!
          if (f < ffLo || (ffLinks.length > 0 && !ffLinks.every(link => workedFrom(prep, a, m, t, link.finish) >= link.lag)) || (guarded && !coverageOk(a, t))) { t = starts[t + 1]!; continue }
          const resume = blockedAt(a, m, t)
          if (resume >= 0) { t = starts[Math.min(H + 1, Math.max(t + 1, resume))]!; continue }
          tStar = t; fStar = f; break
        }
        if (tStar < 0) {
          penalty += 1e4 + mode.work
          note ||= `no slot for ${activity.id} within the horizon`
          place(a, m, Math.min(Math.max(0, lo), H), -1)
          F[a] = H
          for (const s of prep.closesSpans[a]!) spanCloserF[s] = H
          for (const i of prep.closesItems[a]!) itemEnd[i] = H
          continue
        }
        for (const s of prep.closesSpans[a]!) {
          const limit = problem.spans[s]!.limit
          if (limit === undefined || spanStart[s]! < 0) continue
          const over = fStar - spanStart[s]! - limit
          if (over <= 0) continue
          const target = spanStart[s]! + over
          let moved = false
          if (restarts < MAX_RESTARTS) {
            for (const o of prep.spanOpeners[s]!) if (placed[o] && S[o]! < target && problem.activities[o]!.fixed === undefined) { minStart[o] = Math.max(minStart[o]!, target); moved = true }
          }
          if (moved) restart = true
          else { penalty += over; note ||= `span ${problem.spans[s]!.id} over its limit at ${activity.id}` }
        }
        for (const u of upper) {
          const over = (u.kind === 'S' ? tStar : fStar) - u.bound
          if (over <= 0) continue
          if (problem.activities[u.src]!.fixed === undefined && restarts < MAX_RESTARTS) { minStart[u.src] = Math.max(minStart[u.src]!, S[u.src]! + over); restart = true }
          else { penalty += over; note ||= `maximum lag overrun at ${activity.id}` }
        }
        if (restart) break
        if (fStar > activity.deadline) { penalty += fStar - activity.deadline; note ||= `past the window at ${activity.id}` }
        place(a, m, tStar, fStar)
      }
      if (restart) { restarts++; continue }
      const decoded = { start: S, finish: F, mode: M, penalty, restarts, note }
      holding = decoded
      return decoded
    }
  }

  /** Re-books a decoded schedule, so fits/refusal answer against it (explanations, justification). */
  const load = (schedule: { readonly start: ArrayLike<number>; readonly mode: ArrayLike<number> }, except = -1): void => {
    reset()
    for (let a = 0; a < n; a++) if (a !== except && finishOf(prep, a, schedule.mode[a]!, schedule.start[a]!) >= 0) book(a, schedule.mode[a]!, schedule.start[a]!, 1)
    if (except < 0 && 'penalty' in schedule) holding = schedule as Decoded
  }

  const priced = problem.resources.map(resource => resource.pricePerUnitSlot.some(price => price > 0))
  const slotCost = (a: number, m: number, t: number): number => {
    const mode = problem.activities[a]!.modes[m]!
    if (mode.work === 0) return 0
    const k = prep.cal[mode.calendar]!
    const p0 = mode.continuous ? 0 : k.pos[t]!
    let sum = 0
    for (const d of mode.demands) {
      if (!priced[d.resource]) continue
      const price = problem.resources[d.resource]!.pricePerUnitSlot
      const when = d.when < 0 ? undefined : prep.cal[d.when]!.pos
      for (let q = 0; q < mode.work; q++) {
        const x = mode.continuous ? t + q : k.list[p0 + q]!
        if (when === undefined || when[x]! >= 0) sum += d.amount * price[x]!
      }
    }
    return sum
  }

  /**
   * Moves jobs as late as their successors allow without raising cost or lateness: span-internal jobs
   * shorten outages; `all` is the backward pass of forward-backward improvement. Closers never move.
   */
  const justify = (d: Decoded, all = false): void => {
    if (d.penalty > 0) return
    const S = d.start, F = d.finish, M = d.mode
    if (holding !== d) load(d)
    const order = [...Array(n).keys()].filter(a => (all ? !isCloser[a] : inSpan[a]) && problem.activities[a]!.fixed === undefined)
      .sort((x, y) => S[y]! - S[x]! || y - x)
    for (const a of order) {
      const activity = problem.activities[a]!
      const m = M[a]!
      let sUB = H, fUB = activity.deadline
      const progressLinks: Array<NormalizedProblem['links'][number]> = []
      for (const l of prep.succs[a]!) {
        if (l.type === 'FS') fUB = Math.min(fUB, S[l.to]! - l.min)
        else { progressLinks.push(l); if (l.type === 'SS') sUB = Math.min(sUB, S[l.to]!); else fUB = Math.min(fUB, F[l.to]!) }
      }
      for (const l of prep.preds[a]!) if (l.max !== undefined) {
        if (l.type === 'FS') sUB = Math.min(sUB, F[l.from]! + l.max)
        else if (l.type === 'SS') sUB = Math.min(sUB, S[l.from]! + l.max)
        else fUB = Math.min(fUB, F[l.from]! + l.max)
      }
      const own = slotCost(a, m, S[a]!)
      book(a, m, S[a]!, -1)
      let best = S[a]!
      const pricedMode = activity.modes[m]!.demands.some(d => priced[d.resource])
      for (let t = Math.min(sUB, H - 1); t > S[a]!; t--) {
        const f = finishOf(prep, a, m, t)
        if (f < 0 || f > fUB) continue
        if (progressLinks.length > 0 && !progressLinks.every(l => (l.type === 'SS' ? progressAt(prep, a, m, t, l.min) <= S[l.to]! : ffHolds(prep, l.to, M[l.to]!, S[l.to]!, f, l.min)))) continue
        if (activity.target !== undefined && f > Math.max(activity.target, F[a]!)) continue
        if (!fits(a, m, t)) continue
        if (pricedMode && slotCost(a, m, t) > own) continue
        best = t; break
      }
      S[a] = best; F[a] = finishOf(prep, a, m, best); book(a, m, best, 1)
    }
    holding = d
  }

  /** Union length of each item's out intervals (own plus supporters'), in slots. */
  const itemOut = (start: ArrayLike<number>, finish: ArrayLike<number>): Int32Array => {
    const out = new Int32Array(problem.items.length)
    problem.items.forEach((_, i) => {
      const intervals: Array<[number, number]> = []
      const visit = (item: number, seen: Set<number>): void => {
        const own = problem.items[item]!
        if (own.openers.length > 0) {
          const from = Math.min(...own.openers.map(o => start[o]!))
          const to = own.closers.length > 0 ? Math.max(...own.closers.map(c => finish[c]!)) : H
          if (to > from) intervals.push([from, to])
        }
        for (const s of own.supportedBy) if (!seen.has(s)) { seen.add(s); visit(s, seen) }
      }
      visit(i, new Set([i]))
      intervals.sort((x, y) => x[0] - y[0])
      let total = 0, cursor = -1
      for (const [from, to] of intervals) { if (to <= cursor) continue; total += to - Math.max(from, cursor); cursor = to }
      out[i] = total
    })
    return out
  }

  const spanLength = (s: number, start: ArrayLike<number>, finish: ArrayLike<number>): number => {
    const openers = prep.spanOpeners[s]!, closers = prep.spanClosers[s]!
    if (openers.length === 0 || closers.length === 0) return 0
    let from = Infinity, to = -Infinity
    for (const o of openers) from = Math.min(from, start[o]!)
    for (const c of closers) to = Math.max(to, finish[c]!)
    return Math.max(0, to - from)
  }

  /** Goal values and keys of a decoded (and justified) schedule, read from the current bookings. */
  const evaluate = (d: Decoded): Evaluation => {
    if (holding !== d) load(d)
    let cost = 0, finish = 0
    for (let a = 0; a < n; a++) {
      const mode = problem.activities[a]!.modes[d.mode[a]!]!
      cost += mode.fixedCost + slotCost(a, d.mode[a]!, d.start[a]!)
      finish = Math.max(finish, d.finish[a]!)
    }
    const used = new Set<string>()
    problem.resources.forEach((resource, r) => {
      const u = usage[r]!
      for (const period of resource.periods) {
        let any = false
        for (let t = period.from; t < period.to && !any; t++) if (u[t]! > 0) any = true
        if (any) used.add(period.purchase)
        if (any || period.committed) cost += period.price
      }
    })
    problem.resources.forEach(resource => {
      for (const item of resource.once) if (item.committed || used.has(item.purchase)) cost += item.price
    })
    const out = itemOut(d.start, d.finish)
    const raw = problem.goals.map((goal): number | number[] => {
      const scale = goal.metric === 'extra-cost' ? 1 : problem.slotMs / unitMs(goal.unit)
      if (goal.metric === 'span-over') return (goal.spans ?? []).map(s => spanLength(s, d.start, d.finish) * scale)
      let value = 0
      if (goal.metric === 'finish') value = finish
      else if (goal.metric === 'extra-cost') value = cost
      else if (goal.metric === 'unavailable-hours') {
        const items = goal.spans === undefined ? problem.items.map((_, i) => i) : [...new Set(goal.spans.flatMap(s => problem.spans[s]!.items))]
        for (const i of items) value += out[i]!
      } else if (goal.metric === 'lateness') {
        for (const a of goal.tagged ?? []) { const target = problem.activities[a]!.target; if (target !== undefined) value += Math.max(0, d.finish[a]! - target) }
      }
      return value * scale
    })
    return { penalty: d.penalty, raw, cost, used: [...used] }
  }

  return { decode, justify, evaluate, refusal, load, fits, inSpan, isCloser, spanLength, itemOut }
}

export type Decoder = ReturnType<typeof makeDecoder>

/** Decodes and justifies one schedule exactly as the search does (preview re-timing). */
export const retime = (prep: Prepared, schedule: Schedule): { decoded: Decoded; evaluation: Evaluation } => {
  const decoder = makeDecoder(prep)
  const list = [...prep.topo].sort((x, y) => schedule.start[x]! - schedule.start[y]! || prep.topo.indexOf(x) - prep.topo.indexOf(y))
  const decoded = decoder.decode(precedenceOrder(prep, list), schedule.mode)
  decoder.justify(decoded)
  return { decoded, evaluation: decoder.evaluate(decoded) }
}

/** A precedence-feasible list that follows `preferred` as closely as the links allow. */
export const precedenceOrder = (prep: Prepared, preferred: readonly number[]): number[] => {
  const rank = new Int32Array(prep.n)
  preferred.forEach((a, i) => { rank[a] = i })
  const indegree = prep.preds.map(list => list.length)
  const ready = indegree.flatMap((degree, a) => (degree === 0 ? [a] : []))
  const out: number[] = []
  while (ready.length > 0) {
    let best = 0
    for (let i = 1; i < ready.length; i++) if (rank[ready[i]!]! < rank[ready[best]!]!) best = i
    const a = ready.splice(best, 1)[0]!
    out.push(a)
    for (const l of prep.succs[a]!) if (--indegree[l.to]! === 0) ready.push(l.to)
  }
  return out
}

/** A comparison of key vectors: penalty first, then each goal key. */
export const compareVectors = (a: readonly number[], b: readonly number[]): number => {
  for (let i = 0; i < a.length; i++) { const d = a[i]! - b[i]!; if (Math.abs(d) > 1e-9) return d < 0 ? -1 : 1 }
  return 0
}
