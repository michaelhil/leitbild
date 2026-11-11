// What the screen holds about one plan, assembled from planning.plan.read sections (read-plan.ts).
// Presenters read only this; they never fetch.
import type { z } from 'zod'
import type { OptionWarning, writeResultSchema } from '../api/contract.ts'
import type { Edit } from '../plan/edit-schema.ts'
import type { CertifiedSize, Plan, PlanInputs, Status, optionSchema } from '../plan/schema.ts'

export type { Status }
export type StoredOption = z.infer<typeof optionSchema>
export type DatedRow = StoredOption['rows'][number]
export type Rule = PlanInputs['rules'][number]
export type Job = PlanInputs['jobs'][number]
export type Resource = PlanInputs['resources'][number]
export type Calendar = PlanInputs['calendars'][number]
export type Goal = PlanInputs['goals'][number]
export type Change = Plan['changes'][number]

export type Attention = z.infer<typeof writeResultSchema>['attention'][number]
export type AttentionKind = Attention['kind']

/** An option as the options section lists it: no rows; `fresh` is the Module's re-check on the current inputs. */
export interface OptionView {
  readonly key: string
  readonly label: string
  readonly variant: StoredOption['variant']
  readonly status: Status
  readonly metrics: StoredOption['metrics']
  readonly inputsRevision: number
  readonly fresh: boolean
  readonly warnings: readonly OptionWarning[]
}

/** The plan screen's views. */
export type PlanView = 'schedule' | 'add' | 'rules' | 'crews' | 'equipment' | 'options'

/** A World simulation the person can link: from Host's resource catalogue. `matches` = it runs the plan's Scenario. */
export interface RunChoice { readonly id: string; readonly title: string; readonly status: string; readonly matches: boolean }

export interface PlanModel {
  readonly id: string
  readonly title: string
  readonly revision: number
  readonly updatedAt: string | null
  readonly inputs: PlanInputs
  readonly attention: readonly Attention[]
  readonly certifiedSize: CertifiedSize | null
  readonly options: { readonly at: string; readonly recommended: string | null; readonly items: readonly OptionView[] } | null
  /** Dated rows per option key, read on demand with section `schedule`. */
  readonly rows: Readonly<Record<string, readonly DatedRow[]>>
  readonly history: readonly Change[]
  /** For each proven-infeasible option: the Module's refusal in planner words and hours (explain, ask refusal). */
  readonly refusals: Readonly<Record<string, readonly string[]>>
}

/**
 * Names for plan-local keys. Keys never reach a routine screen: a key that names nothing in the plan
 * reads as "an item no longer in this plan".
 */
export interface Names {
  readonly job: (key: string) => string
  readonly equipment: (key: string) => string
  readonly resource: (key: string) => string
  readonly calendar: (key: string) => string
  readonly group: (key: string) => string
  readonly rule: (key: string) => string
  readonly purchase: (key: string) => string
  readonly any: (key: string) => string
  /** What a key names in this plan, or null when it names nothing. */
  readonly kindOf: (key: string) => 'job' | 'equipment' | 'resource' | 'calendar' | 'group' | 'rule' | 'purchase' | null
  readonly list: (keys: readonly string[], of?: (key: string) => string) => string
}

const gone = 'an item no longer in this plan'

export const joinWords = (words: readonly string[], last: 'and' | 'or' = 'and'): string =>
  words.length <= 1 ? words.join('') : `${words.slice(0, -1).join(', ')} ${last} ${words[words.length - 1]}`

/** Who does a job, from its needs: any one of a need's crews or tools ("or"), every need ("and"). */
export const needsText = (needs: ReadonlyArray<{ readonly anyOf: readonly string[]; readonly amount: number }>, name: (key: string) => string): string =>
  joinWords(needs.map(need => `${need.amount > 1 ? `${need.amount} of ` : ''}${joinWords(need.anyOf.map(name), 'or')}`))

/** Names an edit list gives to keys it creates, so a preview can name what is not saved yet. */
export const namesInEdits = (edits: readonly Edit[]): ReadonlyMap<string, string> => new Map(edits.flatMap((edit): Array<[string, string]> => {
  if (edit.edit === 'job' && edit.title !== undefined) return [[edit.key, edit.title]]
  if ((edit.edit === 'equipment' || edit.edit === 'resource' || edit.edit === 'calendar' || edit.edit === 'purchase' || edit.edit === 'method') && edit.label !== undefined) return [[edit.key, edit.label]]
  if (edit.edit === 'rule' && edit.words !== undefined) return [[edit.key, edit.words]]
  return []
}))

export const createNames = (inputs: PlanInputs, pending: ReadonlyMap<string, string> = new Map()): Names => {
  const table = <T extends { readonly key: string }>(items: readonly T[], name: (item: T) => string): Map<string, string> =>
    new Map(items.map(item => [item.key, name(item)]))
  const jobs = table(inputs.jobs, job => job.title)
  const equipment = table(inputs.equipment, item => item.label)
  const resources = table(inputs.resources, item => item.label)
  const calendars = table(inputs.calendars, item => item.label)
  const groups = table(inputs.groups, item => item.label)
  const rules = table(inputs.rules, rule => rule.words)
  const purchases = table(inputs.purchases, item => item.label)
  const lookup = (map: Map<string, string>) => (key: string): string => map.get(key) ?? pending.get(key) ?? gone
  const any = (key: string): string =>
    jobs.get(key) ?? equipment.get(key) ?? resources.get(key) ?? groups.get(key) ?? purchases.get(key) ?? calendars.get(key) ?? rules.get(key) ?? pending.get(key) ?? gone
  return {
    job: lookup(jobs), equipment: lookup(equipment), resource: lookup(resources), calendar: lookup(calendars),
    group: lookup(groups), rule: lookup(rules), purchase: lookup(purchases), any,
    kindOf: key => jobs.has(key) ? 'job' : equipment.has(key) ? 'equipment' : resources.has(key) ? 'resource' : calendars.has(key) ? 'calendar'
      : groups.has(key) ? 'group' : rules.has(key) ? 'rule' : purchases.has(key) ? 'purchase' : null,
    list: (keys, of = any) => joinWords(keys.map(of)),
  }
}
