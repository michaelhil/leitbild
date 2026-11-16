// Option keys and the purchase and method rules they rest on: what a request asks, as plain data. No solver
// runs here and nothing heavy is imported, so the plan screen builds the ladder's requests from it too
// (solve/ladder.ts). compile.ts and generate.ts read these rules from here.
import type { PlanInputs } from '../plan/schema.ts'
import { timeUnitMs } from '../time/units.ts'
import type { Buy, CompileIndex, MethodPick } from './compile.ts'
import type { AlsoRule, WhatIf } from './generate.ts'

/** The planner's name for a method combination: its options' labels, joined (empty without a method choice). */
export const methodLabel = (inputs: PlanInputs, combo: readonly MethodPick[]): string =>
  combo.map(pick => inputs.methods.find(choice => choice.key === pick.choice)?.options.find(option => option.key === pick.option)?.label ?? pick.option).join(', ')

/** Every combination of method options, each a full pick list; `fixed` narrows the choices. */
export const methodCombinations = (inputs: PlanInputs, fixed: readonly MethodPick[] = []): MethodPick[][] =>
  inputs.methods.reduce<MethodPick[][]>((combos, choice) => {
    const pinned = fixed.find(pick => pick.choice === choice.key)
    const options = pinned === undefined ? choice.options.map(option => option.key) : [pinned.option]
    return combos.flatMap(combo => options.map(option => [...combo, { choice: choice.key, option }]))
  }, [[]])

/**
 * Whether a sub-solve may use a purchase: unordered past its order deadline at the data date, never; under
 * "days only", never one that adds crew time without replacing booked time (even when ordered); an ordered one
 * always otherwise; else as `buy` says. The one rule, for compile and for an option's key.
 */
export const purchaseStanding = (purchase: PlanInputs['purchases'][number], resource: PlanInputs['resources'][number], buy: Buy, dataDate: number | undefined):
  { readonly ok: true } | { readonly ok: false; readonly code: CompileIndex['dropped'][number]['code'] } => {
  if (purchase.ordered === undefined && purchase.orderBy !== undefined && dataDate !== undefined && dataDate > Date.parse(purchase.orderBy)) return { ok: false, code: 'order_deadline_passed' }
  const addsCrewHours = resource.kind === 'crew' && purchase.replaces.length === 0
  if (buy === 'no-extra-crew-hours' && addsCrewHours) return { ok: false, code: 'adds_crew_hours' }
  if (purchase.ordered !== undefined) return { ok: true }
  const permitted = buy === 'allowed' ? purchase.allowed : buy === 'none' ? false : buy === 'no-extra-crew-hours' ? true : buy.includes(purchase.key)
  return permitted ? { ok: true } : { ok: false, code: 'not_in_variant' }
}

/**
 * The inputs a what-if is compiled on: the plan's rules with its extra rules (option.variant.also) after
 * them, never replacing one. Compile reads only these inputs; lane K reads `variant.also` itself.
 */
export const withExtraRules = (inputs: PlanInputs, also: ReadonlyArray<PlanInputs['rules'][number]> | undefined): PlanInputs =>
  also === undefined || also.length === 0 ? inputs : { ...inputs, rules: [...inputs.rules, ...also] }

/** The purchase keys a sub-solve under `buy` may use (purchaseStanding), in plan order. */
export const permittedPurchases = (inputs: PlanInputs, buy: Buy): string[] => {
  const dataDate = inputs.settings.dataDate === null ? undefined : Date.parse(inputs.settings.dataDate)
  return inputs.purchases.flatMap(purchase => {
    const resource = inputs.resources.find(candidate => candidate.key === purchase.resource)
    return resource !== undefined && purchaseStanding(purchase, resource, buy, dataDate).ok ? [purchase.key] : []
  })
}


const slug = (text: string): string => text.normalize('NFKD').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[^A-Za-z0-9]+/, '').slice(0, 64).replace(/-+$/, '') || 'option'

/** FNV-1a over the text, 32 bits as 8 hex digits: the same short name in every process. */
const digest = (text: string): string => {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193) >>> 0
  return hash.toString(16).padStart(8, '0')
}
/** What an extra rule asks, without its key, words or source: two rules that ask the same are one what-if. */
const ruleContent = (rule: AlsoRule) => (rule.kind === 'span-limit'
  ? { kind: rule.kind, group: rule.group, limitMs: rule.limit.value * timeUnitMs[rule.limit.unit], singleEntry: rule.singleEntry }
  : { kind: rule.kind, job: rule.job, finishBy: Date.parse(rule.finishBy) })

/**
 * An option's key (design §4.1): a function of its method picks (as asked, in the plan's method order), the
 * purchases it may use, its extra rule and its lead. The plain options (every allowed purchase, no rule, no
 * lead) keep their method key, so the default options are the top rung; anything else adds a digest of what
 * it asks. The same what-if asked again has the same key and replaces itself. At most 49 characters, so the
 * service's set suffix fits.
 */
export const optionKey = (inputs: PlanInputs, variant: WhatIf & { readonly methods: readonly MethodPick[] }): string => {
  const picks = inputs.methods.flatMap(choice => variant.methods.filter(pick => pick.choice === choice.key).map(pick => pick.option))
  const base = slug(picks.join('+') || 'plan').slice(0, 40).replace(/[-.]+$/, '')
  const permitted = permittedPurchases(inputs, variant.buy).toSorted()
  const standard = permittedPurchases(inputs, 'allowed').toSorted()
  const asked = {
    ...(permitted.join(' ') === standard.join(' ') ? {} : { buy: permitted }),
    ...(variant.also === undefined ? {} : { also: variant.also.map(ruleContent) }),
    ...(variant.lead === undefined ? {} : { lead: variant.lead }),
  }
  return Object.keys(asked).length === 0 ? base : `${base}-${digest(JSON.stringify(asked))}`
}

