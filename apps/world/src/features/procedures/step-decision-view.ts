import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import {
  procedureRunIdSchema, procedureStepDecisionSchema,
  type ProcedureRunState, type ProcedureStepDecision, type SimulationRunEvent,
} from '../../core/model/index.ts'
import { procedureDecisionReadInputSchema, retainedProcedureDecision } from './transition-receipt.ts'

/** Immutable journal proof where retained; a copied snapshot can retain only current decision state. */
const decisionProofSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('event'), capabilityId: z.literal('world.procedure.decision.read'), input: procedureDecisionReadInputSchema }).strict(),
  z.object({ kind: z.literal('run-state'), capabilityId: z.literal('world.procedure.runs.list'),
    input: z.object({ includeEvidence: z.literal(true) }).strict(), runId: procedureRunIdSchema, stepId: z.string().min(1), reason: z.string().min(1),
  }).strict(),
])

/** Operational metadata, not a second copy of a step's complete historical measurement proof. */
export const procedureStepDecisionViewSchema = procedureStepDecisionSchema.omit({ criterion: true, evidence: true }).extend({
  criterionStatus: z.enum(['supported', 'contradicted', 'unknown']).optional(),
  proof: decisionProofSchema,
}).strict()

export const projectProcedureStepDecision = (config: {
  readonly run: Pick<ProcedureRunState, 'runId' | 'sourceId' | 'sourceRevision' | 'sourcePath'>
  readonly stepId: string
  readonly decision: ProcedureStepDecision
  readonly events: ReadonlyArray<SimulationRunEvent>
}) => {
  const { run, decision, events, stepId } = config
  const { criterion, evidence: _evidence, ...metadata } = decision
  // Check the entire canonical decision, including its proof, rather than
  // guessing an event from a reused timestamp, branch label or actor alone.
  let event: Extract<SimulationRunEvent, { type: 'procedure.branch.selected' }> | undefined
  for (let index = events.length - 1; index >= 0; index--) {
    const candidate = events[index]!
    if (candidate.type === 'procedure.branch.selected' && candidate.runId === run.runId && candidate.stepId === stepId) { event = candidate; break }
  }
  const input = event?.provenance.causedByCommandId !== undefined && isDeepStrictEqual(procedureStepDecisionSchema.parse(event), decision)
    ? procedureDecisionReadInputSchema.parse({ runId: run.runId, sourceId: run.sourceId, sourceRevision: run.sourceRevision, sourcePath: run.sourcePath,
      eventId: event.id, sequence: event.seq, commandId: event.provenance.causedByCommandId }) : undefined
  // A copy starts its own journal at zero and does not copy source events.
  // The retained-source check also prevents a later unrelated start or pin
  // from being described as this snapshot's immutable historical proof.
  const retained = input === undefined ? undefined : retainedProcedureDecision(events, input)
  return procedureStepDecisionViewSchema.parse({ ...metadata,
    ...(criterion === undefined ? {} : { criterionStatus: criterion.status }),
    proof: retained === undefined ? {
      kind: 'run-state', capabilityId: 'world.procedure.runs.list', input: { includeEvidence: true }, runId: run.runId, stepId,
      reason: 'No matching immutable branch event and source start are retained. The complete current stored decision is available on this Run; a later selection can replace it.',
    } : { kind: 'event', capabilityId: 'world.procedure.decision.read', input },
  })
}
