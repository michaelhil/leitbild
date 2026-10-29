import { z } from 'zod'
import { embeddedViewPublicationSchema } from '@leitbild/contracts'
import { eventBaseSchema, type SimulationRunEvent } from '../../core/model/events.ts'
import { procedureBranchSelectedEventSchema, procedureRunStateSchema, type ProcedureRunState } from '../../core/model/procedures.ts'
import { PROCEDURE_DECISION_VIEW_TYPE } from './decision-view-type.ts'

/** One committed selection, independent of later navigation, reset or source publication. */
export const procedureTransitionDecisionSchema = z.object({
  run: procedureRunStateSchema.pick({ runId: true, procedureId: true, sourceId: true, sourceRevision: true, sourcePath: true, scope: true }),
  event: eventBaseSchema.merge(procedureBranchSelectedEventSchema),
}).strict()
export type ProcedureTransitionDecision = z.infer<typeof procedureTransitionDecisionSchema>

/** An exact historical selector, small enough for the existing embedded-view route. */
export const procedureDecisionReadInputSchema = z.object({
  runId: procedureTransitionDecisionSchema.shape.run.shape.runId,
  sourceId: procedureTransitionDecisionSchema.shape.run.shape.sourceId,
  sourceRevision: procedureTransitionDecisionSchema.shape.run.shape.sourceRevision,
  sourcePath: procedureTransitionDecisionSchema.shape.run.shape.sourcePath,
  eventId: eventBaseSchema.shape.id,
  sequence: eventBaseSchema.shape.seq,
  commandId: eventBaseSchema.shape.provenance.shape.causedByCommandId.unwrap(),
}).strict()
export type ProcedureDecisionReadInput = z.infer<typeof procedureDecisionReadInputSchema>

export const procedureTransitionReceiptSchema = z.object({
  run: procedureTransitionDecisionSchema.shape.run,
  event: eventBaseSchema.pick({ id: true, simulationRunId: true, seq: true }).merge(procedureBranchSelectedEventSchema.pick({
    runId: true, stepId: true, branchIndex: true, outcome: true, target: true, targetKind: true,
    simulationTime: true, selectedBy: true, label: true,
  })).extend({ criterionStatus: z.enum(['supported', 'contradicted', 'unknown']).optional() }),
}).strict()

/** The full proof stays in the journal; the model receives an exact compact receipt and a view reference. */
export const publishProcedureTransitionDecision = (decision: ProcedureTransitionDecision) => {
  const { run, event } = decision
  const locator = procedureDecisionLocator(decision)
  return {
    decision: procedureTransitionReceiptSchema.parse({ run, event: { ...event,
      ...(event.criterion === undefined ? {} : { criterionStatus: event.criterion.status }) } }),
    view: embeddedViewPublicationSchema.parse({ viewType: PROCEDURE_DECISION_VIEW_TYPE,
      title: `${run.procedureId} · ${event.label ?? event.stepId}`.slice(0, 120), height: 640, state: JSON.stringify(locator), windowOnly: true }),
  }
}

export const procedureDecisionLocator = ({ run, event }: ProcedureTransitionDecision): ProcedureDecisionReadInput =>
  procedureDecisionReadInputSchema.parse({
    runId: run.runId, sourceId: run.sourceId, sourceRevision: run.sourceRevision, sourcePath: run.sourcePath,
    eventId: event.id, sequence: event.seq, commandId: event.provenance.causedByCommandId,
  })

/** Resolve the one immutable event and its historical source/scope, never the latest step state. */
export const retainedProcedureDecision = (events: ReadonlyArray<SimulationRunEvent>, input: ProcedureDecisionReadInput): ProcedureTransitionDecision | undefined => {
  const event = events.find((event): event is Extract<SimulationRunEvent, { type: 'procedure.branch.selected' }> =>
    event.type === 'procedure.branch.selected' && event.id === input.eventId && event.seq === input.sequence
    && event.runId === input.runId && event.provenance.causedByCommandId === input.commandId)
  if (!event) return undefined
  const started = events.find(event => event.type === 'procedure.run.started' && event.run.runId === input.runId && event.seq < input.sequence)
  if (!started || started.type !== 'procedure.run.started' || started.run.sourceId !== input.sourceId
    || started.run.sourceRevision !== input.sourceRevision || started.run.sourcePath !== input.sourcePath) return undefined
  return procedureTransitionDecision(started.run, event)
}

export const procedureTransitionDecision = (
  run: ProcedureRunState,
  event: Extract<SimulationRunEvent, { type: 'procedure.branch.selected' }>,
): ProcedureTransitionDecision => {
  if (event.runId !== run.runId) throw new Error('Procedure decision receipt does not match its pinned Run')
  return procedureTransitionDecisionSchema.parse({ run, event })
}
