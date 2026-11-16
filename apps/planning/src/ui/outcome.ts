// What the latest Generate found, said where the planner looks first: the banner and the attention column.
// A refused option says its cause in hours, from the Module's refusal (explain, ask refusal), never only
// "none is validated feasible".
import { hoursNumber, hoursText, type Mark } from './format.ts'
import { joinWords, planOptions, type OptionView, type PlanModel } from './model.ts'
import { certificateText, goalResult, statusView, stopWords, type Context } from './status-text.ts'

export interface Outcome {
  readonly key: string
  readonly label: string
  readonly mark: Mark
  /** The status word, exactly as the status schema has it. */
  readonly word: string
  /** One line: the first goal for a feasible option, the proof's cause for a refused one. */
  readonly cause: string
  readonly recommended: boolean
}

/**
 * The refusal's opening sentences, without its "Not possible:" lead: the rule or the work, and the hours.
 * A refusal opens with one or two sentences and then lists its jobs ("- …") under a heading ("…:"); the
 * list is for the explain view, the sentences belong where the planner looks first. For a span limit the
 * hours are in the second sentence ("The shortest span this plan allows is 80.5 h, against 72 h …").
 */
const opening = (lines: readonly string[] | undefined): readonly string[] => {
  const sentences: string[] = []
  for (const line of (lines ?? []).map(entry => entry.trim()).filter(entry => entry !== '')) {
    if (line.startsWith('- ') || line.endsWith(':') || sentences.length === 2) break
    sentences.push(line.replace(/^Not possible:\s*/, ''))
  }
  return sentences
}
const lead = (lines: readonly string[] | undefined): string | null => opening(lines).length === 0 ? null : opening(lines).join(' ')

/**
 * The refusal in one line, the one that carries its hours: the last of its opening sentences ("The shortest
 * span this plan allows is 80.5 h, against 72 h: …", or "6 jobs … need 37 h of work, but … only 32 h.").
 */
export const refusalLine = (lines: readonly string[] | undefined): string | null => opening(lines).at(-1) ?? null

export interface ProofStep { readonly name: string; readonly detail: string; /** The job this step names, when exactly one job has that title. */ readonly job: string | null }
export interface ProofPart { readonly text: string | null; readonly steps: readonly ProofStep[] }
export interface RefusalProof { readonly headline: string; readonly parts: readonly ProofPart[] }

/**
 * A refusal as a list: "Not possible: …" with its hours first, then what the Module said, each list of jobs
 * as rows of a name and its times. The words are the Module's; only their form is the screen's.
 */
export const refusalProof = (lines: readonly string[] | undefined, context: Context): RefusalProof | null => {
  const line = refusalLine(lines)
  if (line === null) return null
  return { headline: `Not possible: ${line}`, parts: proofParts(lines ?? [], context, line) }
}

/**
 * The Module's refusal lines in order, each list of jobs as rows of a name and its times; `without` is a line
 * said elsewhere (the headline). "Why not possible" shows a what-if's chain this way, in the Module's order.
 */
export const proofParts = (lines: readonly string[], context: Context, without: string | null = null): readonly ProofPart[] => {
  const parts: Array<{ text: string | null; steps: ProofStep[] }> = []
  for (const entry of lines.map(item => item.trim().replace(/^Not possible:\s*/, '')).filter(item => item !== '' && item !== without)) {
    if (!entry.startsWith('- ')) { parts.push({ text: entry, steps: [] }); continue }
    const cut = entry.lastIndexOf(': ')
    const name = cut === -1 ? entry.slice(2) : entry.slice(2, cut)
    const named = context.inputs.jobs.filter(job => job.title === name)
    const last = parts.at(-1) ?? parts[parts.push({ text: null, steps: [] }) - 1]!
    last.steps.push({ name, detail: cut === -1 ? '' : entry.slice(cut + 2), job: named.length === 1 ? named[0]!.key : null })
  }
  return parts
}

