// The TypeScript engine behind the Engine seam (or's heuristic, R/or/gate/src/search.ts, on the plan decoder).
// Priority-rule construction; a race of independent late-acceptance climbs from the best distinct starts,
// each on its own random stream, whose best climbs on; a second race of short climbs restarting from the
// best plan; a cost repair inside the earlier goals' band (drop each bought purchase, move paid hours back
// into booked ones); a band-limited late-acceptance stage per later goal; a mode polish. A late job behind a
// keep-in-service group pulls that group's outage packages together, so each outage closes before the next
// opens. Every phase boundary is counted in work units (evaluations weighted by whether justification ran),
// and the work target is a fixed function of the problem's size and the CPU budget, so one seed and one set
// of inputs give one plan. CPU, wall and evaluation budgets and an abort still stop it (within one yield,
// about 50 ms); a run that stops on CPU or wall time is valid but not repeatable, and says so in `stoppedBy`.
import { makeDecoder, precedenceOrder, prepare, type Decoded, type Evaluation, type Prepared } from './decode.ts'
import type { Engine, EngineResult, EngineStop, NormalizedProblem, Schedule } from './problem.ts'
import { compareKeys, compareStaged, goalExcess, goalKeys } from './rank.ts'

/**
 * Bumped whenever compile, bounds or the engine change meaning; part of every formulation. It lives here so
 * the Worker loads only the engine and decoder, not the plan schema.
 */
export const SOLVER_VERSIONS = { compile: 1, bounds: 1, engine: 'lahc-2' } as const

export const mulberry32 = (seed: number) => () => {
  seed |= 0; seed = (seed + 0x6d2b79f5) | 0
  let r = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r
  return ((r ^ (r >>> 14)) >>> 0) / 4294967296
}

/** Thread CPU milliseconds (per Worker in Bun), the unit of every CPU budget. */
export const threadCpuMs = (): number => { const usage = process.threadCpuUsage(); return (usage.user + usage.system) / 1_000 }

/**
 * The search budget is counted in work units, never in time: one unit is one evaluation of a plan that
 * meets every modelled rule (decode, justification, goals); an evaluation of a plan that breaks one skips
 * the justification and counts INFEASIBLE_UNITS. A unit is planned to cost
 * `base + perActivitySlot * activities * horizon` CPU milliseconds, measured on the reference machine
 * (Apple M2, shared, load 2-5) with lane S's decoder at 5411c8d66 (finish and next-start tables): twin v3
 * (330 activities, 480 slots) 0.54-0.63 ms, the flagship (34 activities, 480 slots) 0.15-0.21 ms. The work
 * target, and so every plan, depends on these constants: recalibrate them when the decoder's speed changes.
 * With the slower decoder before 5411c8d66 the CPU cap binds first and runs are not repeatable.
 */
export const WORK_UNIT_MS = { base: 0.134, perActivitySlot: 2.82e-6 } as const
export const INFEASIBLE_UNITS = 0.55
/** Share of the CPU budget the work target is planned to use, so the CPU cap rarely binds first. */
export const WORK_SAFETY = 0.7
const MIN_UNITS = 200

/** The planned work for a problem and CPU budget: deterministic, never timed. */
export const workTarget = (problem: NormalizedProblem, cpuMs: number): number => {
  const unitMs = WORK_UNIT_MS.base + WORK_UNIT_MS.perActivitySlot * problem.activities.length * problem.horizon
  return Math.max(MIN_UNITS, Math.floor(WORK_SAFETY * cpuMs / unitMs))
}

/**
 * Where each phase ends, as a share of the work target: a race of independent climbs from the best
 * distinct starts (each its own random stream; the best goes on), the winner's climb, a race of short
 * climbs that restart from the best plan, the cost repair sweeps, the band stages, the polish.
 */
export const PHASES = { runs: 3, firstEnd: 0.3, climbEnd: 0.55, raceEnd: 0.75, repairEnd: 0.85, bandEnd: 0.95 } as const

