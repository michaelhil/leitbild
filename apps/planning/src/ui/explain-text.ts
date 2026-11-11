// "Why it starts then" and "what sets the finish", generated from planning.plan.explain's structure.
import type { z } from 'zod'
import type { explainResultSchema } from '../api/contract.ts'
import { hoursText } from './format.ts'
import { joinWords, type DatedRow } from './model.ts'
import type { Context } from './status-text.ts'

export type ExplainResult = z.infer<typeof explainResultSchema>
export type ExplainItem = ExplainResult['items'][number]
type Because = ExplainItem['because'][number]

const until = (because: Because, context: Context): string => because.until === undefined ? '' : ` until ${context.format.clock(because.until)}`

const at = (because: Because, context: Context): string => because.until === undefined ? 'then' : `at ${context.format.clock(because.until)}`

/** A named thing in an explanation: shown by its name, and a link that selects it. */
export type NameKind = Because['about'][number]['kind']
export type Part = string | { readonly name: string; readonly kind: NameKind; readonly key: string }

/** Parts as plain words, for reading aloud and for tests. */
export const partsText = (parts: readonly Part[]): string => parts.map(part => typeof part === 'string' ? part : part.name).join('')

const joinParts = (named: readonly Part[]): Part[] =>
  named.flatMap((part, index) => index === 0 ? [part] : [index === named.length - 1 ? ' and ' : ', ', part])

/**
 * One cause in words. Every name in `about` says what it names (a job, a crew, a rule…), and is shown by that
 * thing's name only: a crew or tool cause names the resource and the jobs holding it; a shift cause names
 * the resources off duty. Each name is a part the screen turns into a link.
 */
export const causeParts = (because: Because, context: Context): readonly Part[] => {
  const { names } = context
  const of = (kinds: readonly NameKind[]) => because.about.filter(entry => kinds.includes(entry.kind))
  const said = (entries: Because['about']): Part[] => joinParts(entries.map(entry => ({ name: names[entry.kind](entry.key), kind: entry.kind, key: entry.key })))
  // A rule is named in quote marks that belong to the link, so the marks never sit apart from its words.
  const quoted = (entries: Because['about']): Part[] => joinParts(entries.map(entry => ({ name: `“${names[entry.kind](entry.key)}”`, kind: entry.kind, key: entry.key })))
  const holders = of(['job'])
  const holding: Part[] = holders.length === 0 ? [] : [' with ', ...said(holders)]
  const time = until(because, context)
  switch (because.kind) {
    case 'link': return ['it follows ', ...said(because.about), time]
    case 'crew': return [...said(of(['resource'])), of(['resource']).length === 1 ? ' is busy' : ' are busy', ...holding, time]
    case 'tool': return [...said(of(['resource'])), of(['resource']).length === 1 ? ' is in use' : ' are in use', ...holding, time]
    case 'shift': {
      const calendars = of(['calendar']), crews = of(['resource'])
      return calendars.length > 0
        ? ['no working time on ', ...said(calendars), ...crews.length > 0 ? [' for ', ...said(crews)] : [], time]
        : ['no working time for ', ...said(crews), time]
    }
    case 'availability': return ['starting earlier would break ', ...quoted(because.about)]
    case 'span-limit': return ['starting earlier would stretch the outage past ', ...quoted(because.about)]
    case 'window': return [`the window opens ${at(because, context)}`]
    case 'release': return [`it cannot start before ${at(because, context)}`]
    case 'lock': return ['you fixed its start']
    case 'data-date': return [`nothing starts before the plan's "now", ${at(because, context)}`]
    case 'late-as-possible': return ['it is placed as late as its successors allow, to keep equipment in service']
    case 'purchase-not-allowed': return [...said(because.about), because.about.length === 1 ? ' is not allowed' : ' are not allowed']
  }
}

export const causeText = (because: Because, context: Context): string => partsText(causeParts(because, context))

