// "What overtime buys" (design §4.1, decisions C7 and S1): a ladder of bought crew time, from plan data and
// with no domain word. Crew time is a purchase the planner allows on a crew that replaces nothing (no
// rebooking), not yet ordered and still orderable at the data date. Rung 0 buys none of it; then the crew time
// priced per person-hour; then all of it. A plan with one price form has rungs 0 and 1, one with none only
// rung 0: rungs are numbered in the order offered, from 0 with no gaps. Every rung keeps the allowed
// purchases that add no crew time (rebookings, tool days) and every ordered purchase.
// Each rung is one Generate with `keep: true` (rungRequest), sent by the screen or an Assistant, lowest rung
// first: one what-if per method combination with the rung's explicit `buy` list, and for the top rung a plain
// kept Generate (the default options, their keys and labels). Each sub-solve starts from the rung below's
// option, so results never get worse as crew time is added. This is the one rung definition (plan/buys.ts
// reads it); it imports nothing heavy, so the screen builds its requests from it, with its own labels.
import type { PlanInputs } from '../plan/schema.ts'
import type { MethodPick } from './compile.ts'
import type { GenerateInput } from './generate.ts'
import { methodCombinations, optionKey } from './keys.ts'

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

/**
 * The Generate request for a rung, `keep: true`. The top rung is a plain kept Generate: the default options,
 * with their keys and the methods' own labels. Below it, one what-if per method combination with the rung's
 * buy list and the label `label` gives it: rung labels are the screen's words, and the solver stores the label
 * it is given.
 */
export const rungRequest = (inputs: PlanInputs, rung: Rung, label: (combo: readonly MethodPick[]) => string): GenerateInput => {
  if (rung.rung === ladderRungs(inputs).at(-1)!.rung) return { keep: true }
  return { variants: methodCombinations(inputs).map(combo => ({ label: label(combo), methods: combo.map(pick => ({ ...pick })), buy: [...rung.buy] })), keep: true }
}

/** The option keys a rung's Generate produces, one per method combination, in combination order. */
export const rungOptionKeys = (inputs: PlanInputs, rung: Rung): string[] =>
  methodCombinations(inputs).map(combo => optionKey(inputs, { methods: combo, buy: [...rung.buy] }))
