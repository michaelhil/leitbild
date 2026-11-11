// The TypeScript engine behind the Engine seam: or's improved heuristic (R/or/gate/src/search.ts) on
// the plan decoder. Priority-rule construction (latest finish, successors, ranked weight, bottleneck
// lists), then late-acceptance hill climbing over (activity list, mode vector) with shift, mode,
// outage-swap, segment-ruin and focus moves, forward-backward justification, and a cost phase that
// compares cost only among plans inside the earlier goals' tolerance band of the best found, with a move
// that shifts paid time back into booked hours. Budgets: evaluations, thread CPU, wall; an abort stops
// it within one yield (about 50 ms). Deterministic for a seed and an evaluation budget.
import { SOLVER_VERSIONS } from './compile.ts'
import { makeDecoder, precedenceOrder, prepare, type Decoded, type Evaluation, type Prepared } from './decode.ts'
import type { Engine, EngineResult, EngineStop, NormalizedProblem, Schedule } from './problem.ts'
import { compareKeys, compareStaged, goalExcess, goalKeys } from './rank.ts'

export const mulberry32 = (seed: number) => () => {
  seed |= 0; seed = (seed + 0x6d2b79f5) | 0
  let r = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r
  return ((r ^ (r >>> 14)) >>> 0) / 4294967296
}

/** Thread CPU milliseconds (per Worker in Bun), the unit of every CPU budget. */
export const threadCpuMs = (): number => { const usage = process.threadCpuUsage(); return (usage.user + usage.system) / 1_000 }

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

/**
 * Share of the budget for phase A (all goals on the ranking keys); the rest goes to one band stage per
 * later goal and the polish. 0.7 measured on twin v3 (11 Nov): 0.5 lost the finish in the cost stage.
 */
export const PHASE_A_SHARE = 0.7

export interface SearchOptions {
  /** CPU clock in milliseconds; thread CPU by default. Tests may pass a wall clock. */
  readonly clock?: () => number
  /** Late-acceptance history length. */
  readonly lateAcceptance?: number
}

