import type {
  ActorId,
  CommandEnvelope,
  ControlInstanceEvent,
  ControlInstanceId,
  EventId,
  IsoTimestamp,
  ProcedureControlState,
  ProcedureDocument,
  ProcedureId,
  ProcedureSourceId,
} from '../model/index.ts'
import {
  createProcedureRunId,
  procedureCommandKindSchema,
  procedureRunClosePayloadSchema,
  procedureRunStartPayloadSchema,
  procedureStepUpdatePayloadSchema,
} from '../model/index.ts'

export interface ProcedureEventFactory {
  readonly eventId: () => EventId
  readonly nextSeq: () => number
}

export interface ProcedureCommandContext {
  readonly controlInstanceId: ControlInstanceId
  readonly at: IsoTimestamp
  readonly command: CommandEnvelope
  readonly procedures: ProcedureControlState | undefined
  readonly factory: ProcedureEventFactory
  readonly readDocument: (sourceId: ProcedureSourceId, procedureId: ProcedureId) => Promise<ProcedureDocument>
}

const procedureBase = (
  context: ProcedureCommandContext,
): Omit<ControlInstanceEvent, 'type'> => ({
  id: context.factory.eventId(),
  controlInstanceId: context.controlInstanceId,
  seq: context.factory.nextSeq(),
  at: context.at,
  provenance: { source: 'operator', causedByCommandId: context.command.id },
})

const activeRunFor = (
  procedures: ProcedureControlState | undefined,
  runId: string,
) => {
  const run = procedures?.runs.find(candidate => candidate.runId === runId)
  if (!run) throw new Error(`procedure run not found: ${runId}`)
  if (run.status !== 'active') throw new Error(`procedure run is not active: ${runId}`)
  return run
}

export const procedureCommandEvents = async (
  context: ProcedureCommandContext,
): Promise<ReadonlyArray<ControlInstanceEvent> | null> => {
  const kind = procedureCommandKindSchema.safeParse(context.command.kind)
  if (!kind.success) return null

  if (kind.data === 'procedure.run.start') {
    const payload = procedureRunStartPayloadSchema.parse(context.command.payload)
    const document = await context.readDocument(payload.sourceId, payload.procedureId)
    return [{
      ...procedureBase(context),
      type: 'procedure.run.started',
      run: {
        runId: createProcedureRunId(),
        sourceId: payload.sourceId,
        sourceRevision: document.source.commitSha ?? `${document.source.repository}@${document.source.ref}`,
        procedureId: document.procedureId,
        title: document.title,
        status: 'active',
        startedAt: context.at,
        startedBy: context.command.actorId,
        stepStates: [],
      },
    }]
  }

  if (kind.data === 'procedure.step.update') {
    const payload = procedureStepUpdatePayloadSchema.parse(context.command.payload)
    const run = activeRunFor(context.procedures, payload.runId)
    const document = await context.readDocument(run.sourceId, run.procedureId)
    if (!document.steps.some(step => step.id === payload.stepId)) {
      throw new Error(`procedure step ${payload.stepId} is not part of ${run.procedureId}`)
    }
    return [{
      ...procedureBase(context),
      type: 'procedure.step.updated',
      runId: payload.runId,
      stepId: payload.stepId,
      update: {
        ...(payload.assessment === undefined ? {} : { assessment: payload.assessment }),
        ...(payload.comment === undefined ? {} : { comment: payload.comment }),
        ...(payload.favorite === undefined ? {} : { favorite: payload.favorite }),
      },
      updatedAt: context.at,
      updatedBy: context.command.actorId as ActorId,
    }]
  }

  const payload = procedureRunClosePayloadSchema.parse(context.command.payload)
  activeRunFor(context.procedures, payload.runId)
  return [{
    ...procedureBase(context),
    type: 'procedure.run.closed',
    runId: payload.runId,
    status: payload.status,
    closedAt: context.at,
    closedBy: context.command.actorId,
  }]
}
