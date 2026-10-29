import { z } from 'zod'
import { procedureControlStateSchema, type ProcedureControlState } from '../../core/model/index.ts'

export const procedureRunsListInputSchema = z.object({
  includeEvidence: z.boolean().default(false).describe('Include complete recorded criterion proofs, cited readings and observations. False lists placekeeping, decision metadata and latest watch status without recorded measurement proof; true retrieves the retained full evidence.'),
}).strict()

export const procedureRunsListResultSchema = procedureControlStateSchema.extend({
  evidenceIncluded: z.boolean(),
}).strict()

/** Query projection only. The canonical Run, journal and procedure UI retain complete evidence. */
export const projectProcedureRuns = (state: ProcedureControlState, includeEvidence: boolean) => procedureRunsListResultSchema.parse({
  runs: includeEvidence ? state.runs : state.runs.map(run => {
    const { observations, ...placekeeping } = run
    return { ...placekeeping, ...(observations === undefined ? {} : { observations: observations.map(observation => ({
      stepId: observation.stepId, simulationTime: observation.simulationTime,
      result: { status: observation.result.status, ...(observation.result.reason === undefined ? {} : { reason: observation.result.reason }) },
    })) }), stepStates: run.stepStates.map(step => {
      if (step.decision === undefined) return step
      const { criterion: _criterion, evidence: _evidence, ...decision } = step.decision
      return { ...step, decision }
    }) }
  }),
  evidenceIncluded: includeEvidence,
})
