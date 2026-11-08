import type { AccessContext, PlanningSourceBasis, PlanningSourceQualificationResult, PlanningSourceRequest } from '@leitbild/contracts'

/** The implementation calls published owner operations through Host, never World code. */
export interface PlanningSourcePort {
  readonly capture: (request: PlanningSourceRequest, access: AccessContext) => Promise<PlanningSourceBasis>
  readonly qualify: (basis: PlanningSourceBasis, access: AccessContext) => Promise<PlanningSourceQualificationResult>
}
export type PlanningSources = PlanningSourcePort
