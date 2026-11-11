// Status in words, generated from the stored structure and never stored. The status and goal words are
// exactly the status schema's; everything around them explains what they cover.
import type { Certificate, GoalWord, PlanInputs, StatusWord } from '../plan/schema.ts'
import { hoursNumber, hoursText, quantityText, type Mark, type TimeFormat } from './format.ts'
import { joinWords, type Goal, type Names, type Status } from './model.ts'

export const statusMark = (word: StatusWord): Mark => ({
  'validated feasible': { shape: '✓', word },
  'proven infeasible': { shape: '✕', word },
  'invalid input': { shape: '!', word },
  'unsupported feature': { shape: '!', word },
  cancelled: { shape: '–', word },
  unresolved: { shape: '?', word },
} satisfies Record<StatusWord, Mark>)[word]

/**
 * One word per goal on the screen (maint's walk 4, N4-1): "proven optimal" when the bound equals the value,
 * otherwise "best found"; how far it could be from the best is said only as a gap, never as "best possible".
 */
export const goalMark = (word: GoalWord): Mark =>
  word === 'proven optimal' ? { shape: '✓', word } : { shape: '≈', word: 'best found' }

export interface Context {
  readonly inputs: PlanInputs
  readonly names: Names
  readonly format: TimeFormat
}

/** "time over the 54 h guideline for the Train A cooling chain" */
export const goalName = (goal: Goal, context: Context): string => {
  const groups = goal.scope?.groups?.length ? ` for ${context.names.list(goal.scope.groups, context.names.group)}` : ''
  const tags = goal.scope?.tags?.length ? ` of jobs tagged ${joinWords(goal.scope.tags.map(tag => `“${tag}”`))}` : ''
  const threshold = goal.threshold === undefined ? '' : ` the ${quantityText(goal.threshold.value, goal.threshold.unit)}`
  switch (goal.metric) {
    case 'span-over': return goal.threshold === undefined ? `outage span${groups}` : `time over${threshold} guideline${groups}`
    case 'finish': return 'finish of the last job'
    case 'extra-cost': return goal.threshold === undefined ? 'extra cost' : `extra cost above${threshold}`
    case 'unavailable-hours': return `equipment-hours out of service${groups}`
    case 'lateness': return `lateness${tags} past their target`
  }
}

/** "costs compared in steps of NOK 25,000", or nothing for an exact goal. */
export const goalStep = (goal: Goal): string | null =>
  goal.tolerance.value === 0 ? null : `compared in steps of ${quantityText(goal.tolerance.value, goal.tolerance.unit)}`

/** One sentence per goal in priority order, e.g. "1. Time over the 54 h guideline …: 0 h." */
export const goalOrderText = (goals: readonly Goal[], context: Context): readonly string[] =>
  goals.map((goal, index) => {
    const step = goalStep(goal)
    return `${index + 1}. Least ${goalName(goal, context)}${step === null ? '' : ` (${step})`}`
  })

export interface GoalLine {
  readonly name: string
  readonly value: string
  readonly mark: Mark
  /** How far from best, in words. */
  readonly distance: string
}

const valueText = quantityText
const crewHours = (hours: number): string => `${hoursNumber(hours)} crew-hours`

const viaWords = {
  link: 'a link', bracket: 'tag-out before the work and test after it', 'support-order': 'support order',
  'span-limit': 'an outage limit', window: 'the window', due: 'its due time', release: 'its earliest start', lock: 'a lock',
} as const

/** The proof behind "proven infeasible", in planner words. */
export const certificateText = (cause: Certificate, context: Context): string => {
  const { names, format } = context
  switch (cause.kind) {
    case 'chain': {
      const jobs = cause.jobs.length <= 3
        ? names.list(cause.jobs, names.job)
        : `${cause.jobs.length} chained jobs, from ${names.job(cause.jobs[0]!)} to ${names.job(cause.jobs[cause.jobs.length - 1]!)}`
      return `${jobs} need ${hoursText(cause.workHours)} of work one after another, but ${names.list(cause.calendars, names.calendar)} ${cause.calendars.length === 1 ? 'gives' : 'give'} only ${hoursText(cause.availableHours)} of working time between ${format.clock(cause.from)} and ${format.clock(cause.by)}.`
    }
    case 'energy': {
      const who = names.list(cause.resources, names.resource)
      const within = cause.span === undefined ? `between ${format.clock(cause.from)} and ${format.clock(cause.to)}` : `inside any outage that “${names.rule(cause.span)}” allows, opening between ${format.clock(cause.from)} and ${format.clock(cause.to)}`
      return `${crewHours(cause.requiredHours)} of ${who} must fit ${within}; at most ${crewHours(cause.availableHours)} exist.`
    }
    case 'availability':
      return `“${names.rule(cause.rule)}” cannot hold: ${names.list(cause.items, names.equipment)} would be out together from ${format.clock(cause.from)} to ${format.clock(cause.to)}.`
    case 'temporal':
      return cause.steps.length === 0
        ? 'The times cannot line up inside the window.'
        : `The times cannot line up: ${cause.steps.map(step => `${names.job(step.job)} (held by ${viaWords[step.via]})`).join(', then ')}.`
  }
}

