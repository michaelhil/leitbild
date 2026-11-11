// Test support: lane K's REAL checker and certificate re-verification behind lane S's ports, so solver
// tests judge plans and proofs exactly as the product does (no double).
import { checkPlan } from '../../check/check.ts'
import { verifyCertificate } from '../../check/certificate.ts'
import type { CheckPlan, VerifyCertificate } from '../status.ts'

export const laneKCheck: CheckPlan = ({ inputs, variant, rows }) => {
  const result = checkPlan(inputs, variant, rows)
  return {
    violations: result.violations.map(violation => ({ code: violation.code, about: violation.about })),
    goals: result.goals.map(goal => ('spans' in goal ? goal.spans.map(span => span.value) : goal.value)),
  }
}

export const laneKVerify: VerifyCertificate = (inputs, variant, cause) => verifyCertificate(inputs, variant, cause)
