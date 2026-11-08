import type { AccessContext, PlanningSourceBasis, PlanningSourceQualificationResult, PlanningSourceRequest } from '@leitbild/contracts'

/** The implementation calls published owner operations through Host, never World code. */
export type PlanningSourceActivation = 'loaded-only' | 'load-if-needed'
export interface PlanningSourcePort {
  readonly capture: (request: PlanningSourceRequest, access: AccessContext) => Promise<PlanningSourceBasis>
  readonly qualify: (basis: PlanningSourceBasis, access: AccessContext, activation: PlanningSourceActivation) => Promise<PlanningSourceQualificationResult>
}
export type PlanningSources = PlanningSourcePort
