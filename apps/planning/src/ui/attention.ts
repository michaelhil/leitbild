// "Needs your attention": the cards the plan screen leads with, in the order a planner acts on them.
// The link card comes first until a Run is linked; the Module's own attention items follow; then the
// one-sentence answer about the recommended option.
import { simulationNow } from './edit-forms.ts'
import { sizeRefusalWords, withinCertifiedSize } from '../plan/summary.ts'
import { sourceMark, type Mark } from './format.ts'
import type { AttentionKind, PlanModel } from './model.ts'
import { outcomes, stoppedEarly } from './outcome.ts'
import { statusView, type Context } from './status-text.ts'

export type CardAction = 'open-workspace' | 'link-run' | 'refresh' | 'add-work' | 'generate' | 'why-finish' | 'align-window'

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
  if (size !== null && !withinCertifiedSize(inputs, size)) {
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
    cards.push({ mark: outcome.mark, title: `${outcome.label}: ${outcome.word}.`, text: outcome.cause, steps: [], actions: [] })
  }
  const early = (model.options?.items ?? []).filter(option => option.fresh).map(stoppedEarly).find(reason => reason !== null)
  if (early !== undefined) {
    cards.push({ mark: { shape: '!', word: 'Stopped early' }, title: `The search stopped early, ${early}.`, text: 'The options shown may not be the best possible. Generate again.', steps: [], actions: ['generate'] })
  }
  const recommended = model.options?.items.find(option => option.key === model.options?.recommended)
  // One card for one stale state: when the Module already says the options are out of date, say nothing more.
  const moduleSaysStale = model.attention.some(item => item.kind === 'stale')
  if (recommended !== undefined && !(moduleSaysStale && !recommended.fresh)) {
    const view = statusView(recommended.status, context)
    const first = view.goals[0]
    const warnings = recommended.warnings.map(warning => warning.text)
    cards.push({
      mark: view.mark,
      title: recommended.fresh
        ? `${recommended.label}: ${view.word}.`
        : `${recommended.label} was made before the latest change; generate again for a current status.`,
      text: recommended.fresh && first !== undefined
        ? `Least ${first.name}: ${first.value}, ${first.mark.word} (${first.distance}).`
        : recommended.fresh ? `${view.sentence} ${view.details.join(' ')}`.trim() : '',
      steps: warnings,
      actions: recommended.fresh && recommended.status.word === 'validated feasible' ? ['why-finish'] : ['generate'],
    })
  } else if (inputs.jobs.length > 0 && model.options === null) {
    cards.push({ mark: { shape: '▶', word: 'Generate' }, title: 'No plan has been generated yet.', text: 'Generate makes dated options from the jobs, crews and rules, and says how good each one is.', steps: [], actions: ['generate'] })
  }
  return cards
}
