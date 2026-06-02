import { z } from 'zod'
import { operationalObjectSchema, procedureControlStateSchema, scenarioInstanceStateSchema, simulationClockStateSchema, type ControlInstanceEvent, type ObjectId, type OperationalObject, type ProcedureControlState, type ProcedureId, type ProcedureRunScope, type ProcedureRunState, type ProcedureSourceId, type ProcedureStepRunState, type ScenarioInstanceState, type SimulationClockState } from '../model/index.ts'

export interface ControlInstanceStateSnapshot {
  readonly objects: ReadonlyArray<OperationalObject>
  readonly seq: number
  readonly scenario?: ScenarioInstanceState
  readonly clock?: SimulationClockState
  readonly procedures?: ProcedureControlState
}

export const controlInstanceStateSnapshotSchema = z.object({
  objects: z.array(operationalObjectSchema),
  seq: z.number().int().nonnegative(),
  scenario: scenarioInstanceStateSchema.optional(),
  clock: simulationClockStateSchema.optional(),
  procedures: procedureControlStateSchema.optional(),
})

export interface ControlInstanceStateStore {
  readonly apply: (event: ControlInstanceEvent) => void
  readonly hydrate: (snapshot: ControlInstanceStateSnapshot) => void
  readonly snapshot: () => ControlInstanceStateSnapshot
  readonly getObject: (id: ObjectId) => OperationalObject | undefined
}

export const createControlInstanceStateStore = (): ControlInstanceStateStore => {
  const objects = new Map<ObjectId, OperationalObject>()
  let seq = 0
  let scenario: ScenarioInstanceState | undefined
  let clock: SimulationClockState | undefined
  let procedures: ProcedureControlState | undefined

  const updateScenario = (update: (current: ScenarioInstanceState) => ScenarioInstanceState): void => {
    if (!scenario) throw new Error('scenario event received before scenario state was initialized')
    scenario = update(scenario)
  }

  const apply = (event: ControlInstanceEvent): void => {
    seq = Math.max(seq, event.seq)
    if (event.type === 'object.upserted') {
      objects.set(event.object.id, event.object)
      return
    }
    if (event.type === 'object.deleted') {
      objects.delete(event.objectId)
      return
    }
    if (event.type === 'telemetry.sampled') {
      const current = objects.get(event.objectId)
      if (!current) {
        throw new Error(`telemetry event referenced unknown object: ${event.objectId}`)
      }
      objects.set(event.objectId, {
        ...current,
        telemetry: event.telemetry,
      })
      return
    }
    if (event.type === 'clock.updated') {
      clock = event.clock
      return
    }
    if (event.type === 'scenario.step.started') {
      updateScenario(current => ({
        ...current,
        script: {
          startedAt: current.script?.startedAt ?? event.at,
          firedStepIds: [...new Set([...(current.script?.firedStepIds ?? []), event.stepId])],
        },
      }))
      return
    }
    if (event.type === 'scenario.guidance.shown') {
      updateScenario(current => ({
        ...current,
        guidance: event.guidance,
      }))
      return
    }
    if (event.type === 'scenario.guidance.hidden') {
      updateScenario(current => {
        if (event.guidanceId !== undefined && current.guidance?.id !== event.guidanceId) return current
        const { guidance: _guidance, ...withoutGuidance } = current
        return withoutGuidance
      })
      return
    }
    if (event.type === 'scenario.objects.highlighted') {
      updateScenario(current => ({
        ...current,
        highlightedObjectIds: [...event.objectIds],
      }))
      return
    }
    if (event.type === 'scenario.highlights.cleared') {
      updateScenario(current => ({
        ...current,
        highlightedObjectIds: event.objectIds === undefined
          ? []
          : current.highlightedObjectIds.filter(objectId => !event.objectIds?.includes(objectId)),
      }))
      return
    }
    if (event.type === 'procedure.run.started') {
      const current = procedures ?? { runs: [] }
      procedures = {
        runs: [
          ...current.runs.filter(run => run.runId !== event.run.runId),
          event.run,
        ],
      }
      return
    }
    if (event.type === 'procedure.step.updated') {
      const current = procedures ?? { runs: [] }
      procedures = {
        runs: current.runs.map(run => run.runId === event.runId
          ? updateProcedureRunStep(run, {
              stepId: event.stepId,
              update: event.update,
              currentStepId: event.currentStepId,
              updatedAt: event.updatedAt,
              updatedBy: event.updatedBy,
            })
          : run),
      }
      return
    }
    if (event.type === 'procedure.run.closed') {
      const current = procedures ?? { runs: [] }
      procedures = {
        runs: current.runs.map(run => run.runId === event.runId
          ? {
              ...run,
              status: event.status,
              closedAt: event.closedAt,
              closedBy: event.closedBy,
            }
          : run),
      }
      return
    }
    if (event.type === 'procedure.run.reset') {
      const current = procedures ?? { runs: [] }
      procedures = {
        runs: current.runs.filter(run => !procedureRunMatchesScope(run, {
          sourceId: event.sourceId,
          procedureId: event.procedureId,
          scope: event.scope,
        })),
      }
    }
  }

  const hydrate = (snapshot: ControlInstanceStateSnapshot): void => {
    objects.clear()
    for (const object of snapshot.objects) objects.set(object.id, object)
    seq = snapshot.seq
    scenario = snapshot.scenario
    clock = snapshot.clock
    procedures = snapshot.procedures
  }

  return {
    apply,
    hydrate,
    snapshot: () => ({
      objects: [...objects.values()],
      seq,
      ...(scenario === undefined ? {} : { scenario }),
      ...(clock === undefined ? {} : { clock }),
      ...(procedures === undefined ? {} : { procedures }),
    }),
    getObject: (id: ObjectId) => objects.get(id),
  }
}

