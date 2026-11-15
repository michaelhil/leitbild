// "What differs from the earlier set" (design §6.3 `explain versus {previous}`, T12): an option against one of
// the previous option set, kept from before the last Generate on a newer revision. Said from structure only:
// the input changes between the two revisions from the change log's own summaries, the goal values when the
// goals stayed as they were, the method and purchases, and each job that moved, was added or left.
import { clip, goalName, nameOf, names, timeWords, valueWords } from './summary.ts'
import { isTimeUnit, timeUnitMs } from '../time/units.ts'
import type { Plan, PlanInputs } from './schema.ts'
import type { VersusFacts } from '../api/contract.ts'
import { fitLines, listWords } from './why.ts'

type Option = NonNullable<Plan['options']>['options'][number]
type DatedRow = Option['rows'][number]

const capital = (text: string): string => `${text.charAt(0).toUpperCase()}${text.slice(1)}`
const sentence = (text: string): string => text.replace(/[.\s]+$/, '')
const hours = (from: string, to: string): number => (Date.parse(to) - Date.parse(from)) / 3_600_000
const shifted = (value: number, later: string, earlier: string): string => `${valueWords(Math.abs(value), 'h')} ${value > 0 ? later : earlier}`

/** At most this many moved jobs are named; the rest are counted. */
const movedShown = 6

/** The structure the words are generated from: explain's `versus` field (api/contract.ts versusFactsSchema). */
export type { VersusFacts }
/** At most this many input changes are listed in the facts; the history has them all. */
const changesListed = 20

export const versusLines = (input: Parameters<typeof versus>[0]): string[] => versus(input).lines

/**
 * The input changes since revision `from`, from the change log: every raised revision has its entry, unless
 * the history was trimmed (`complete` false), and whether any changed the goals. The plan's goal ids name the
 * same goals as at `from` only when the history is complete and none did (`goalsSame`).
 */
export const changesSince = (plan: Pick<Plan, 'revision' | 'changes'>, from: number) => {
  const changes = plan.changes.filter(change => change.revision > from && change.revision <= plan.revision && change.kinds.length > 0)
  const complete = Array.from({ length: Math.max(0, plan.revision - from) }, (_, index) => from + 1 + index).every(revision => changes.some(change => change.revision === revision))
  const goalsChanged = changes.some(change => change.kinds.includes('goals'))
  return { changes, complete, goalsChanged, goalsSame: complete && !goalsChanged }
}

