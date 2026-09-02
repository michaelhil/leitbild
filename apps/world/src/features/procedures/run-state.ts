import type {
  ActorId,
  CommandEnvelope,
  SimulationRunEvent,
  SimulationRunId,
  EventId,
  IsoTimestamp,
  ProcedureControlState,
  ProcedureDocument,
  ProcedureId,
  ProcedureRunScope,
  ProcedureSourceId,
} from '../../core/model/index.ts'
import {
  createProcedureRunId,
  procedureCommandKindSchema,
  procedureRunClosePayloadSchema,
  procedureRunResetPayloadSchema,
  procedureRunStartPayloadSchema,
  procedureStepUpdatePayloadSchema,
} from '../../core/model/index.ts'

export interface ProcedureEventFactory {
  readonly eventId: () => EventId
  readonly nextSeq: () => number
}

export interface ProcedureCommandContext {
  readonly simulationRunId: SimulationRunId
  readonly at: IsoTimestamp
  readonly command: CommandEnvelope
  readonly procedures: ProcedureControlState | undefined
  readonly factory: ProcedureEventFactory
  readonly readDocument: (config: {
    readonly sourceId: ProcedureSourceId
    readonly procedureId: ProcedureId
    readonly sourceRevision: string
    readonly sourcePath?: string
  }) => Promise<ProcedureDocument>
}

const procedureBase = (
  context: ProcedureCommandContext,
): Omit<SimulationRunEvent, 'type'> => ({
  id: context.factory.eventId(),
  simulationRunId: context.simulationRunId,
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

const sameProcedureScope = (
  left: ProcedureRunScope,
  right: ProcedureRunScope,
): boolean =>
  left.plantId === right.plantId
    && left.targetObjectId === right.targetObjectId

const runHasCurrentState = (
  procedures: ProcedureControlState | undefined,
  config: {
    readonly sourceId: ProcedureSourceId
    readonly procedureId: ProcedureId
    readonly scope: ProcedureRunScope
  },
): boolean =>
  procedures?.runs.some(run =>
    run.sourceId === config.sourceId
      && run.procedureId === config.procedureId
      && sameProcedureScope(run.scope, config.scope)
      && (run.status === 'active' || run.status === 'completed'),
  ) ?? false

export const procedureCommandEvents = async (
  context: ProcedureCommandContext,
): Promise<ReadonlyArray<SimulationRunEvent> | null> => {
  const kind = procedureCommandKindSchema.safeParse(context.command.kind)
  if (!kind.success) return null

  if (kind.data === 'world.procedure.run.start') {
    const payload = procedureRunStartPayloadSchema.parse(context.command.payload)
    if (runHasCurrentState(context.procedures, payload)) {
      throw new Error(`procedure ${payload.procedureId} already has current run state for ${payload.scope.plantId}; reset it before starting another run`)
    }
    const document = await context.readDocument({
      sourceId: payload.sourceId,
      procedureId: payload.procedureId,
      sourceRevision: payload.sourceRevision,
    })
    return [{
      ...procedureBase(context),
      type: 'procedure.run.started',
      run: {
        runId: createProcedureRunId(),
        sourceId: payload.sourceId,
        sourceRevision: document.source.revision,
        sourcePath: document.sourcePath,
        procedureId: document.procedureId,
        scope: payload.scope,
        title: document.title,
        status: 'active',
        startedAt: context.at,
        startedBy: context.command.actorId,
        ...(document.steps[0] === undefined ? {} : { currentStepId: document.steps[0].id }),
        stepStates: [],
      },
    }]
  }

  if (kind.data === 'world.procedure.step.update') {
    const payload = procedureStepUpdatePayloadSchema.parse(context.command.payload)
    const run = activeRunFor(context.procedures, payload.runId)
    const document = await context.readDocument({
      sourceId: run.sourceId,
      procedureId: run.procedureId,
      sourceRevision: run.sourceRevision,
      sourcePath: run.sourcePath,
    })
    if (!document.steps.some(step => step.id === payload.stepId)) {
      throw new Error(`procedure step ${payload.stepId} is not part of ${run.procedureId}`)
    }
    if (payload.currentStepId !== undefined && !document.steps.some(step => step.id === payload.currentStepId)) {
      throw new Error(`procedure current step ${payload.currentStepId} is not part of ${run.procedureId}`)
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
      ...(payload.currentStepId === undefined ? {} : { currentStepId: payload.currentStepId }),
      updatedAt: context.at,
      updatedBy: context.command.actorId as ActorId,
    }]
  }

  if (kind.data === 'world.procedure.run.reset') {
    const payload = procedureRunResetPayloadSchema.parse(context.command.payload)
    return [{
      ...procedureBase(context),
      type: 'procedure.run.reset',
      sourceId: payload.sourceId,
      procedureId: payload.procedureId,
      scope: payload.scope,
      resetAt: context.at,
      resetBy: context.command.actorId,
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
