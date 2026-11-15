// Ranking keys (A6, adversary r2 item 6). The only place a goal's threshold is subtracted, once:
//   x = max(0, raw - threshold), or for span-over the sum over groups of max(0, span - threshold);
//   key = x when the step is 0, else floor(x / step).
// A key depends only on the option itself, so adding an option changes the recommendation only when
// the new option is itself the best. Exact ties are broken by option key. The engine ranks through here.
// The options table's facts are here too: dominance, and why the recommended option ranks first.

import type { Caveat, PlanInputs } from '../plan/schema.ts'

/** A raw goal metric in the goal's unit: one number, or one span per group for span-over. */
export type RawMetric = number | readonly number[]

export interface RankGoal { readonly threshold: number; readonly step: number }

/** The goal value net of its threshold: what the planner reads as "over" or "late". */
export const goalExcess = (raw: RawMetric, threshold: number): number =>
  typeof raw === 'number' ? Math.max(0, raw - threshold) : raw.reduce((sum, span) => sum + Math.max(0, span - threshold), 0)

/** Floating noise (MILP bounds, unit conversion) must not move a value across a step boundary. */
const EPSILON = 1e-9

export const goalKey = (excess: number, step: number): number => (step > 0 ? Math.floor(excess / step + EPSILON) : excess)

export const goalKeys = (raw: readonly RawMetric[], goals: readonly RankGoal[]): number[] =>
  goals.map((goal, k) => goalKey(goalExcess(raw[k] ?? 0, goal.threshold), goal.step))

/** Lexicographic comparison of key vectors; negative when `a` ranks first. */
export const compareKeys = (a: readonly number[], b: readonly number[]): number => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0)
    if (Math.abs(d) > EPSILON) return d < 0 ? -1 : 1
  }
  return 0
}

/**
 * Inside one search only: a later goal counts only among plans within the earlier goals' tolerance band
 * of a reference (the incumbent), as the gate compares cost only within 1 h of the best finish. Values
 * are excesses (goalExcess). Options are still ranked across a set by keys (compareKeys), never by this.
 */
export const compareStaged = (a: readonly number[], b: readonly number[], reference: readonly number[], goals: readonly RankGoal[]): number => {
  for (let k = 0; k < goals.length; k++) {
    const x = a[k] ?? 0, y = b[k] ?? 0
    if (k === goals.length - 1) return Math.abs(x - y) <= EPSILON ? 0 : x < y ? -1 : 1
    // The band starts at the best value known: the reference's, or either plan's when it is better.
    const band = Math.min(reference[k] ?? Infinity, x, y) + goals[k]!.step + EPSILON
    const inA = x <= band, inB = y <= band
    if (inA && inB) continue
    if (inA !== inB) return inA ? -1 : 1
    if (Math.abs(x - y) > EPSILON) return x < y ? -1 : 1
  }
  return 0
}

/** Anything that can be ranked: feasible options carry keys, the rest rank last. */
export interface Rankable { readonly key: string; readonly feasible: boolean; readonly keys: readonly number[] }

/** Feasible options by keys, ties by option key; infeasible, unresolved and stale ones last, by key. */
export const compareOptions = (a: Rankable, b: Rankable): number => {
  if (a.feasible !== b.feasible) return a.feasible ? -1 : 1
  const byKeys = a.feasible ? compareKeys(a.keys, b.keys) : 0
  if (byKeys !== 0) return byKeys
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0
}

export const rankOptions = <T extends Rankable>(options: readonly T[]): T[] => [...options].sort(compareOptions)

/** The recommended option: the first feasible one in rank order, if any. */
export const recommend = <T extends Rankable>(options: readonly T[]): T | undefined => rankOptions(options).find(option => option.feasible)

/**
 * Dominance (design §4.1): the feasible options that another feasible option is no worse than on every goal
 * key and better on one, in input order, each with `by`, the best-ranked option that dominates it (the
 * options section's `dominated: {by}`). They are folded on the screen, never deleted. Callers leave lead
 * what-ifs out: they are cards, never folded.
 */
export const dominatedBy = (options: readonly Rankable[]): Array<{ readonly key: string; readonly by: string }> => {
  const feasible = options.filter(option => option.feasible)
  const beats = (a: Rankable, b: Rankable): boolean => {
    let better = false
    for (let k = 0; k < Math.max(a.keys.length, b.keys.length); k++) {
      const d = (a.keys[k] ?? 0) - (b.keys[k] ?? 0)
      if (d > EPSILON) return false
      if (d < -EPSILON) better = true
    }
    return better
  }
  return feasible.flatMap(option => {
    const by = rankOptions(feasible.filter(other => other !== option && beats(other, option)))[0]
    return by === undefined ? [] : [{ key: option.key, by: by.key }]
  })
}

/** An option's ranking keys and, per goal, its excess in the goal's unit (goalExcess): what "why recommended" is said from. */
export interface RankFacts extends Rankable { readonly excess: readonly number[] }

/**
 * Why the recommended option ranks first (design §4.2): against the best other feasible option, the first
 * goal on which their keys differ, and the differences in the goals' units (recommended minus other, so
 * negative is better) on that goal and every later one. `tie`: equal on every key, first by option key only.
 * Undefined when no other option is feasible. Callers leave lead what-ifs out.
 */
export const recommendedBecause = (options: readonly RankFacts[], recommended: string):
  { readonly versus: string; readonly goal: number; readonly differences: ReadonlyArray<{ readonly goal: number; readonly by: number }> } | { readonly versus: string; readonly tie: true } | undefined => {
  const chosen = options.find(option => option.key === recommended)
  if (chosen === undefined || !chosen.feasible) return undefined
  const other = rankOptions(options.filter(option => option.key !== recommended)).find(option => option.feasible)
  if (other === undefined) return undefined
  const goal = chosen.keys.findIndex((key, k) => Math.abs(key - (other.keys[k] ?? 0)) > EPSILON)
  if (goal < 0) return { versus: other.key, tie: true }
  const differences = chosen.excess.flatMap((excess, k) => (k < goal ? [] : [{ goal: k, by: excess - (other.excess[k] ?? 0) }]))
  return { versus: other.key, goal, differences }
}

/** What the method options an option uses leave unpriced (their caveats, as the plan states them), per method option with any. */
export const unpricedCaveats = (inputs: Pick<PlanInputs, 'methods'>, methods: ReadonlyArray<{ readonly choice: string; readonly option: string }>): Array<{ readonly choice: string; readonly option: string; readonly caveats: readonly Caveat[] }> =>
  methods.flatMap(pick => {
    const caveats = inputs.methods.find(choice => choice.key === pick.choice)?.options.find(option => option.key === pick.option)?.caveats
    return caveats === undefined || caveats.length === 0 ? [] : [{ choice: pick.choice, option: pick.option, caveats }]
  })
