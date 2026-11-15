// "Needs your attention": the cards the plan screen leads with, in the order a planner acts on them.
// The link card comes first until a Run is linked; the Module's own attention items follow; then the
// one-sentence answer about the recommended option.
import { simulationNow } from './edit-forms.ts'
import { sizeBand, sizeRefusalWords } from '../plan/summary.ts'
import type { Robust } from '../plan/schema.ts'
import { hoursText, quantityText, sourceMark, type Mark } from './format.ts'
import { planOptions, type AttentionKind, type OptionView, type PlanModel } from './model.ts'
import { outcomes, stoppedEarly } from './outcome.ts'
import { goalResult, statusView, type Context } from './status-text.ts'

export type CardAction = 'open-workspace' | 'link-run' | 'refresh' | 'add-work' | 'generate' | 'why-finish' | 'why-recommended' | 'align-window'

export interface Card {
  readonly mark: Mark
  readonly title: string
  readonly text: string
  readonly steps: readonly string[]
  readonly actions: readonly CardAction[]
}

const kindMarks: Readonly<Record<AttentionKind, Mark>> = {
  refusal: { shape: '✕', word: 'Refused' },
  'not-ready': { shape: '?', word: 'Not ready' },
  decision: { shape: '⚑', word: 'Decision' },
  stale: { shape: '↻', word: 'Out of date' },
  world: sourceMark({ by: 'world' }),
  rule: { shape: '■', word: 'Rule' },
  limit: { shape: '▲', word: 'Limit' },
  warning: { shape: '!', word: 'Warning' },
}
const kindOrder: readonly AttentionKind[] = ['refusal', 'not-ready', 'decision', 'stale', 'world', 'rule', 'limit', 'warning']

/**
 * Whether the linked simulation's time is outside the plan window, by the Module's own rule: at or after
 * the window's end, or before its start and more than a day before the plan's "now" (or the wall clock
 * when the plan has no "now"). A simulation at "now", days before the window, is planning ahead.
 */
export const simulationOutsideWindow = (inputs: PlanModel['inputs'], wallNowMs: number): string | null => {
  const sim = inputs.settings.run === null ? null : simulationNow(inputs)
  const window = inputs.settings.window
  if (sim === null || window === null) return null
  const at = Date.parse(sim)
  const now = inputs.settings.dataDate === null ? wallNowMs : Date.parse(inputs.settings.dataDate)
  return at >= Date.parse(window.end) || (at < Date.parse(window.start) && at < now - 86_400_000) ? sim : null
}

/** The window's length, how far past its end the checker continues the calendars: "5 days", or hours. */
const windowLength = (context: Context): string => {
  const window = context.inputs.settings.window
  if (window === null) return 'the window\'s length'
  const days = (Date.parse(window.end) - Date.parse(window.start)) / 86_400_000
  return Number.isInteger(days) ? `${days} ${days === 1 ? 'day' : 'days'}` : hoursText(days * 24)
}

/**
 * The pessimistic card (design §4.2, S4): the option's own schedule re-timed with every job with an estimate
 * range at its high estimate, then each alone, in the same order with the same crews and nothing earlier, and
 * checked. It says whether every hard rule still holds and, where one breaks, which rule, at which job and by
 * how much; or which job could not be done, the crew with no slot long enough left and from when: the checker's
 * own figures. When the checker names no such crew, nothing is stored and the card claims nothing. It claims
 * nothing about a schedule searched again at those estimates.
 */
export const pessimisticCard = (option: OptionView, context: Context): Card | null => {
  const field = option.robust
  if (field === undefined || !option.fresh || option.status.word !== 'validated feasible') return null
  // The time ran out before the re-timings could be made: said so, never a card that is silently missing.
  if ('notWorkedOut' in field) {
    return {
      mark: { shape: '?', word: 'Pessimistic estimates' },
      title: `For ${option.label}, the pessimistic estimates were not worked out: the time ran out.`,
      text: 'Nothing is said about how this option holds at the high estimates.', steps: [], actions: [],
    }
  }
  const robust = field
  const { names, format } = context
  // The first thing the re-timed schedule breaks: a hard rule, by how much, or the window, by when.
  const breaks = (outcome: Robust['allPessimistic']): string | null => {
    if (outcome.holds) return null
    if ('window' in outcome) return `${names.job(outcome.job)} would run past the window end, to ${format.when(outcome.window.by)}`
    // Lane K's words (fix round F3): the job, the crew or tool with no slot long enough left, from when, and
    // how far past the window the checker looked: the window's own length.
    if ('unplaced' in outcome) return `${names.job(outcome.unplaced.job)} could not be done: ${names.resource(outcome.unplaced.resource)} has no slot long enough left after ${format.when(outcome.unplaced.after)}, within ${windowLength(context)} after the window`
    return `${names.job(outcome.job)} breaks “${names.rule(outcome.rule)}” by ${quantityText(outcome.by.value, outcome.by.unit)}`
  }
  const together = breaks(robust.allPessimistic)
  const alone = robust.single.flatMap(entry => {
    const text = breaks(entry.outcome)
    return text === null ? [] : [`${names.job(entry.job)} alone at its high estimate: ${text}.`]
  })
  const holding = robust.single.length - alone.length
  const how = 'Re-timed in the same order with the same crews, nothing earlier, and checked. A plan made again at those estimates may do better.'
  if (together === null && alone.length === 0) {
    return {
      mark: { shape: '✓', word: 'Pessimistic estimates' },
      title: `At every high estimate, ${option.label} still keeps every hard rule and fits the window.`,
      text: how, steps: [], actions: [],
    }
  }
  return {
    mark: { shape: '!', word: 'Pessimistic estimates' },
    title: together === null
      ? `With every job with an estimate range at its high estimate together, ${option.label} still holds; some alone do not.`
      : `With every job with an estimate range at its high estimate, ${option.label} does not hold: ${together}.`,
    text: how,
    steps: [...alone, ...holding > 0 && alone.length > 0 ? [holding === 1 ? 'The other job with an estimate range holds alone at its high estimate.' : `The other ${holding} jobs with an estimate range each hold alone at their high estimate.`] : []],
    actions: [],
  }
}