/**
 * Every problem code the Module, the solver and the checker give, in planner words. Codes come in
 * kebab-case and snake_case; both read the same. A code not listed here is said generally, never shown raw.
 */
const problemWords: Readonly<Record<string, string>> = {
  world_value_unread: 'a World value is not read yet; read the World values',
  world_unread: 'a World value is not read yet; read the World values',
  world_value_ambiguous: 'a World value is named twice in the last read',
  world_value_not_number: 'a World value is not a number',
  world_unusable: 'a World value is in a unit the planner cannot use here',
  unit_unknown: 'a World value has a unit the planner does not convert',
  unit_mismatch: 'a value has the wrong kind of unit',
  calendar_needs_zone: 'weekly shifts need the site time zone',
  calendar_off_grid: 'a shift boundary is not on the plan\'s time step',
  no_window: 'the plan has no window yet', missing_window: 'the plan has no window yet', window_missing: 'the plan has no window yet',
  window_off_grid: 'the window does not start and end on the plan\'s time step',
  zone_off_grid: 'the site time zone is not on the plan\'s time step',
  missing_estimate: 'a job has no estimate',
  missing_crew: 'a job has no crew or tool', no_crew: 'has no crew or tool yet; choose one in its job panel',
  working_time_without_resource: 'has working time but no crew or tool to do it; choose one in its job panel',
  no_working_calendar: 'has no working time on its crew\'s shifts',
  unknown_key: 'names something that is no longer in the plan', unknown_reference: 'names something that is no longer in the plan',
  method_choice: 'the method choice is not made', method_not_chosen: 'the method choice is not made',
  not_in_variant: 'belongs to a method that is not chosen',
  support_cycle: 'supports go round in a circle',
  link_cycle: 'links go round in a circle',
  bracket_missing: 'work inside the item has no tag-out before it or no test after it',
  inside_work_without_bracket: 'work inside the item has no tag-out before it or no test after it',
  inside_work_needs_one_item: 'work inside an item is on exactly one item',
  no_tag_out: 'worked on inside but never tagged out',
  no_test: 'worked on inside but never tested back into service',
  not_returned: 'tagged out but never tested back into service',
  equipment_missing: 'names equipment that is no longer in the plan',
  below_minimum: 'would run shorter than its declared minimum',
  duration_ambiguous: 'has two durations for the same crew or tool',
  duration_rounded_up: 'was rounded up to the plan\'s time step',
  limit_rounded_down: 'an outage limit was rounded down to the plan\'s time step',
  where_unit: 'a crew or tool property is in a different unit from what the job needs',
  attribute_missing: 'needs a property no crew or tool has',
  eligibility_ends: 'no crew or tool qualifies for the whole job',
  goal_unit: 'a goal is in a unit that does not fit it',
  handover_with_resource_duration: 'a job whose duration depends on its crew cannot be handed over',
  keep_in_service_mixed_members: 'a keep-in-service rule mixes equipment and crews',
  lock_before_data_date: 'a fixed start lies before the plan\'s "now"',
  lock_off_grid: 'a fixed start is not on the plan\'s time step',
  order_deadline_passed: 'an order deadline has passed', order_passed: 'an order deadline has passed',
  protected_equipment: 'touches protected equipment',
  purchase_off_grid: 'bought time is not on the plan\'s time step',
  purchase_overlaps_booked_time: 'bought time overlaps time already booked',
  replaced_time_overlaps: 'a rebooking gives up time that overlaps another',
  span_limit_reentry: 'an outage limit allows one continuous outage only',
  too_many_modes: 'has too many ways to be done (crews times methods)',
  adds_crew_hours: 'buys crew hours, which "days only" excludes',
  precondition_unread: 'a precondition is not read from World yet',
  precondition_unmet: 'a precondition is not met at read time',
}