export const searchEngine = (searchOptions: SearchOptions = {}): Engine => ({
  name: SOLVER_VERSIONS.engine,
  solve: async (problem: NormalizedProblem, options): Promise<EngineResult> => {
    const cpu = searchOptions.clock ?? threadCpuMs
    const cpu0 = cpu(), wall0 = performance.now()
    const { budget, signal } = options
    const prep = prepare(problem)
    const rng = mulberry32(options.seed)
    const decoder = makeDecoder(prep)
    const n = prep.n
    const goals = problem.goals
    let evals = 0
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
      decoder.justify(decoded)
      const evaluation = decoder.evaluate(decoded)
      const excess = goals.map((goal, k) => goalExcess(evaluation.raw[k] ?? 0, goal.threshold))
      if (decoded.penalty === 0) noteReference(excess)
      return { ...point, decoded, evaluation, excess, keys: goalKeys(evaluation.raw, goals) }
    }
    // Phase A climbs on the ranking keys (rank.ts); the later phases and the polish compare inside the
    // band around the best seen (staged), so cost is weighed only among plans near the best finish.
    let staged = false
    const better = (a: Scored, b: Scored, _incumbent?: Scored): number => {
      if (a.decoded.penalty !== b.decoded.penalty) return a.decoded.penalty < b.decoded.penalty ? -1 : 1
      if (!staged) return compareKeys(a.keys, b.keys)
      return compareStaged(a.excess, b.excess, reference, goals)
    }
    const shouldStop = async (): Promise<boolean> => {
      if (stoppedBy !== 'done') return true
      if (signal.aborted) { stoppedBy = 'cancelled'; return true }
      if (evals >= budget.evals) { stoppedBy = 'evals'; return true }
      if (cpu() - cpu0 >= budget.cpuMs) { stoppedBy = 'cpu'; return true }
      const now = performance.now()
      if (now - wall0 >= budget.wallMs) { stoppedBy = 'wall'; return true }
      if (now - lastYield > 50) {
        await new Promise(resolve => setTimeout(resolve, 0))
        lastYield = performance.now()
        if (signal.aborted) { stoppedBy = 'cancelled'; return true }
      }
      return false
    }

    const nModes = problem.activities.map(activity => activity.modes.length)
    const fixedMode = problem.activities.map(activity => activity.fixed?.mode)
    const modeSets: number[][] = [
      problem.activities.map((_, a) => fixedMode[a] ?? 0),
      problem.activities.map((activity, a) => fixedMode[a] ?? activity.modes.reduce((best, _, m) => (elapsedEstimate(prep, a, m) < elapsedEstimate(prep, a, best) ? m : best), 0)),
    ]
    // Cheaper siblings: the same resources on fewer (unpriced) hours, for the paid-time move.
    const cheaper = problem.activities.map(activity => activity.modes.map((mode, m) => activity.modes.flatMap((other, k) => {
      if (k === m || other.demands.length !== mode.demands.length || other.demands.some((d, i) => d.resource !== mode.demands[i]!.resource)) return []
      const small = prep.cal[other.calendar]!.list.length, large = prep.cal[mode.calendar]!.list.length
      return small < large ? [k] : []
    })))
    const variable = problem.activities.flatMap((activity, a) => (activity.fixed === undefined && activity.modes.length > 1 ? [a] : []))

    const starts: Point[] = []
    if (options.initial !== undefined) {
      const initial = options.initial
      starts.push({ list: precedenceOrder(prep, [...prep.topo].sort((x, y) => initial.start[x]! - initial.start[y]!)), modes: [...initial.mode] })
    }
    for (const list of priorityLists(prep, rng, 8)) for (const modes of modeSets) starts.push({ list, modes: [...modes] })
    let current: Scored | undefined
    for (const start of starts) {
      const scored = evaluate(start)
      if (current === undefined || better(scored, current, current) < 0) current = scored
      if (await shouldStop()) break
    }
    let best = current!
    let late: number[] = []
    const setLate = (s: Scored): void => {
      late = []
      for (let a = 0; a < n; a++) if (s.decoded.finish[a]! > problem.activities[a]!.deadline) late.push(a)
    }
    setLate(current!)
    const accept = (s: Scored): void => { if (better(s, best, best) < 0) best = s }

    // Forward-backward justification: right-justify everything, then decode in the new start order.
    const fbi = (point: Point): Point => {
      const decoded = decoder.decode(point.list, point.modes)
      decoder.justify(decoded, true)
      return { list: precedenceOrder(prep, [...prep.topo].sort((x, y) => decoded.start[x]! - decoded.start[y]! || x - y)), modes: [...point.modes] }
    }
    const tryFbi = async (): Promise<void> => {
      for (let k = 0; k < 3; k++) {
        if (await shouldStop()) return
        const next = evaluate(fbi(best))
        if (better(next, best, best) < 0) { best = next; current = next; setLate(next) } else return
      }
    }
    await tryFbi()

    const position = new Int32Array(n)
    const openersByGroup = problem.coverage.filter(rule => rule.items.length > 1).map(rule => [...new Set(rule.items.flatMap(i => prep.itemOpeners[i]!))])
    // As or's search: reorder the outages of one keep-in-service group (k-of-G), never tags inside one span.
    const spanOpenerGroups = openersByGroup.filter(list => list.length > 1)
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
      if (late.length > 0 && rng() < 0.4) return promote(point)
      const list = [...point.list], modes = [...point.modes]
      list.forEach((a, p) => { position[a] = p })
      const r = rng()
      if (costPhase && r < 0.15 && variable.length > 0) {
        // Paid time back into booked hours: switch a job to a sibling mode on fewer, unpriced hours.
        const candidates = variable.filter(a => cheaper[a]![modes[a]!]!.length > 0)
        if (candidates.length === 0) return null
        const a = candidates[Math.floor(rng() * candidates.length)]!
        const options = cheaper[a]![modes[a]!]!
        modes[a] = options[Math.floor(rng() * options.length)]!
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
      } else if (r < 0.8 && spanOpenerGroups.length > 0) {
        const group = spanOpenerGroups[Math.floor(rng() * spanOpenerGroups.length)]!
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

    const L = searchOptions.lateAcceptance ?? 60
    // Phases share the binding budget (CPU, wall or evaluations): with an evaluation budget the run is
    // reproducible; with a CPU budget each phase still gets its own share of time.
    const progress = (): number => Math.max((cpu() - cpu0) / budget.cpuMs, (performance.now() - wall0) / budget.wallMs, evals / budget.evals)
    const laterGoals = goals.length > 1 ? goals.length - 1 : 0
    const endA = laterGoals > 0 ? PHASE_A_SHARE : 1
    // Phase A: late acceptance on the full staged comparison.
    let history = Array.from({ length: L }, () => current!)
    for (let it = 0; ; it++) {
      if ((it & 15) === 0 && (await shouldStop() || progress() >= endA)) break
      const next = neighbour(current!, false)
      if (next === null) continue
      const scored = evaluate(next)
      const h = it % L
      if (better(scored, history[h]!, best) <= 0 || better(scored, current!, best) <= 0) { current = scored; setLate(scored) }
      history[h] = current!
      if (better(current!, best, best) < 0) { accept(current!); await tryFbi() }
    }
    staged = true
    // Phase B, one stage per later goal, each with its own CPU share: late acceptance on that goal plus
    // a growing penalty for leaving the earlier goals' band around the best found.
    for (let stage = 1; stage <= laterGoals && stoppedBy === 'done'; stage++) {
      const stageStart = progress()
      const stageEnd = PHASE_A_SHARE + (1 - PHASE_A_SHARE) * stage / laterGoals - (stage === laterGoals ? 0.05 : 0)
      const caps = goals.slice(0, stage).map((goal, k) => best.excess[k]! + goal.step)
      const scale = Math.max(1, Math.abs(best.excess[stage]!))
      const score = (s: Scored, mu: number): number => {
        let over = 0
        caps.forEach((cap, k) => { over += Math.max(0, s.excess[k]! - cap) * (scale / Math.max(1, Math.abs(cap))) })
        return s.decoded.penalty * 1e12 + s.excess[stage]! + mu * over
      }
      const weights = [0.25, 0.5, 1, 2, 4, 8, 64]
      let point = best
      for (let w = 0; w < weights.length && stoppedBy === 'done'; w++) {
        const mu = weights[w]!
        const weightEnd = stageStart + (stageEnd - stageStart) * (w + 1) / weights.length
        let currentScore = score(point, mu)
        const scores = Array.from({ length: L }, () => currentScore)
        for (let it = 0; ; it++) {
          if ((it & 15) === 0 && (await shouldStop() || progress() >= weightEnd)) break
          const next = neighbour(point, true)
          if (next === null) continue
          const scored = evaluate(next)
          const value = score(scored, mu), h = it % L
          if (value <= scores[h]! || value <= currentScore) { point = scored; currentScore = value; setLate(scored) }
          scores[h] = currentScore
          accept(scored)
        }
      }
    }
    // Polish: first-improvement descent over single mode changes of the best plan.
    for (let improved = true; improved && !(await shouldStop());) {
      improved = false
      for (const a of variable) {
        for (let m = 0; m < nModes[a]! && stoppedBy === 'done'; m++) {
          if (m === best.modes[a]) continue
          const modes = [...best.modes]; modes[a] = m
          const scored = evaluate({ list: best.list, modes })
          if (better(scored, best, best) < 0) { best = scored; improved = true }
          if ((evals & 15) === 0 && await shouldStop()) break
        }
        if (stoppedBy !== 'done') break
      }
    }
    const candidates: Schedule[] = [{ mode: Int32Array.from(best.decoded.mode), start: Int32Array.from(best.decoded.start) }]
    return { candidates, stoppedBy, evals, cpuMs: Math.round(cpu() - cpu0), wallMs: Math.round(performance.now() - wall0), bounds: [] }
  },
})