/** What differs between the two options, in words and as the structure they come from. */
export const versus = (input: {
  readonly inputs: PlanInputs
  /** The option of the current set, fresh on the plan's revision. */
  readonly option: Option
  /** The option of the previous set it is compared with. */
  readonly previous: Option
  readonly plan: Pick<Plan, 'revision' | 'changes' | 'droppedChanges'>
}): { readonly lines: string[]; readonly facts: VersusFacts } => {
  const { inputs, option, previous, plan } = input
  const zone = inputs.settings.timeZone
  const from = previous.inputsRevision, to = plan.revision
  const head = `'${option.label}' against '${previous.label}' of the previous options (revision ${from}; now revision ${to}).`
  const status = option.status.word === previous.status.word ? [] : [`Status: ${option.status.word}, was ${previous.status.word}.`]

  // The input changes between the two: every raised revision has its entry, unless the history was trimmed.
  const { changes, complete, goalsChanged, goalsSame } = changesSince(plan, from)
  const changeLines = [
    ...changes.slice(0, 4).map(change => `Changed since: ${sentence(change.summary)}.`),
    ...(changes.length > 4 ? [`…and ${changes.length - 4} more changes: read the history.`] : []),
    ...(complete ? [] : [`The history no longer holds every change since revision ${from}.`]),
  ]
  const frame = { option: option.key, previous: previous.key, from, to, complete, changes: changes.slice(0, changesListed).map(change => ({ revision: change.revision, summary: change.summary })) }
  const nowStatus = option.status, thenStatus = previous.status
  if (nowStatus.word !== 'validated feasible' || thenStatus.word !== 'validated feasible') {
    return { lines: fitLines([head, ...status, ...changeLines]), facts: { ...frame, methods: [], buys: { added: [], dropped: [] }, moved: [], movedMore: 0, added: [], removed: [] } }
  }
  const goalFacts = goalsSame ? nowStatus.goals.flatMap(goal => {
    const was = thenStatus.goals[goal.goal]
    return was === undefined ? [] : [{ goal: goal.goal, now: goal.value, was: was.value, unit: goal.unit }]
  }) : undefined

  // Goal values, by the plan's goal ids, only when those ids still name the same goals.
  const goalLines = goalsChanged ? ['The goals changed since, so goal values are not compared.']
    : !complete ? ['The goals may have changed since, so goal values are not compared.']
      : [
        ...nowStatus.goals.map((goal, k) => {
          const was = thenStatus.goals[k]
          const name = capital(goalName(inputs, k, true))
          if (was === undefined) return `${name}: ${valueWords(goal.value, goal.unit)}.`
          const difference = goal.value - was.value
          return Math.abs(difference) < 1e-9 ? `${name}: ${valueWords(goal.value, goal.unit)}, unchanged.`
            : `${name}: ${valueWords(goal.value, goal.unit)}, was ${valueWords(was.value, was.unit)} (${valueWords(Math.abs(difference), goal.unit)} ${difference > 0 ? 'more' : 'less'}).`
        }),
      ]
  // The longest outage of each group a span rule names (G5): the checker's stored 'span:<group>' figure, or
  // the outage goal's own stored figure for its group while the goals are as they were. In h.
  const spanGoal = inputs.goals.findIndex(goal => goal.metric === 'span-over')
  const outageOf = (of: Option, group: string): number | undefined => {
    const figure = of.metrics.find(metric => metric.id === `span:${group}`) ?? (goalsSame && spanGoal >= 0 ? of.metrics.find(metric => metric.id === `goal:${spanGoal}:${group}`) : undefined)
    return figure === undefined || !isTimeUnit(figure.unit) ? undefined : figure.value * timeUnitMs[figure.unit] / timeUnitMs.h
  }
  const spanGroups = [...new Set(inputs.rules.flatMap(rule => rule.kind === 'span-limit' ? [rule.group] : []))]
  const outages = spanGroups.flatMap(group => {
    const now = outageOf(option, group), was = outageOf(previous, group)
    return now === undefined || was === undefined ? [] : [{ group, now, was }]
  })
  // In the facts only from the checker's own 'span:<group>' figures, and only when both options store one for
  // every group a span rule names (the contract's outages: one entry per group).
  const spanned = (of: Option) => spanGroups.every(group => of.metrics.some(metric => metric.id === `span:${group}`))
  const outageFacts = spanGroups.length > 0 && spanned(option) && spanned(previous) ? outages : undefined
  const outageLines = outages.map(({ group, now, was }) => Math.abs(now - was) < 1e-9 ? `Longest outage of ${nameOf(inputs, group)}: ${valueWords(now, 'h')}, unchanged.`
    : `Longest outage of ${nameOf(inputs, group)}: ${valueWords(now, 'h')}, was ${valueWords(was, 'h')} (${valueWords(Math.abs(now - was), 'h')} ${now > was ? 'longer' : 'shorter'}).`)

  // The method picked and the purchases used.
  const methodFacts = inputs.methods.flatMap(choice => {
    const pick = (of: Option) => of.variant.methods.find(entry => entry.choice === choice.key)?.option
    const now = pick(option), then = pick(previous)
    return now === undefined || then === undefined || now === then ? [] : [{ choice: choice.key, now, was: then }]
  })
  const methodLines = methodFacts.map(({ choice, now, was }) => {
    const method = inputs.methods.find(entry => entry.key === choice)!
    const label = (key: string) => method.options.find(entry => entry.key === key)?.label ?? key
    return `${method.label}: '${label(now)}', was '${label(was)}'.`
  })
  const added = option.variant.purchases.filter(key => !previous.variant.purchases.includes(key))
  const dropped = previous.variant.purchases.filter(key => !option.variant.purchases.includes(key))
  const purchaseLines = [
    ...(added.length === 0 ? [] : [clip(`Now also buys: ${added.map(key => nameOf(inputs, key)).join(', ')}.`, 240)]),
    ...(dropped.length === 0 ? [] : [clip(`No longer buys: ${dropped.map(key => nameOf(inputs, key)).join(', ')}.`, 240)]),
  ]

  // Jobs: moved (in both, at another start or finish), added, and no longer in it; the largest shifts first.
  const before = new Map(previous.rows.map(row => [row.job, row]))
  const now = new Set(option.rows.map(row => row.job))
  const moved = option.rows.flatMap(row => {
    const was = before.get(row.job)
    return was === undefined || (was.start === row.start && was.finish === row.finish) ? [] : [{ row, was, shift: hours(was.start, row.start) }]
  }).sort((left, right) => Math.abs(right.shift) - Math.abs(left.shift) || left.row.job.localeCompare(right.row.job))
  const joined = option.rows.filter(row => !before.has(row.job)).map(row => row.job)
  const left = previous.rows.filter(row => !now.has(row.job)).map(row => row.job)
  const known = new Set(inputs.jobs.map(job => job.key))
  const movedLine = ({ row, was, shift }: { readonly row: DatedRow; readonly was: DatedRow; readonly shift: number }): string => shift !== 0
    ? `'${nameOf(inputs, row.job)}' starts ${timeWords(row.start, zone)}, was ${timeWords(was.start, zone)} (${shifted(shift, 'later', 'earlier')}).`
    : `'${nameOf(inputs, row.job)}' finishes ${timeWords(row.finish, zone)}, was ${timeWords(was.finish, zone)} (${shifted(hours(was.finish, row.finish), 'later', 'earlier')}).`
  const jobLines = [
    ...(joined.length === 0 ? [] : [`Added: ${names(inputs, joined, 3)}.`]),
    ...(left.length === 0 ? [] : [(() => {
      const named = left.filter(key => known.has(key)), gone = left.length - named.length
      // A job removed from the plan has no name left in it: it is counted, never shown by its key.
      return `No longer in it: ${listWords([...(named.length === 0 ? [] : [names(inputs, named, 3)]), ...(gone === 0 ? [] : [`${gone} job${gone === 1 ? '' : 's'} removed from the plan`])])}.`
    })()]),
  ]
  const fixed = [head, ...status, ...changeLines, ...goalLines, ...outageLines.map(line => clip(line, 240)), ...methodLines, ...purchaseLines]
  const room = Math.max(0, Math.min(movedShown, 20 - fixed.length - jobLines.length - 2))
  const movedLines = moved.length === 0 ? (joined.length === 0 && left.length === 0 ? ['No job moved.'] : [])
    : [`${moved.length} job${moved.length === 1 ? '' : 's'} moved${moved.length === 1 ? ':' : '; the largest shifts first:'}`, ...moved.slice(0, room).map(movedLine), ...(moved.length > room ? [`…and ${moved.length - room} more: read the schedule.`] : [])]
  return {
    lines: fitLines([...fixed, ...movedLines, ...jobLines]),
    facts: {
      ...frame, ...(goalFacts === undefined ? {} : { goals: goalFacts }), ...(outageFacts === undefined ? {} : { outages: outageFacts }), methods: methodFacts, buys: { added, dropped },
      moved: moved.slice(0, movedShown).map(({ row, was }) => ({ job: row.job, now: { start: row.start, finish: row.finish }, was: { start: was.start, finish: was.finish } })),
      movedMore: Math.max(0, moved.length - movedShown), added: joined, removed: left,
    },
  }
}