const dueText = (rule: string, context: Context): string => {
  const due = context.inputs.rules.find(item => item.key === rule)
  return due?.kind === 'due' ? `due ${context.format.clock(due.finishBy)}` : 'a due time no longer in this plan'
}

/** Float with what limits it. Float counts logic and calendars only, and the screen says so. */
export const floatText = (float: DatedRow['float'] | { readonly workingHours: number; readonly limitedBy?: undefined }, context: Context): string => {
  const limit = float.limitedBy === undefined || float.limitedBy.kind === 'window-end'
    ? 'the window end'
    : float.limitedBy.kind === 'due' ? dueText(float.limitedBy.rule, context) : `“${context.names.rule(float.limitedBy.rule)}”`
  return `Float ${hoursText(float.workingHours)}, limited by: ${limit} (crew availability is not counted)`
}

export interface WhyStart {
  readonly job: string
  readonly when: string
  /** "It starts then because …", in parts whose names are links. */
  readonly parts: readonly Part[]
  readonly sentence: string
  readonly causes: readonly string[]
  /** All causes bind together: easing one alone does not move the job. */
  readonly joint: boolean
  readonly float: string
}

const causeList = (item: ExplainItem, context: Context): Part[] =>
  item.because.flatMap((because, index) => [...index === 0 ? [] : ['; '], ...causeParts(because, context)])

export const whyStart = (item: ExplainItem, context: Context, row?: DatedRow): WhyStart => {
  const joint = item.joint && item.because.length > 1
  const parts: Part[] = [joint ? 'It starts then because all of these hold at once (easing only one does not move it): ' : 'It starts then because ', ...causeList(item, context), '.']
  return {
    job: context.names.job(item.job), when: context.format.range(item.start, item.finish), parts, sentence: partsText(parts),
    causes: item.because.map(because => causeText(because, context)), joint,
    float: floatText(row?.float ?? { workingHours: item.floatHours }, context),
  }
}

export interface FinishStep {
  readonly job: string
  readonly jobKey: string
  readonly when: string
  readonly because: string
  readonly becauseParts: readonly Part[]
  /** The job's hard due time, a rule: "Due Thu 15:00: …". */
  readonly due: string | null
}

/** The chain that sets the finish, last job first as explain returns it. */
export const finishChain = (result: ExplainResult, context: Context): readonly FinishStep[] =>
  result.items.map(item => {
    const becauseParts: Part[] = [...item.joint && item.because.length > 1 ? ['Together: '] : [], ...causeList(item, context)]
    const due = context.inputs.rules.find(rule => rule.kind === 'due' && rule.job === item.job)
    return {
      job: context.names.job(item.job), jobKey: item.job, when: context.format.range(item.start, item.finish),
      because: partsText(becauseParts), becauseParts,
      due: due?.kind === 'due' ? `Due ${context.format.clock(due.finishBy)}: ${due.words}` : null,
    }
  })

/**
 * The one line on what limits the finish most. With lane S's `limiting` (one more unit of that resource,
 * decoded in the option's own order and checked by lane K), it names the resource and the hours it gains.
 * Without it, it says what the finish waits for: the first cause along the chain that is not just a link,
 * and that one more crew alone does not bring it earlier in this plan (never that it could not in any plan).
 */
export const mostLimiting = (result: ExplainResult, context: Context): { readonly parts: readonly Part[] } | null => {
  if (result.limiting !== undefined) {
    const { key } = result.limiting.about
    const name = { name: context.names.resource(key), kind: 'resource' as const, key }
    return { parts: ['Most limiting: ', name, '. One more ', name, ` would allow a finish at least ${hoursText(result.limiting.hoursEarlier)} earlier.`] }
  }
  for (const item of result.items) {
    const binding = item.because.find(because => because.kind !== 'link')
    if (binding === undefined) continue
    return { parts: [
      'Most limiting: the finish waits on ', { name: context.names.job(item.job), kind: 'job', key: item.job }, ': ',
      ...causeParts(binding, context), '; one more crew alone does not bring it earlier in this plan.',
    ] }
  }
  return null
}
