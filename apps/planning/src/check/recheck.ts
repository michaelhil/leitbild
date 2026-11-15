// Re-check of a stored option against the current plan. Proof words are reused only when the option was
// computed on the plan's current inputs revision and the current formulation, and the checker (and, for a
// refusal, the certificate re-verification) agrees today. A what-if is re-checked with its extra rule
// (variant.also) and its lead: a group lead's value must be the checker's own `span:<group>` figure.
import { goalResolution, type Plan } from '../plan/schema.ts'
import { checkPlan, type CheckResult } from './check.ts'
import { verifyCertificate, type CertificateCheck } from './certificate.ts'
import { groupLeadFigure, verifyOptimality, type OptimalCheck } from './optimal.ts'

type Option = Plan['options'] extends infer Set ? Set extends { options: ReadonlyArray<infer Item> } ? Item : never : never

/** lead-figure: a group lead's stored value is not the span the checker measures on the option's rows. */
export type StaleReason = 'inputs-changed' | 'formulation-changed' | 'violations' | 'invalid-input' | 'certificate' | 'certificate-unverified' | 'lead-figure'

export interface Recheck {
  /** The stored status may be shown with its proof words. */
  readonly usable: boolean
  /** Only a usable, validated feasible option may become a baseline. */
  readonly baselineAllowed: boolean
  readonly reasons: readonly StaleReason[]
  /**
   * Goals stored as "proven optimal" whose bound the checker could not re-derive, and every later one
   * (goal order, or the lead's rule): show them as "best found under budget". The option itself stays usable.
   */
  readonly bestFoundGoals: readonly number[]
  /** A group lead stored as "proven optimal" that the checker does not confirm, on its bound or its figure. */
  readonly bestFoundLead: boolean
  readonly optimality: readonly OptimalCheck[]
  /** The status word to show when the stored one cannot be: a refusal not re-derived is "unresolved". */
  readonly shownAs?: 'unresolved' | 'invalid input'
  readonly check: CheckResult
  readonly certificate?: CertificateCheck
}

export const recheckOption = (plan: Plan, option: Option, formulation: string): Recheck => {
  const check = checkPlan(plan.inputs, option.variant, option.rows)
  const reasons: StaleReason[] = []
  if (option.inputsRevision !== plan.revision) reasons.push('inputs-changed')
  const status = option.status
  if ('run' in status && status.run.formulation !== formulation) reasons.push('formulation-changed')
  if (status.word === 'validated feasible' && !check.feasible) reasons.push(check.invalidInput ? 'invalid-input' : 'violations')
  let certificate: CertificateCheck | undefined
  if (status.word === 'proven infeasible') {
    certificate = verifyCertificate(plan.inputs, option.variant, status.cause)
    if (!certificate.ok) reasons.push('certificate')
    else if (!certificate.proves) reasons.push('certificate-unverified')   // not a proof; its bound is an explanation
  }
  // A group lead's value is the checker's own span of that group on these rows, at the line's resolution.
  const groupLead = status.word === 'validated feasible' && status.lead !== undefined && 'group' in status.lead ? status.lead : undefined
  const figure = groupLead === undefined || !check.feasible ? undefined : groupLeadFigure(check, groupLead.group, groupLead.unit)
  const figureHolds = groupLead === undefined || !check.feasible
    || (figure !== undefined && Math.abs(groupLead.value - figure) < (goalResolution(groupLead.unit, plan.inputs.settings.grid) ?? 0) / 2)
  if (!figureHolds) reasons.push('lead-figure')
  const optimality = status.word === 'validated feasible' && check.feasible ? verifyOptimality(plan.inputs, option.variant, status) : []
  const bestFoundGoals = optimality.flatMap(entry => 'goal' in entry && !entry.proves ? [entry.goal] : [])
  const bestFoundLead = groupLead?.word === 'proven optimal' && (!figureHolds || !optimality.some(entry => 'group' in entry && entry.proves))
  const usable = reasons.length === 0
  const shownAs = check.invalidInput && (status.word === 'validated feasible' || status.word === 'proven infeasible') ? 'invalid input' as const
    : reasons.includes('certificate') || reasons.includes('certificate-unverified') ? 'unresolved' as const : undefined
  return { usable, baselineAllowed: usable && status.word === 'validated feasible', reasons, bestFoundGoals, bestFoundLead, optimality, ...(shownAs === undefined ? {} : { shownAs }), check, ...(certificate === undefined ? {} : { certificate }) }
}
