// Test support: lane K's REAL checker and certificate re-verification behind lane S's ports, so solver
// tests judge plans and proofs exactly as the product does (no double).
import { checkPlan } from '../../check/check.ts'
import { verifyCertificate } from '../../check/certificate.ts'
import { verifyBound } from '../../check/optimal.ts'
import { judgeRetiming } from '../../check/retime.ts'
import type { JudgeRetimed } from '../retime.ts'
import type { CheckPlan, VerifyBound, VerifyCertificate } from '../status.ts'

export const laneKCheck: CheckPlan = ({ inputs, variant, rows }) => {
  const result = checkPlan(inputs, variant, rows)
  return {
    violations: result.violations.map(violation => ({ code: violation.code, about: violation.about })),
    goals: result.goals.map(goal => ('spans' in goal ? goal.spans.map(span => span.value) : goal.value)),
    metrics: result.metrics.filter(metric => metric.id.startsWith('bought:') || metric.id.startsWith('span:')),
  }
}

export const laneKVerify: VerifyCertificate = (inputs, variant, cause) => verifyCertificate(inputs, variant, cause)
export const laneKVerifyBound: VerifyBound = (inputs, variant, goal, bound) => verifyBound(inputs, variant, goal, bound)
export const laneKJudgeRetimed: JudgeRetimed = ({ inputs, variant, planned, retimed, high }) => judgeRetiming(inputs, variant, planned, retimed, high)
