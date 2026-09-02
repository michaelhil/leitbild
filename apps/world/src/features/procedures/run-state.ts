import type {
  CommandEnvelope, SimulationRunEvent, SimulationRunId, EventId, IsoTimestamp,
  ProcedureControlState, ProcedureDocument, ProcedureRunScope, ProcedureRunState,
} from '../../core/model/index.ts'
import {
  sameProcedureScope, createProcedureRunId, procedureCommandKindSchema, procedureRunClosePayloadSchema,
  procedureRunResetPayloadSchema, procedureRunStartPayloadSchema, procedureStepUpdatePayloadSchema,
  procedureRunTransitionPayloadSchema,
} from '../../core/model/index.ts'

export interface ProcedureCommitContext {
  readonly simulationRunId: SimulationRunId
  readonly at: IsoTimestamp
  readonly procedures: ProcedureControlState | undefined
  readonly objectIds: ReadonlySet<string>
  readonly factory: { readonly eventId: () => EventId; readonly nextSeq: () => number }
}

const activeRunFor = (procedures: ProcedureControlState | undefined, runId: string): ProcedureRunState => {
  const run = procedures?.runs.find(candidate => candidate.runId === runId)
  if (!run) throw new Error(`procedure run not found: ${runId}`)
  if (run.status !== 'active') throw new Error(`procedure run is not active: ${runId}`)
  return run
}

const currentRunFor = (state: ProcedureControlState | undefined, sourceId: string, procedureId: string, scope: ProcedureRunScope) =>
  state?.runs.find(run => run.sourceId === sourceId && run.procedureId === procedureId
    && sameProcedureScope(run.scope, scope) && run.status !== 'abandoned')

const assertLiveScope = (context: ProcedureCommitContext, scope: ProcedureRunScope): void => {
  if (scope.targetObjectId !== undefined && scope.targetObjectId !== scope.plantId) {
    throw new Error('procedure targetObjectId must match the canonical plantId')
  }
  if (!context.objectIds.has(scope.plantId)) throw new Error(`procedure target no longer exists: ${scope.plantId}`)
}

