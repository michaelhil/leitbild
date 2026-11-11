// Lane K's checker and re-verifications behind lane S's ports, for the two places that compose a solve:
// the service (api/wiring.ts) and the solver child (child.ts). Lane K's code is used as it is.
import { checkPlan } from '../check/check.ts'
import { verifyCertificate } from '../check/certificate.ts'
import { verifyBound } from '../check/optimal.ts'
import type { CheckPlan, VerifyBound, VerifyCertificate } from './status.ts'

/** Lane K's checker in the shape lane S's Generate asks for: violations and the raw goal values. */
export const checkForSolver: CheckPlan = ({ inputs, variant, rows }) => {
  const result = checkPlan(inputs, variant, rows)
  return {
    violations: result.violations.map(violation => ({ code: violation.code, about: violation.about })),
    goals: result.goals.map(goal => goal.metric === 'span-over' ? goal.spans.map(span => span.value) : goal.value),
  }
}
export const verifyForSolver: VerifyCertificate = (inputs, variant, cause) => verifyCertificate(inputs, variant, cause)
export const verifyBoundForSolver: VerifyBound = (inputs, variant, goal, bound) => verifyBound(inputs, variant, goal, bound)
