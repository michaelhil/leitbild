import { z } from 'zod'
import { eventBaseSchema, type SimulationRunEvent } from '../../core/model/events.ts'
import { procedureBranchSelectedEventSchema, procedureRunStateSchema, type ProcedureRunState } from '../../core/model/procedures.ts'

/** One committed selection, independent of later navigation, reset or source publication. */
export const procedureTransitionDecisionSchema = z.object({
  run: procedureRunStateSchema.pick({ runId: true, procedureId: true, sourceId: true, sourceRevision: true, sourcePath: true, scope: true }),
  event: eventBaseSchema.merge(procedureBranchSelectedEventSchema),
}).strict()
export type ProcedureTransitionDecision = z.infer<typeof procedureTransitionDecisionSchema>

export const procedureTransitionDecision = (
  run: ProcedureRunState,
  event: Extract<SimulationRunEvent, { type: 'procedure.branch.selected' }>,
): ProcedureTransitionDecision => {
  if (event.runId !== run.runId) throw new Error('Procedure decision receipt does not match its pinned Run')
  return procedureTransitionDecisionSchema.parse({ run, event })
}
