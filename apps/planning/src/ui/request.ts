// What a Generate request asked for, in words. The screen names each what-if it asks for with
// requestLabel, and Generate names a default option by its method; so a stored option's label, compared
// exactly with those two forms, says which request made it, also after a reload has reset the controls.
import type { PlanInputs } from '../plan/schema.ts'
import type { OptionView } from './model.ts'

/** The name the screen gives a what-if: its methods, then "days only" when crew-hour purchases are excluded. */
export const requestLabel = (methodLabels: readonly string[], daysOnly: boolean): string =>
  methodLabels.length === 0 ? (daysOnly ? 'Days only' : '') : `${methodLabels.join(', ')}${daysOnly ? ', days only' : ''}`

/** Purchases "days only" excludes: those that add working time to a crew and give up no booked time. */
export const crewHourPurchases = (inputs: PlanInputs): PlanInputs['purchases'] =>
  inputs.purchases.filter(purchase => purchase.replaces.length === 0 && inputs.resources.find(resource => resource.key === purchase.resource)?.kind === 'crew')

/** "Requested: days only; Swap in refurbished spare", or null when the plan offers nothing to choose. */
export const requestText = (option: Pick<OptionView, 'label' | 'variant'>, inputs: PlanInputs): string | null => {
  const methods = option.variant.methods.map(pick => inputs.methods.find(choice => choice.key === pick.choice)?.options.find(entry => entry.key === pick.option)?.label ?? null)
  const labels = methods.filter(label => label !== null)
  const buyable = crewHourPurchases(inputs).length > 0
  if (labels.length !== methods.length) return `Requested as “${option.label}”.`
  if (option.label === requestLabel(labels, true) && (labels.length > 0 || buyable)) return `Requested: days only${labels.length === 0 ? '' : `; ${labels.join(', ')}`}.`
  if (labels.length > 0 && option.label === requestLabel(labels, false)) return `Requested: ${labels.join(', ')}${buyable ? '; overtime and night crews allowed' : ''}.`
  if (labels.length === 0 && option.label === inputs.settings.title) return buyable ? 'Requested: overtime and night crews allowed.' : null
  return `Requested as “${option.label}”.`
}
