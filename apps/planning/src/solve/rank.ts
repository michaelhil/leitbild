// Ranking keys (A6, adversary r2 item 6). The only place a goal's threshold is subtracted, once:
//   x = max(0, raw - threshold), or for span-over the sum over groups of max(0, span - threshold);
//   key = x when the step is 0, else floor(x / step).
// A key depends only on the option itself, so adding an option changes the recommendation only when
// the new option is itself the best. Exact ties are broken by option key. The engine ranks through here.

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