const sameProcedureScope = (
  left: ProcedureRunScope,
  right: ProcedureRunScope,
): boolean =>
  left.systemId === right.systemId
    && left.targetObjectId === right.targetObjectId

const procedureRunMatchesScope = (
  run: ProcedureRunState,
  config: {
    readonly sourceId: ProcedureSourceId
    readonly procedureId: ProcedureId
    readonly scope: ProcedureRunScope
  },
): boolean =>
  run.sourceId === config.sourceId
    && run.procedureId === config.procedureId
    && sameProcedureScope(run.scope, config.scope)

const updateProcedureRunStep = (
  run: ProcedureRunState,
  config: {
    readonly stepId: string
    readonly update: {
      readonly assessment?: ProcedureStepRunState['assessment']
      readonly comment?: string
      readonly favorite?: boolean
    }
    readonly currentStepId?: ProcedureRunState['currentStepId']
    readonly updatedAt: ProcedureStepRunState['updatedAt']
    readonly updatedBy: ProcedureStepRunState['updatedBy']
  },
): ProcedureRunState => {
  const existing = run.stepStates.find(step => step.stepId === config.stepId)
  const nextStep: ProcedureStepRunState = {
    stepId: config.stepId as ProcedureStepRunState['stepId'],
    assessment: config.update.assessment ?? existing?.assessment ?? 'blank',
    ...(config.update.comment === undefined
      ? existing?.comment === undefined ? {} : { comment: existing.comment }
      : config.update.comment.trim().length === 0 ? {} : { comment: config.update.comment }),
    favorite: config.update.favorite ?? existing?.favorite ?? false,
    updatedAt: config.updatedAt,
    updatedBy: config.updatedBy,
  }
  return {
    ...run,
    currentStepId: config.currentStepId ?? (config.stepId as ProcedureRunState['currentStepId']),
    stepStates: existing === undefined
      ? [...run.stepStates, nextStep]
      : run.stepStates.map(step => step.stepId === config.stepId ? nextStep : step),
  }
}