export const attentionCards = (model: PlanModel, context: Context, wallNowMs: number = Date.now()): readonly Card[] => {
  const { inputs } = model
  const cards: Card[] = []
  const scenario = inputs.settings.scenario
  if (inputs.settings.run === null) {
    cards.push({
      mark: { shape: '◉', word: 'Link World' },
      title: scenario === undefined
        ? 'Start a simulation in World, then link it here to pick equipment, crews or vehicles from it.'
        : `Start the “${scenario.title}” simulation in World, then link it here.`,
      text: 'Planning reads World values; it never starts, pauses or changes a simulation. Until one is linked, World values show as not read yet.',
      steps: [
        scenario === undefined ? 'Open the Workspace and start a simulation.' : `Open the Workspace and start “${scenario.title}” from its card.`,
        'Come back here and choose Link the running simulation.',
        'Read the World values.',
      ],
      actions: ['open-workspace', 'link-run'],
    })
  } else if (inputs.world.refreshedAt === null) {
    cards.push({
      mark: { shape: '◉', word: 'Read World' },
      title: 'Read the World values for this plan.',
      text: 'The simulation is linked. Reading copies its current values into the plan, each with its basis and read time.',
      steps: [], actions: ['refresh'],
    })
  }
  // The linked simulation's time against the plan window: times on the plan and in World must match.
  const now = simulationOutsideWindow(inputs, wallNowMs)
  const window = inputs.settings.window
  if (now !== null && window !== null) {
    cards.push({
      mark: { shape: '◉', word: 'World' },
      title: `The linked simulation is at ${context.format.when(now)} (simulation time), outside this plan's window, ${context.format.when(window.start)} to ${context.format.when(window.end)}.`,
      text: 'Align the window to the simulation, keeping its length, so the plan and World speak of the same days.',
      steps: [], actions: ['align-window'],
    })
  }
  if (inputs.jobs.length === 0) {
    cards.push({
      mark: { shape: '+', word: 'Start' },
      title: 'Add the work.',
      text: 'Pick equipment, add jobs with their hours and crew, a crew with its shifts, links between jobs and the rules that must hold. Every change is checked before it is saved.',
      steps: [], actions: ['add-work'],
    })
  }
  const size = model.certifiedSize
  if (size !== null && sizeBand(inputs, size) === 'refused') {
    cards.push({
      mark: kindMarks.refusal,
      title: 'Too large for the certified size.',
      text: sizeRefusalWords(size, inputs),
      steps: [], actions: [],
    })
  }
  const items = [...model.attention].sort((left, right) => kindOrder.indexOf(left.kind) - kindOrder.indexOf(right.kind))
  for (const item of items) cards.push({ mark: kindMarks[item.kind], title: item.text, text: '', steps: [], actions: [] })

  // Every current option that is not validated feasible says why, here, not only in the Options view.
  for (const outcome of outcomes(model, context).filter(item => item.word !== 'validated feasible')) {
    // A refused option's cause is said in the options table and, in full, in its detail: not a third time here.
    cards.push({ mark: outcome.mark, title: `${outcome.label}: ${outcome.word}.`, text: outcome.word === 'proven infeasible' ? 'Not possible. The options table says why.' : outcome.cause, steps: [], actions: [] })
  }
  const early = planOptions(model).filter(option => option.fresh).map(stoppedEarly).find(reason => reason !== null)
  if (early !== undefined) {
    cards.push({ mark: { shape: '!', word: 'Stopped early' }, title: `The search stopped early, ${early}.`, text: 'The options shown may not be the best possible. Generate again.', steps: [], actions: ['generate'] })
  }
  const recommended = model.options?.items.find(option => option.key === model.options?.recommended)
  // A stale option gets no card here: the Module sends the one stale item (maint's walk 3, R2-4-03).
  if (recommended !== undefined && recommended.fresh) {
    const view = statusView(recommended.status, context)
    const first = view.goals[0]
    const warnings = recommended.warnings.map(warning => warning.text)
    cards.push({
      mark: view.mark,
      title: recommended.fresh
        ? `${recommended.label}: ${view.word}.`
        : `${recommended.label} was made before the latest change; generate again for a current status.`,
      text: recommended.fresh && first !== undefined
        ? `${first.name}: ${goalResult(first)}.`
        : recommended.fresh ? `${view.sentence} ${view.details.join(' ')}`.trim() : '',
      steps: warnings,
      actions: recommended.fresh && recommended.status.word === 'validated feasible' ? ['why-finish', 'why-recommended'] : ['generate'],
    })
    const pessimistic = pessimisticCard(recommended, context)
    if (pessimistic !== null) cards.push(pessimistic)
  } else if (inputs.jobs.length > 0 && model.options === null) {
    cards.push({ mark: { shape: '▶', word: 'Generate' }, title: 'No plan has been generated yet.', text: 'Generate makes dated options from the jobs, crews and rules, and says how good each one is.', steps: [], actions: ['generate'] })
  }
  return cards
}
