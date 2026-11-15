// Lane K's checker and re-verifications behind lane S's ports, for the two places that compose a solve:
// the service (api/wiring.ts) and the solver child (child.ts). Lane K's code is used as it is.
import { checkPlan } from '../check/check.ts'
import { verifyCertificate } from '../check/certificate.ts'
import { verifyBound } from '../check/optimal.ts'
import { judgeRetiming } from '../check/retime.ts'
import type { JudgeRetimed } from './retime.ts'
import type { CheckPlan, VerifyBound, VerifyCertificate } from './status.ts'

/**
 * Lane K's checker in the shape lane S's Generate asks for: violations, the raw goal values, and the measures
 * Generate reads beside them ('bought:<purchase>', the person-hours or periods used; 'span:<group>').
 */
export const checkForSolver: CheckPlan = ({ inputs, variant, rows }) => {
  const result = checkPlan(inputs, variant, rows)
  return {
    violations: result.violations.map(violation => ({ code: violation.code, about: violation.about })),
    goals: result.goals.map(goal => goal.metric === 'span-over' ? goal.spans.map(span => span.value) : goal.value),
    spanGroups: result.goals.map(goal => (goal.metric === 'span-over' ? goal.spans.map(span => span.group) : undefined)),
    metrics: result.metrics.filter(metric => metric.id.startsWith('bought:') || metric.id.startsWith('span:') || metric.id === 'extra-cost'),
  }
}
export const verifyForSolver: VerifyCertificate = (inputs, variant, cause) => verifyCertificate(inputs, variant, cause)
export const verifyBoundForSolver: VerifyBound = (inputs, variant, goal, bound) => verifyBound(inputs, variant, goal, bound)
/** Lane K's judgement of a pessimistic re-timing (check/retime.ts). */
export const judgeRetimedForSolver: JudgeRetimed = ({ inputs, variant, planned, retimed, high }) => judgeRetiming(inputs, variant, planned, retimed, high)
