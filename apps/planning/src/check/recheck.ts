// Re-check of a stored option against the current plan. Proof words are reused only when the option was
// computed on the plan's current inputs revision and the current formulation, and the checker (and, for a
// refusal, the certificate re-verification) agrees today.
import type { Plan } from '../plan/schema.ts'
import { checkPlan, type CheckResult } from './check.ts'
import { verifyCertificate, type CertificateCheck } from './certificate.ts'

type Option = Plan['options'] extends infer Set ? Set extends { options: ReadonlyArray<infer Item> } ? Item : never : never

export type StaleReason = 'inputs-changed' | 'formulation-changed' | 'violations' | 'invalid-input' | 'certificate' | 'certificate-unverified'

export interface Recheck {
  /** The stored status may be shown with its proof words. */
  readonly usable: boolean
  /** Only a usable, validated feasible option may become a baseline. */
  readonly baselineAllowed: boolean
  readonly reasons: readonly StaleReason[]
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
  const usable = reasons.length === 0
  const shownAs = check.invalidInput && (status.word === 'validated feasible' || status.word === 'proven infeasible') ? 'invalid input' as const
    : reasons.includes('certificate') || reasons.includes('certificate-unverified') ? 'unresolved' as const : undefined
  return { usable, baselineAllowed: usable && status.word === 'validated feasible', reasons, ...(shownAs === undefined ? {} : { shownAs }), check, ...(certificate === undefined ? {} : { certificate }) }
}