export interface SearchOptions {
  /** CPU clock in milliseconds; thread CPU by default. Tests may pass a wall clock. */
  readonly clock?: () => number
  /** Late-acceptance history length. */
  readonly lateAcceptance?: number
  /**
   * Spread the CPU budget over the wall budget (cpuMs / wallMs cores at most), sleeping when ahead, so a
   * solve never takes the whole CPU quota from reads and health checks. The worker pool sets it.
   */
  readonly pace?: boolean
}

interface Point { readonly list: number[]; readonly modes: number[] }
interface Scored extends Point { readonly decoded: Decoded; readonly evaluation: Evaluation; readonly excess: number[]; readonly keys: number[] }

const elapsedEstimate = (prep: Prepared, a: number, m: number): number => {
  const mode = prep.problem.activities[a]!.modes[m]!
  const share = prep.cal[mode.calendar]!.list.length / prep.H
  return share > 0 ? Math.ceil(mode.work / share) : prep.H
}

/** Priority lists: latest finish, most successors, ranked positional weight, slack, bottleneck-weighted and noisy. */
const priorityLists = (prep: Prepared, rng: () => number, randomCount: number): number[][] => {
  const { n, succs, preds, problem } = prep
  const topo = [...prep.topo]
  const dmin = Array.from({ length: n }, (_, a) => Math.min(...problem.activities[a]!.modes.map((_, m) => elapsedEstimate(prep, a, m))))
  const lf = new Array<number>(n).fill(prep.H)
  for (const a of [...topo].reverse()) for (const l of succs[a]!) lf[a] = Math.min(lf[a]!, lf[l.to]! - dmin[l.to]! - Math.max(0, l.min))
  const nsucc = new Array<number>(n).fill(0)
  for (const a of [...topo].reverse()) { const seen = new Set<number>(); const walk = (x: number) => { for (const l of succs[x]!) if (!seen.has(l.to)) { seen.add(l.to); walk(l.to) } }; walk(a); nsucc[a] = seen.size }
  const rpw = new Array<number>(n).fill(0)
  for (const a of [...topo].reverse()) rpw[a] = dmin[a]! + succs[a]!.reduce((sum, l) => sum + rpw[l.to]!, 0)
  const build = (key: (a: number) => number, noise: number): number[] => {
    const indegree = preds.map(list => list.length), out: number[] = []
    const ready = new Set(indegree.flatMap((degree, a) => (degree === 0 ? [a] : [])))
    while (ready.size > 0) {
      let best = -1, bestKey = Infinity
      for (const a of ready) { const k = key(a) + noise * rng(); if (k < bestKey || (k === bestKey && a < best)) { best = a; bestKey = k } }
      ready.delete(best); out.push(best)
      for (const l of succs[best]!) if (--indegree[l.to]! === 0) ready.add(l.to)
    }
    return out
  }
  const lists = [build(a => lf[a]!, 0), build(a => -nsucc[a]!, 0), build(a => -rpw[a]!, 0), build(a => lf[a]! - dmin[a]!, 0)]
  // Bottleneck: load of each resource (first-mode work / capacity), inherited by predecessors.
  const load = problem.resources.map((resource, r) => {
    let need = 0
    problem.activities.forEach(activity => { for (const d of activity.modes[0]!.demands) if (d.resource === r) need += d.amount * activity.modes[0]!.work })
    let capacity = 0
    for (let t = 0; t < prep.H; t++) capacity += resource.capacity[t]!
    return capacity > 0 ? need / capacity : 0
  })
  const pressure = problem.activities.map(activity => Math.max(0, ...activity.modes[0]!.demands.map(d => load[d.resource]!)))
  for (const a of [...topo].reverse()) for (const l of succs[a]!) pressure[a] = Math.max(pressure[a]!, pressure[l.to]!)
  lists.push(build(a => lf[a]! - 400 * pressure[a]!, 0), build(a => -1000 * pressure[a]! - nsucc[a]!, 0))
  for (let i = 0; i < 4; i++) lists.push(build(a => lf[a]! - 400 * pressure[a]!, 24 + 24 * i))
  for (let i = 0; i < randomCount; i++) lists.push(build(a => lf[a]!, 24 + 24 * (i % 4)))
  return lists
}

