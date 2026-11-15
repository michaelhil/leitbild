// "What overtime buys" (design §4.1, decisions C7 and S1): a ladder of bought crew time, from plan data and
// with no domain word. Crew time is a purchase the planner allows on a crew that replaces nothing (no
// rebooking), not yet ordered and still orderable at the data date. Rung 0 buys none of it; then the crew time
// priced per person-hour; then all of it. A plan with one price form has rungs 0 and 1, one with none only
// rung 0: rungs are numbered in the order offered, from 0 with no gaps. Every rung keeps the allowed
// purchases that add no crew time (rebookings, tool days) and every ordered purchase.
// Each rung is one Generate with its explicit `buy` list and `keep: true`, one what-if per method combination
// (rungRequest), sent by the screen or an Assistant, lowest rung first: each sub-solve then starts from the
// rung below's option, so results never get worse as crew time is added. The top rung's options are the
// default options: the same keys and the methods' own labels. This is the one rung definition (plan/buys.ts
// reads it); it imports nothing heavy, so the screen builds its requests from it.
import type { PlanInputs } from '../plan/schema.ts'
import type { MethodPick } from './compile.ts'
import type { GenerateInput } from './generate.ts'
import { methodCombinations, methodLabel, optionKey } from './keys.ts'

type Purchase = PlanInputs['purchases'][number]

export interface Rung {
  readonly rung: number
  /** The purchases its Generate may use, in plan order. */
  readonly buy: readonly string[]
  /** The crew time it buys: its own and every lower rung's, in plan order. */
  readonly crewTime: readonly string[]
}

const lapsed = (inputs: PlanInputs, purchase: Purchase): boolean =>
  purchase.ordered === undefined && purchase.orderBy !== undefined && inputs.settings.dataDate !== null && Date.parse(inputs.settings.dataDate) > Date.parse(purchase.orderBy)

/** Crew time a rung may buy: allowed, on a crew, replacing nothing, not ordered, still orderable. */
export const isCrewTime = (inputs: PlanInputs, purchase: Purchase): boolean =>
  purchase.allowed && purchase.ordered === undefined && purchase.replaces.length === 0 && !lapsed(inputs, purchase)
  && inputs.resources.find(resource => resource.key === purchase.resource)?.kind === 'crew'

/** The rungs of the plan's ladder, lowest first. */
export const ladderRungs = (inputs: PlanInputs): Rung[] => {
  const always = inputs.purchases.filter(purchase => purchase.ordered !== undefined || (purchase.allowed && !lapsed(inputs, purchase) && !isCrewTime(inputs, purchase)))
  const crew = inputs.purchases.filter(purchase => isCrewTime(inputs, purchase))
  const hourly = crew.filter(purchase => purchase.price.perPersonHour !== undefined)
  const steps = hourly.length > 0 && hourly.length < crew.length ? [hourly, crew] : crew.length > 0 ? [crew] : []
  const rung = (index: number, bought: readonly Purchase[]): Rung => {
    const keys = new Set([...always, ...bought].map(purchase => purchase.key))
    return { rung: index, buy: inputs.purchases.filter(purchase => keys.has(purchase.key)).map(purchase => purchase.key), crewTime: bought.map(purchase => purchase.key) }
  }
  return [rung(0, []), ...steps.map((bought, k) => rung(k + 1, bought))]
}

/** What a rung allows, by what it buys: "days only", or "with" and the purchases' own labels. */
export const rungName = (inputs: PlanInputs, rung: Rung): string =>
  rung.crewTime.length === 0 ? 'days only' : `with ${rung.crewTime.map(key => inputs.purchases.find(purchase => purchase.key === key)!.label).join(', ')}`

/**
 * A rung option's label: on the top rung the method's own label, as the default options have it (the plan's
 * title without a method choice); below it "<method>: <what the rung allows>", e.g. "Swap in refurbished
 * spare: days only".
 */
export const rungLabel = (inputs: PlanInputs, rung: Rung, combo: readonly MethodPick[]): string => {
  const methods = methodLabel(inputs, combo)
  if (rung.rung === ladderRungs(inputs).at(-1)!.rung) return methods === '' ? inputs.settings.title : methods
  const name = rungName(inputs, rung)
  return (methods === '' ? `${name[0]!.toUpperCase()}${name.slice(1)}` : `${methods}: ${name}`).slice(0, 160)
}

/** The Generate request for a rung: one what-if per method combination, its explicit buy list, `keep: true`. */
export const rungRequest = (inputs: PlanInputs, rung: Rung): GenerateInput & { readonly variants: NonNullable<GenerateInput['variants']> } => ({
  variants: methodCombinations(inputs).map(combo => ({ label: rungLabel(inputs, rung, combo), methods: combo.map(pick => ({ ...pick })), buy: [...rung.buy] })),
  keep: true,
})

/** The option keys a rung's Generate produces, one per method combination, in combination order. */
export const rungOptionKeys = (inputs: PlanInputs, rung: Rung): string[] =>
  methodCombinations(inputs).map(combo => optionKey(inputs, { methods: combo, buy: [...rung.buy] }))
