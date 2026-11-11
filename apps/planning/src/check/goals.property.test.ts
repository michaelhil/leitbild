import { describe, expect, test } from 'bun:test'
import type { PlanInputs } from '../plan/schema.ts'
import { checkPlan, type CheckRow } from './check.ts'
import { goalsProperty } from '../../tests/harness/goals-property.ts'
import { enumerate, smallInstance } from '../../tests/harness/bounds-soundness.ts'
import type { GeneratePort, HarnessOption } from '../../tests/harness/ports.ts'

// The property runs on lane S's generate at integration. Here two engine doubles show the harness: one
// that only offers checker-validated schedules, and one that cuts a corner when the first goal rewards it.
const run = { grid: '30min' as const, engine: 'double', formulation: 'double', seed: 1, budget: { evals: 1, cpuMs: 1, wallMs: 1 }, stoppedBy: 'done' as const, evals: 1, cpuMs: 1 }
const seeds = [5, 7, 9, 10]   // feasible instances; 10 needs a crew and the tool together

/** Best schedule by the goals, lexicographically on raw value net of threshold (a stand-in for rank.ts). */
const best = (inputs: PlanInputs, variant: HarnessOption['variant'], schedules: readonly CheckRow[][]): CheckRow[] | undefined => {
  const keyOf = (rows: readonly CheckRow[]) => checkPlan(inputs, variant, rows).goals.map((goal, index) => {
    const threshold = inputs.goals[index]!.threshold?.value ?? 0
    return 'value' in goal ? Math.max(0, goal.value - threshold) : goal.spans.reduce((sum, span) => sum + Math.max(0, span.value - threshold), 0)
  })
  let chosen: { rows: CheckRow[]; key: number[] } | undefined
  for (const rows of schedules) {
    const key = keyOf(rows)
    const better = chosen === undefined || key.findIndex((value, index) => value !== chosen!.key[index]) >= 0 && key[key.findIndex((value, index) => value !== chosen!.key[index])]! < chosen.key[key.findIndex((value, index) => value !== chosen!.key[index])]!
    if (better) chosen = { rows, key }
  }
  return chosen?.rows
}

const engine = (cutsCorners: boolean): GeneratePort => ({
  generate: async inputs => {
    const seed = Number(inputs.settings.title.split(' ')[1])
    const { variant } = smallInstance(seed)
    const rows = best(inputs, variant, enumerate(inputs, variant))
    if (rows === undefined) return []
    // the corner: when finish comes first, drop the operator from the last test, as if it were free
    const cut = cutsCorners && inputs.goals[0]?.metric === 'finish'
      ? rows.map(entry => entry.job === 'Q-TEST' ? { ...entry, uses: [] } : entry)
      : rows
    return [{ key: 'o1', variant, status: { word: 'validated feasible', goals: [], run }, rows: cut }]
  },
})

describe('no goal order, threshold or tolerance produces a plan that breaks a hard rule', () => {
  test('an engine that offers only checker-validated schedules passes every trial', async () => {
    for (const seed of seeds) expect(await goalsProperty(smallInstance(seed).inputs, engine(false), 6, seed)).toEqual([])
  }, 60_000)
  test('an engine that cuts a corner for one goal order is caught', async () => {
    const failures = (await Promise.all(seeds.map(seed => goalsProperty(smallInstance(seed).inputs, engine(true), 6, seed)))).flat()
    expect(failures.length).toBeGreaterThan(0)
    expect(failures.every(failure => failure.goals[0]?.metric === 'finish' && failure.problem.startsWith('called validated feasible'))).toBe(true)
  }, 60_000)
})