export const searchEngine = (searchOptions: SearchOptions = {}): Engine => ({
  name: SOLVER_VERSIONS.engine,
  solve: async (problem: NormalizedProblem, options): Promise<EngineResult> => {
    const cpu = searchOptions.clock ?? threadCpuMs
    const cpu0 = cpu(), wall0 = performance.now()
    const { budget, signal } = options
    const prep = prepare(problem)
    const decoder = makeDecoder(prep)
    const n = prep.n
    const goals = problem.goals
    // An evaluation budget (reproducible tests) caps the plan too: work units never exceed evaluations.
    const target = Math.min(workTarget(problem, budget.cpuMs), budget.evals)
    let evals = 0, spent = 0
    let stoppedBy: EngineStop = 'done'
    let lastYield = performance.now()

    // The band reference: the least excess seen per goal, each among plans inside the earlier goals'
    // bands (the gate's "within 1 h of the best finish seen"). It only improves, so the band cannot drift.
    const reference = goals.map(() => Infinity)
    const noteReference = (excess: readonly number[]): void => {
      for (let k = 0; k < goals.length; k++) {
        const x = excess[k]!
        if (x < reference[k]! - 1e-9) { for (let j = k; j < goals.length; j++) reference[j] = excess[j]!; return }
        if (x > reference[k]! + goals[k]!.step + 1e-9) return
      }
    }
    const evaluate = (point: Point): Scored => {
      evals++
      const decoded = decoder.decode(point.list, point.modes)
      spent += decoded.penalty === 0 ? 1 : INFEASIBLE_UNITS
      decoder.justify(decoded)
      const evaluation = decoder.evaluate(decoded)
      const excess = goals.map((goal, k) => goalExcess(evaluation.raw[k] ?? 0, goal.threshold))
      if (decoded.penalty === 0) noteReference(excess)
      return { ...point, decoded, evaluation, excess, keys: goalKeys(evaluation.raw, goals) }
    }
    // The climbs compare on the ranking keys (rank.ts); the repair, the band stages and the polish compare
    // inside the band around the best seen (staged), so cost is weighed only among plans near the best finish.
    let staged = false
    const better = (a: Scored, b: Scored): number => {
      if (a.decoded.penalty !== b.decoded.penalty) return a.decoded.penalty < b.decoded.penalty ? -1 : 1
      if (!staged) return compareKeys(a.keys, b.keys)
      return compareStaged(a.excess, b.excess, reference, goals)
    }
    /** Stops on abort or on a binding budget; `quota` is where the phase's work ends. Phases never end by time. */
    const shouldStop = async (quota = target): Promise<boolean> => {
      if (stoppedBy !== 'done') return true
      if (signal.aborted) { stoppedBy = 'cancelled'; return true }
      if (evals >= budget.evals) { stoppedBy = 'evals'; return true }
      if (cpu() - cpu0 >= budget.cpuMs) { stoppedBy = 'cpu'; return true }
      const now = performance.now()
      if (now - wall0 >= budget.wallMs) { stoppedBy = 'wall'; return true }
      if (now - lastYield > 50) {
        const ahead = searchOptions.pace === true ? (cpu() - cpu0) - budget.cpuMs / budget.wallMs * (now - wall0) : 0
        await new Promise(resolve => setTimeout(resolve, ahead > 20 ? Math.min(200, ahead * budget.wallMs / budget.cpuMs) : 0))
        lastYield = performance.now()
        if (signal.aborted) { stoppedBy = 'cancelled'; return true }
      }
      return spent >= quota
    }

    const nModes = problem.activities.map(activity => activity.modes.length)
    const fixedMode = problem.activities.map(activity => activity.fixed?.mode)
    const modeSets: number[][] = [
      problem.activities.map((_, a) => fixedMode[a] ?? 0),
      problem.activities.map((activity, a) => fixedMode[a] ?? activity.modes.reduce((best, _, m) => (elapsedEstimate(prep, a, m) < elapsedEstimate(prep, a, best) ? m : best), 0)),
    ]
    const variable = problem.activities.flatMap((activity, a) => (activity.fixed === undefined && activity.modes.length > 1 ? [a] : []))
    const sameResources = (x: NormalizedProblem['activities'][number]['modes'][number], y: NormalizedProblem['activities'][number]['modes'][number]): boolean =>
      x.demands.length === y.demands.length && x.demands.every((d, i) => d.resource === y.demands[i]!.resource)
    // Cheaper siblings: the same resources on fewer working slots (booked hours instead of paid ones).
    const cheaper = problem.activities.map(activity => activity.modes.map((mode, m) => activity.modes.flatMap((other, k) => {
      if (k === m || !sameResources(mode, other)) return []
      return prep.cal[other.calendar]!.list.length < prep.cal[mode.calendar]!.list.length ? [k] : []
    })))
    // Which purchases a mode can draw on: a slot of its calendar where a demand applies and a purchase holds the resource.
    const purchaseIndex = new Map(prep.purchases.map((key, p) => [key, p]))
    const touches = problem.activities.map(activity => activity.modes.map(mode => {
      const found = new Set<number>()
      const k = prep.cal[mode.calendar]!
      for (const d of mode.demands) {
        const own = prep.periodPurchase[d.resource]!, when = d.when < 0 ? undefined : prep.cal[d.when]!.pos
        for (let q = 0; q < k.list.length; q++) { const x = k.list[q]!; if (when !== undefined && when[x]! < 0) continue; if (own[x]! >= 0) found.add(own[x]!) }
      }
      return found
    }))

    // ── construction: priority lists x mode sets, every start evaluated ──
    const startRng = mulberry32(options.seed)
    const starts: Point[] = []
    if (options.initial !== undefined) {
      const initial = options.initial
      starts.push({ list: precedenceOrder(prep, [...prep.topo].sort((x, y) => initial.start[x]! - initial.start[y]!)), modes: [...initial.mode] })
    }
    for (const list of priorityLists(prep, startRng, 8)) for (const modes of modeSets) starts.push({ list, modes: [...modes] })
    const scoredStarts: Scored[] = []
    for (const start of starts) {
      scoredStarts.push(evaluate(start))
      if (await shouldStop()) break
    }
    scoredStarts.sort((x, y) => better(x, y))
    let best = scoredStarts[0]!

    const L = searchOptions.lateAcceptance ?? 60
    const position = new Int32Array(n)
    const openerGroups = problem.coverage.filter(rule => rule.items.length > 1).map(rule => [...new Set(rule.items.flatMap(i => prep.itemOpeners[i]!))]).filter(list => list.length > 1)
    // Each opener's outage package: the jobs after it that lead to a closer of an item it opens. Pulling a
    // package together right behind its opener closes that outage sooner, so the group's next member can open.
    const packageOf = new Map<number, number[]>()
    for (const group of openerGroups) for (const o of group) {
      const closers = new Set(prep.opensItems[o]!.flatMap(i => prep.itemClosers[i]!))
      const down = new Set<number>([o]), stack = [o]
      while (stack.length > 0) { const x = stack.pop()!; for (const l of prep.succs[x]!) if (!down.has(l.to)) { down.add(l.to); stack.push(l.to) } }
      const up = new Set<number>(closers), back = [...closers]
      while (back.length > 0) { const x = back.pop()!; for (const l of prep.preds[x]!) if (!up.has(l.from)) { up.add(l.from); back.push(l.from) } }
      packageOf.set(o, [...down].filter(x => x !== o && up.has(x)))
    }
    const groupOfOpener = new Map<number, number[]>()
    for (const group of openerGroups) for (const o of group) groupOfOpener.set(o, group)
    /** Moves the package of every opener in the group to just behind its opener, keeping precedence. */
    const compress = (list: number[], group: readonly number[]): number[] => {
      const moving = new Set(group.flatMap(o => packageOf.get(o) ?? []))
      const order = list.filter(a => !moving.has(a))
      const out: number[] = []
      for (const a of order) { out.push(a); if (packageOf.has(a) && group.includes(a)) for (const x of list) if ((packageOf.get(a) ?? []).includes(x)) out.push(x) }
      for (const x of list) if (moving.has(x) && !out.includes(x)) out.push(x)
      return precedenceOrder(prep, out)
    }

    /** One climber: its own random stream, current point, late list and late-acceptance history. */
    const climber = (seed: number, from: Scored) => {
      const rng = mulberry32(seed)
      let current = from
      let late: number[] = []
      const setLate = (s: Scored): void => { late = []; for (let a = 0; a < n; a++) if (s.decoded.finish[a]! > problem.activities[a]!.deadline) late.push(a) }
      setLate(current)
      let own = from
      const promote = (point: Point): Point | null => {
        if (late.length === 0) return null
        let a = late[Math.floor(rng() * late.length)]!
        const spans = prep.closesSpans[a]!
        if (spans.length > 0 && rng() < 0.6) { const openers = prep.spanOpeners[spans[0]!]!; a = openers[Math.floor(rng() * openers.length)]! }
        else for (let k = 0; k < 4 && prep.preds[a]!.length > 0 && rng() < 0.6; k++) a = prep.preds[a]![Math.floor(rng() * prep.preds[a]!.length)]!.from
        const list = [...point.list]
        const p = list.indexOf(a)
        let lo = 0
        for (const l of prep.preds[a]!) lo = Math.max(lo, list.indexOf(l.from) + 1)
        if (lo >= p) return null
        const q = lo + Math.floor(rng() * (p - lo))
        list.splice(p, 1); list.splice(q, 0, a)
        return { list, modes: [...point.modes] }
      }
      const neighbour = (point: Point, costPhase: boolean): Point | null => {
        if (late.length > 0 && rng() < 0.4) {
          // A late job behind a keep-in-service group: pull that group's outages together first.
          const blocked = late.find(a => groupOfOpener.has(a))
          if (blocked !== undefined && rng() < 0.5) return { list: compress(point.list, groupOfOpener.get(blocked)!), modes: [...point.modes] }
          return promote(point)
        }
        const list = [...point.list], modes = [...point.modes]
        list.forEach((a, p) => { position[a] = p })
        const r = rng()
        if (costPhase && r < 0.15 && variable.length > 0) {
          const candidates = variable.filter(a => cheaper[a]![modes[a]!]!.length > 0)
          if (candidates.length === 0) return null
          const a = candidates[Math.floor(rng() * candidates.length)]!
          const choices = cheaper[a]![modes[a]!]!
          modes[a] = choices[Math.floor(rng() * choices.length)]!
          return { list, modes }
        }
        if (r < 0.35) {
          const a = list[Math.floor(rng() * list.length)]!
          let lo = 0, hi = list.length - 1
          for (const l of prep.preds[a]!) lo = Math.max(lo, position[l.from]! + 1)
          for (const l of prep.succs[a]!) hi = Math.min(hi, position[l.to]! - 1)
          const p = position[a]!
          list.splice(p, 1)
          list.splice(lo + Math.floor(rng() * (hi - lo + 1)), 0, a)
        } else if (r < 0.65 && variable.length > 0) {
          const a = variable[Math.floor(rng() * variable.length)]!
          modes[a] = (modes[a]! + 1 + Math.floor(rng() * (nModes[a]! - 1))) % nModes[a]!
        } else if (r < 0.8 && openerGroups.length > 0) {
          const group = openerGroups[Math.floor(rng() * openerGroups.length)]!
          const x = group[Math.floor(rng() * group.length)]!, y = group[Math.floor(rng() * group.length)]!
          if (x === y) return null
          const [early, later] = position[x]! < position[y]! ? [x, y] : [y, x]
          const lo = prep.preds[later]!.reduce((m, l) => Math.max(m, position[l.from]! + 1), 0)
          if (lo > position[early]!) return null
          list.splice(position[later]!, 1); list.splice(position[early]!, 0, later)
        } else {
          const len = Math.min(list.length, 4 + Math.floor(rng() * 12))
          const p0 = Math.floor(rng() * (list.length - len + 1))
          const segment = list.slice(p0, p0 + len), inSegment = new Set(segment)
          const indegree = new Map(segment.map(a => [a, prep.preds[a]!.filter(l => inSegment.has(l.from)).length]))
          const out: number[] = []
          const ready = segment.filter(a => indegree.get(a) === 0)
          while (ready.length > 0) {
            const a = ready.splice(Math.floor(rng() * ready.length), 1)[0]!
            out.push(a)
            for (const l of prep.succs[a]!) if (inSegment.has(l.to)) { const d = indegree.get(l.to)! - 1; indegree.set(l.to, d); if (d === 0) ready.push(l.to) }
          }
          list.splice(p0, len, ...out)
          for (const a of segment) if (problem.activities[a]!.fixed === undefined && nModes[a]! > 1 && rng() < 0.2) modes[a] = Math.floor(rng() * nModes[a]!)
        }
        return { list, modes }
      }
      // Forward-backward justification: right-justify everything, then decode in the new start order.
      const fbi = (point: Point): Point => {
        const decoded = decoder.decode(point.list, point.modes)
        decoder.justify(decoded, true)
        return { list: precedenceOrder(prep, [...prep.topo].sort((x, y) => decoded.start[x]! - decoded.start[y]! || x - y)), modes: [...point.modes] }
      }
      const tryFbi = async (quota: number): Promise<void> => {
        for (let k = 0; k < 3; k++) {
          if (await shouldStop(quota)) return
          const next = evaluate(fbi(own))
          if (better(next, own) < 0) { own = next; current = next; setLate(next) } else return
        }
      }
      /** Late acceptance on the ranking keys until `quota` evaluations. */
      const climb = async (quota: number): Promise<Scored> => {
        await tryFbi(quota)
        const history = Array.from({ length: L }, () => current)
        for (let it = 0; ; it++) {
          if ((it & 15) === 0 && await shouldStop(quota)) break
          const next = neighbour(current, false)
          if (next === null) { if (spent >= quota) break; continue }
          const scored = evaluate(next)
          const h = it % L
          if (better(scored, history[h]!) <= 0 || better(scored, current) <= 0) { current = scored; setLate(scored) }
          history[h] = current
          if (better(current, own) < 0) { own = current; await tryFbi(quota) }
          if (spent >= quota) break
        }
        return own
      }
      /** One band stage on a later goal: late acceptance on that goal plus a growing penalty for leaving the band. */
      const band = async (stage: number, quota: number): Promise<Scored> => {
        const caps = goals.slice(0, stage).map((goal, k) => own.excess[k]! + goal.step)
        const scale = Math.max(1, Math.abs(own.excess[stage]!))
        const score = (s: Scored, mu: number): number => {
          let over = 0
          caps.forEach((cap, k) => { over += Math.max(0, s.excess[k]! - cap) * (scale / Math.max(1, Math.abs(cap))) })
          return s.decoded.penalty * 1e12 + s.excess[stage]! + mu * over
        }
        const weights = [0.5, 2, 8, 64]
        const start = spent
        let point = own
        for (let w = 0; w < weights.length && stoppedBy === 'done'; w++) {
          const mu = weights[w]!
          const end = start + Math.floor((quota - start) * (w + 1) / weights.length)
          let currentScore = score(point, mu)
          const scores = Array.from({ length: L }, () => currentScore)
          for (let it = 0; ; it++) {
            if ((it & 15) === 0 && await shouldStop(end)) break
            if (spent >= end) break
            const next = neighbour(point, true)
            if (next === null) continue
            const scored = evaluate(next)
            const value = score(scored, mu), h = it % L
            if (value <= scores[h]! || value <= currentScore) { point = scored; currentScore = value; setLate(scored) }
            scores[h] = currentScore
            if (better(scored, own) < 0) own = scored
          }
          if (stoppedBy !== 'done' && stoppedBy !== 'evals') break
        }
        return own
      }
      return { climb, band, best: () => own, adopt: (s: Scored) => { own = s; current = s; setLate(s) } }
    }

    // ── first race: independent climbs from the best distinct starts; the best of them goes on ──
    const distinct: Scored[] = []
    for (const s of scoredStarts) if (!distinct.some(d => d.list.join() === s.list.join() && d.modes.join() === s.modes.join())) distinct.push(s)
    const runs = Math.max(1, Math.min(PHASES.runs, distinct.length))
    const firstEnd = Math.floor(target * PHASES.firstEnd)
    let winnerRun: ReturnType<typeof climber> | undefined
    for (let r = 0; r < runs && stoppedBy === 'done'; r++) {
      const run = climber(options.seed * 7_919 + 104_729 * r, distinct[r] ?? best)
      const found = await run.climb(spent + Math.floor((firstEnd - spent) / (runs - r)))
      if (winnerRun === undefined || better(found, winnerRun.best()) < 0) winnerRun = run
    }
    const main = winnerRun ?? climber(options.seed * 7_919, best)
    if (better(main.best(), best) < 0) best = main.best()
    // ── the winner climbs on; while no plan meets every rule it keeps the second race's share too ──
    if (stoppedBy === 'done') best = await main.climb(Math.floor(target * PHASES.climbEnd))
    const raceEnd = Math.floor(target * PHASES.raceEnd)
    if (best.decoded.penalty > 0 && stoppedBy === 'done') best = await main.climb(raceEnd)
    // ── second race: short climbs restarting from the best plan, each on its own stream ──
    winnerRun = main
    for (let r = 0; r < PHASES.runs && stoppedBy === 'done' && spent < raceEnd; r++) {
      const run = climber(options.seed * 7_919 + 104_729 * (PHASES.runs + r), best)
      const found = await run.climb(spent + Math.floor((raceEnd - spent) / (PHASES.runs - r)))
      if (better(found, best) < 0) { best = found; winnerRun = run }
    }
    winnerRun.adopt(best)
    const finalRun = winnerRun

    // ── cost repair inside the band: drop each bought purchase, then move paid hours back to booked ones ──
    staged = true
    const repairEnd = Math.floor(target * PHASES.repairEnd)
    const tryPoint = (point: Point): boolean => {
      const scored = evaluate(point)
      if (better(scored, best) < 0) { best = scored; return true }
      return false
    }
    for (let improved = true; improved && !(await shouldStop(repairEnd));) {
      improved = false
      for (const key of best.evaluation.used) {
        const p = purchaseIndex.get(key)
        if (p === undefined) continue
        const modes = [...best.modes]
        let changed = false
        for (const a of variable) {
          if (!touches[a]![modes[a]!]!.has(p)) continue
          // the least restrictive mode of the job that cannot draw on this purchase
          let pick = -1
          for (let m = 0; m < nModes[a]!; m++) if (!touches[a]![m]!.has(p) && (pick < 0 || prep.cal[problem.activities[a]!.modes[m]!.calendar]!.list.length > prep.cal[problem.activities[a]!.modes[pick]!.calendar]!.list.length)) pick = m
          if (pick >= 0) { modes[a] = pick; changed = true }
        }
        if (changed && tryPoint({ list: best.list, modes })) improved = true
        if (await shouldStop(repairEnd)) break
      }
      for (const a of variable) {
        if (await shouldStop(repairEnd)) break
        for (const k of cheaper[a]![best.modes[a]!]!) {
          const modes = [...best.modes]; modes[a] = k
          if (tryPoint({ list: best.list, modes })) { improved = true; break }
        }
      }
    }
    finalRun.adopt(best)

    // ── band stages: one per later goal, each on its share ──
    const laterGoals = goals.length > 1 ? goals.length - 1 : 0
    const bandStart = spent, bandEnd = Math.floor(target * PHASES.bandEnd)
    for (let stage = 1; stage <= laterGoals && stoppedBy === 'done'; stage++) {
      const quota = bandStart + Math.floor((bandEnd - bandStart) * stage / laterGoals)
      best = await finalRun.band(stage, quota)
    }
    // ── polish: first-improvement descent over single mode changes of the best plan ──
    for (let improved = true; improved && !(await shouldStop());) {
      improved = false
      for (const a of variable) {
        for (let m = 0; m < nModes[a]! && stoppedBy === 'done'; m++) {
          if (m === best.modes[a]) continue
          const modes = [...best.modes]; modes[a] = m
          if (tryPoint({ list: best.list, modes })) improved = true
          if ((evals & 15) === 0 && await shouldStop()) break
          if (spent >= target) break
        }
        if (stoppedBy !== 'done' || spent >= target) break
      }
    }
    const candidates: Schedule[] = [{ mode: Int32Array.from(best.decoded.mode), start: Int32Array.from(best.decoded.start) }]
    return { candidates, stoppedBy, evals, cpuMs: Math.round(cpu() - cpu0), wallMs: Math.round(performance.now() - wall0), bounds: [] }
  },
})
