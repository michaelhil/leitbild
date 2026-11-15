// The goals editor (T12, design §7): the plan's goals reordered, with a threshold and a step per goal, sent as
// one `goals` edit through the preview like every other edit. Goals are the planner's to set; a goal never
// weakens a hard rule. With no undo in this version, the screen keeps the order the goals had before the
// first change it saved this session, so "Undo goal changes made since you opened this plan" can put it back, through the preview again.
import type { Edit } from '../plan/edit-schema.ts'
import type { Goal } from './model.ts'
import { goalOrderText, goalShort, type Context } from './status-text.ts'

/** One goal row as the editor holds it: the saved goal it came from, and the values typed for it. */
export interface GoalDraft {
  readonly from: number
  readonly threshold: string | null
  readonly step: string
}

export const draftOf = (goals: readonly Goal[]): readonly GoalDraft[] =>
  goals.map((goal, from) => ({ from, threshold: goal.threshold === undefined ? null : String(goal.threshold.value), step: String(goal.tolerance.value) }))

/** The draft with one row moved up (-1) or down (+1); unchanged at either end. */
export const moved = (draft: readonly GoalDraft[], index: number, by: -1 | 1): readonly GoalDraft[] => {
  const to = index + by
  if (to < 0 || to >= draft.length) return draft
  const next = [...draft]
  ;[next[index], next[to]] = [next[to]!, next[index]!]
  return next
}

const amount = (text: string): number | null => {
  const value = Number(text.trim().replace(',', '.'))
  return text.trim() === '' || !Number.isFinite(value) || value < 0 ? null : value
}

/** The goals the draft stands for, or the problems in planner words. */
export const goalsFromDraft = (draft: readonly GoalDraft[], saved: readonly Goal[], context: Context): { readonly ok: true; readonly goals: readonly Goal[] } | { readonly ok: false; readonly problems: readonly string[] } => {
  const problems: string[] = []
  const goals = draft.map((row): Goal => {
    const goal = saved[row.from]!
    const name = goalShort(goal, context)
    const step = amount(row.step)
    if (step === null) problems.push(`${name}: give the step as a number, 0 or more.`)
    const threshold = row.threshold === null || goal.threshold === undefined ? null : amount(row.threshold)
    if (row.threshold !== null && threshold === null) problems.push(`${name}: give the threshold as a number, 0 or more.`)
    return {
      ...goal,
      ...goal.threshold === undefined || threshold === null ? {} : { threshold: { value: threshold, unit: goal.threshold.unit } },
      tolerance: { value: step ?? goal.tolerance.value, unit: goal.tolerance.unit },
    }
  })
  return problems.length > 0 ? { ok: false, problems } : { ok: true, goals }
}

export const sameGoals = (left: readonly Goal[], right: readonly Goal[]): boolean => JSON.stringify(left) === JSON.stringify(right)

/** The one edit that sets the goals, in priority order. */
export const goalsEditOf = (goals: readonly Goal[]): readonly Edit[] => [{ edit: 'goals', goals: goals.map(goal => structuredClone(goal)) }]

/** The preview's title: "New goal order: 1. Extra cost · 2. Over the 54 h guideline · 3. …". */
export const goalsLabel = (goals: readonly Goal[], context: Context, words = 'New goal order'): string =>
  `${words}: ${goals.map((goal, index) => `${index + 1}. ${goalShort(goal, context)}`).join(' · ')}`

export interface GoalRow {
  readonly index: number
  readonly short: string
  /** "Least extra cost (compared in steps of NOK 25,000)": the full wording, said once, here. */
  readonly full: string
  /** The threshold's unit, or null for a goal without one. */
  readonly thresholdUnit: string | null
  readonly stepUnit: string
}

export const goalRows = (draft: readonly GoalDraft[], saved: readonly Goal[], context: Context): readonly GoalRow[] =>
  draft.map((row, index) => {
    const goal = saved[row.from]!
    return {
      index, short: goalShort(goal, context), full: goalOrderText([goal], context)[0]!.replace(/^1\. /, ''),
      thresholdUnit: goal.threshold?.unit ?? null, stepUnit: goal.tolerance.unit,
    }
  })