/** A problem code in words, e.g. "a World value is not read yet …: Service Water Pump A". */
export const problemText = (problem: { readonly code: string; readonly about: readonly string[] }, names: Names): string => {
  const words = problemWords[problem.code.replaceAll('-', '_')] ?? 'a check did not pass'
  return problem.about.length === 0 ? `${words.charAt(0).toUpperCase()}${words.slice(1)}.` : `${names.list(problem.about)}: ${words}.`
}

export interface StatusView {
  readonly mark: Mark
  /** The status word, exactly as the status schema has it. */
  readonly word: StatusWord
  /** One sentence on what the word covers. */
  readonly sentence: string
  readonly goals: readonly GoalLine[]
  readonly details: readonly string[]
  /** How the search ended, e.g. "Search used 9 s of computing time; it ran to the end." */
  readonly run: string | null
}

/** One line on how the search ended: it ran to the end, or it stopped early and why. Said once, apart from the goals. */
const runText = (status: Extract<Status, { run: unknown }>): string => {
  const { run } = status
  if (run.stoppedBy === 'done') return 'The search ran to the end.'
  const why = {
    evals: 'when its time was up', cpu: 'when its time was up', wall: 'when its time was up', memory: 'at the memory limit',
    ended: 'when the solver process ended', cancelled: run.stoppedByWho === 'host' ? 'when the Host stopped it' : 'because you cancelled it',
  }[run.stoppedBy]
  return `The search stopped early, ${why}.`
}

/** "0 h, proven optimal" or "NOK 472,650, best found; could be up to NOK 132,650 better". */
export const goalResult = (goal: GoalLine): string => `${goal.value}, ${goal.mark.word}${goal.distance === '' ? '' : `; ${goal.distance}`}`

export const statusView = (status: Status, context: Context): StatusView => {
  const mark = statusMark(status.word)
  switch (status.word) {
    case 'validated feasible': {
      const goals = status.goals.map((line): GoalLine => {
        const goal = context.inputs.goals[line.goal]
        const name = goal === undefined ? `goal ${line.goal + 1}` : goalName(goal, context)
        const value = valueText(line.value, line.unit)
        const gap = line.word === 'proven optimal' || line.bound === undefined ? 0 : line.value - line.bound.value
        const distance = gap > 0 ? `could be up to ${valueText(gap, line.unit)} better` : ''
        return { name, value, mark: goalMark(line.word), distance }
      })
      return {
        mark, word: status.word, goals, details: [],
        sentence: 'Every hard rule holds: the independent rule check found no break.',
        run: runText(status),
      }
    }
    case 'proven infeasible':
      return { mark, word: status.word, goals: [], run: runText(status), sentence: 'No plan can keep every hard rule. The proof:', details: [certificateText(status.cause, context)] }
    case 'invalid input':
      return { mark, word: status.word, goals: [], run: null, sentence: 'The plan cannot be generated until these are fixed:', details: status.problems.map(problem => problemText(problem, context.names)) }
    case 'unsupported feature':
      return { mark, word: status.word, goals: [], run: null, sentence: 'The plan uses a rule the planner cannot model yet:', details: status.problems.map(problem => problemText(problem, context.names)) }
    case 'cancelled':
      return { mark, word: status.word, goals: [], run: runText(status), sentence: 'The search stopped before it found a plan.', details: [] }
    case 'unresolved': {
      const attempt = status.attempt === undefined ? [] : [`The best attempt would finish ${context.names.job(status.attempt.job)} at ${context.format.clock(status.attempt.wouldFinish)}, ${hoursText(status.attempt.pastWindowHours)} past the window.`]
      return { mark, word: status.word, goals: [], run: runText(status), sentence: 'No plan was found in the time allowed. This is not proof that none exists.', details: attempt }
    }
  }
}

/** The one-line answer for the attention column, e.g. "✓ validated feasible · time over … : 0 h, proven optimal". */
export const statusLine = (view: StatusView): string => {
  const first = view.goals[0]
  return first === undefined
    ? `${view.word}: ${view.sentence}`
    : `${view.word}; least ${first.name}: ${goalResult(first)}`
}