// Network work happens outside the Simulation Run commit queue. The returned
// function is synchronous and rechecks mutable state inside that queue.
export const prepareProcedureCommand = async (config: {
  readonly command: CommandEnvelope
  readonly procedures: ProcedureControlState | undefined
  readonly readDocument: (config: {
    readonly sourceId: string; readonly procedureId: string
    readonly sourceRevision: string; readonly sourcePath?: string
  }) => Promise<ProcedureDocument>
}): Promise<((context: ProcedureCommitContext) => ReadonlyArray<SimulationRunEvent>) | null> => {
  const { command } = config
  const kind = procedureCommandKindSchema.safeParse(command.kind)
  if (!kind.success) return null
  const base = (context: ProcedureCommitContext) => ({
    id: context.factory.eventId(), simulationRunId: context.simulationRunId,
    seq: context.factory.nextSeq(), at: context.at,
    provenance: { source: 'operator' as const, causedByCommandId: command.id },
  })
  const started = (context: ProcedureCommitContext, document: ProcedureDocument, scope: ProcedureRunScope): SimulationRunEvent => ({
    ...base(context), type: 'procedure.run.started',
    run: {
      runId: createProcedureRunId(), sourceId: document.source.sourceId,
      sourceRevision: document.source.revision, sourcePath: document.sourcePath,
      procedureId: document.procedureId, scope, title: document.title, status: 'active',
      startedAt: context.at, startedBy: command.actorId,
      ...(document.steps[0] ? { currentStepId: document.steps[0].id } : {}), stepStates: [],
    },
  })

  if (kind.data === 'world.procedure.run.start') {
    const payload = procedureRunStartPayloadSchema.parse(command.payload)
    const document = await config.readDocument(payload)
    return context => {
      assertLiveScope(context, payload.scope)
      if (currentRunFor(context.procedures, payload.sourceId, payload.procedureId, payload.scope)) {
        throw new Error(`procedure ${payload.procedureId} already has current run state for ${payload.scope.plantId}; reset it before starting another run`)
      }
      return [started(context, document, payload.scope)]
    }
  }
  if (kind.data === 'world.procedure.run.reset') {
    const payload = procedureRunResetPayloadSchema.parse(command.payload)
    return context => {
      assertLiveScope(context, payload.scope)
      return [{ ...base(context), type: 'procedure.run.reset', ...payload, resetAt: context.at, resetBy: command.actorId }]
    }
  }
  if (kind.data === 'world.procedure.run.close') {
    const payload = procedureRunClosePayloadSchema.parse(command.payload)
    return context => {
      assertLiveScope(context, activeRunFor(context.procedures, payload.runId).scope)
      return [{ ...base(context), type: 'procedure.run.closed', ...payload, closedAt: context.at, closedBy: command.actorId }]
    }
  }

  const payload = kind.data === 'world.procedure.run.transition'
    ? procedureRunTransitionPayloadSchema.parse(command.payload)
    : procedureStepUpdatePayloadSchema.parse(command.payload)
  const preparedRun = activeRunFor(config.procedures, payload.runId)
  const document = await config.readDocument(preparedRun)
  const step = document.steps.find(step => step.id === payload.stepId)
  if (!step) throw new Error(`procedure step ${payload.stepId} is not part of ${document.procedureId}`)

  if ('branchIndex' in payload) {
    const branch = step.branches[payload.branchIndex]
    if (!branch || branch.targetKind !== 'procedure') throw new Error('transition requires a declared procedure branch')
    if (branch.target === document.procedureId) throw new Error('procedure transition must target a different procedure')
    const targetDocument = await config.readDocument({
      sourceId: preparedRun.sourceId, sourceRevision: preparedRun.sourceRevision, procedureId: branch.target,
    })
    if (!targetDocument.steps.length) throw new Error(`procedure ${targetDocument.procedureId} has no entry step`)
    return context => {
      const run = activeRunFor(context.procedures, payload.runId)
      assertLiveScope(context, run.scope)
      const target = currentRunFor(context.procedures, run.sourceId, targetDocument.procedureId, run.scope)
      if (target && (target.status !== 'active' || target.sourceRevision !== run.sourceRevision || target.sourcePath !== targetDocument.sourcePath)) {
        throw new Error('destination procedure must be unstarted or active at the same source revision; reset it before transitioning')
      }
      return [
        ...(target ? [] : [started(context, targetDocument, run.scope)]),
        { ...base(context), type: 'procedure.step.updated', runId: run.runId, stepId: step.id,
          update: { assessment: 'failed' }, currentStepId: step.id, updatedAt: context.at, updatedBy: command.actorId },
        { ...base(context), type: 'procedure.run.closed', runId: run.runId, status: 'completed',
          closedAt: context.at, closedBy: command.actorId },
      ]
    }
  }
  if (payload.currentStepId !== undefined && !document.steps.some(step => step.id === payload.currentStepId)) {
    throw new Error(`procedure current step ${payload.currentStepId} is not part of ${document.procedureId}`)
  }
  return context => {
    assertLiveScope(context, activeRunFor(context.procedures, payload.runId).scope)
    return [{
      ...base(context), type: 'procedure.step.updated', runId: payload.runId, stepId: payload.stepId,
      update: {
        ...(payload.assessment === undefined ? {} : { assessment: payload.assessment }),
        ...(payload.comment === undefined ? {} : { comment: payload.comment }),
        ...(payload.favorite === undefined ? {} : { favorite: payload.favorite }),
      },
      ...(payload.currentStepId === undefined ? {} : { currentStepId: payload.currentStepId }),
      updatedAt: context.at, updatedBy: command.actorId,
    }]
  }
}