export const outcomeOf = (option: OptionView, model: PlanModel, context: Context): Outcome => {
  const view = statusView(option.status, context)
  const recommended = option.key === model.options?.recommended
  const first = view.goals[0]
  const cause = option.status.word === 'proven infeasible'
    ? lead(model.refusals[option.key]) ?? certificateText(option.status.cause, context)
    : first !== undefined ? `${first.name}: ${goalResult(first)}` : [view.sentence, view.details[0]].filter(part => part !== undefined).join(' ')
  return { key: option.key, label: option.label, mark: view.mark, word: view.word, cause, recommended }
}

/** How an option's search stopped before it finished, as stopWords says it, or null when it ran to the end. */
export const stoppedEarly = (option: OptionView): string | null => 'run' in option.status ? stopWords(option.status.run) : null

/**
 * The current plan options that stopped early, by how they stopped, each named: "The search stopped early for
 * Swap in refurbished spare and Rebuild in place, when its time was up." Said in the banner, once, in
 * agreement with each option's own line (walk V8).
 */
export const stoppedEarlyLines = (model: PlanModel): readonly string[] => {
  const byReason = new Map<string, string[]>()
  for (const option of planOptions(model).filter(item => item.fresh)) {
    const reason = stoppedEarly(option)
    if (reason !== null) byReason.set(reason, [...byReason.get(reason) ?? [], option.label])
  }
  return [...byReason].map(([reason, labels]) => `The search stopped early for ${joinWords(labels)}${reason}.`)
}

/**
 * The current options' outcomes; options made before the latest change claim nothing and are left out, and
 * so are what-ifs, which answer on their own cards and never stand for the plan.
 */
export const outcomes = (model: PlanModel, context: Context): readonly Outcome[] =>
  planOptions(model).filter(option => option.fresh).map(option => outcomeOf(option, model, context))

/**
 * A refused option's cause in one short line, for the options table: the proof's own hours where it has them
 * ("37 h of work one after another, only 32 h of working time."), else the Module's sentence that carries the
 * hours, without the detail after its colon ("The shortest span this plan allows is 80.5 h, against 72 h.").
 * The full proof is beside the timeline, once.
 */
export const shortCause = (option: OptionView, model: PlanModel, context: Context): string | null => {
  if (option.status.word !== 'proven infeasible') return null
  const cause = option.status.cause
  if (cause.kind === 'chain') return `${hoursText(cause.workHours)} of work one after another, only ${hoursText(cause.availableHours)} of working time.`
  if (cause.kind === 'energy') return `${hoursNumber(cause.requiredHours)} crew-hours needed, at most ${hoursNumber(cause.availableHours)} exist.`
  const line = refusalLine(model.refusals[option.key])
  if (line === null) return certificateText(cause, context)
  const cut = line.indexOf(': ')
  return cut === -1 ? line : `${line.slice(0, cut)}.`
}

/**
 * The banner under the plan's title: the recommendation, or that there is none and where the reason is.
 * A cause is not repeated here: each is in the options table in one line and in full in the option's detail
 * (`where`: "on the right" when the detail column is beside the work, "below" when the columns stack).
 */
export const outcomeBanner = (model: PlanModel, context: Context, where: 'on the right' | 'below' = 'on the right'): { readonly title: string; readonly lines: readonly string[]; readonly recommended: boolean } | null => {
  const found = outcomes(model, context)
  if (found.length === 0) return null
  const recommended = found.find(outcome => outcome.recommended)
  const title = recommended !== undefined
    ? `Recommended: ${recommended.label}, ${recommended.word}.`
    : found.every(outcome => outcome.word === 'proven infeasible')
      ? `No option can be recommended: ${found.length === 1 ? 'it is' : found.length === 2 ? 'both are' : `all ${found.length} are`} not possible. See why ${where}.`
      : `No option can be recommended: none is validated feasible. See why ${where}.`
  const lines: string[] = []
  // A search that stopped early may have missed a better plan: said where the planner looks first.
  const early = stoppedEarlyLines(model)
  if (early.length > 0) lines.unshift(`${early.join(' ')} ${recommended === undefined ? 'A plan may still exist' : 'The recommended option may not be the best'}. Generate again.`)
  return { title, lines, recommended: recommended !== undefined }
}
