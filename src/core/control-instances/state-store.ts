import { z } from 'zod'
import { operationalObjectSchema, scenarioInstanceStateSchema, type DomainEvent, type ObjectId, type OperationalObject, type ScenarioInstanceState } from '../model/index.ts'

export interface ControlInstanceStateSnapshot {
  readonly objects: ReadonlyArray<OperationalObject>
  readonly seq: number
  readonly scenario?: ScenarioInstanceState
}

export const controlInstanceStateSnapshotSchema = z.object({
  objects: z.array(operationalObjectSchema),
  seq: z.number().int().nonnegative(),
  scenario: scenarioInstanceStateSchema.optional(),
})

export interface ControlInstanceStateStore {
  readonly apply: (event: DomainEvent) => void
  readonly hydrate: (snapshot: ControlInstanceStateSnapshot) => void
  readonly snapshot: () => ControlInstanceStateSnapshot
  readonly getObject: (id: ObjectId) => OperationalObject | undefined
}

export const createControlInstanceStateStore = (): ControlInstanceStateStore => {
  const objects = new Map<ObjectId, OperationalObject>()
  let seq = 0
  let scenario: ScenarioInstanceState | undefined

  const updateScenario = (update: (current: ScenarioInstanceState) => ScenarioInstanceState): void => {
    if (!scenario) throw new Error('scenario event received before scenario state was initialized')
    scenario = update(scenario)
  }

  const apply = (event: DomainEvent): void => {
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
    }
  }

  const hydrate = (snapshot: ControlInstanceStateSnapshot): void => {
    objects.clear()
    for (const object of snapshot.objects) objects.set(object.id, object)
    seq = snapshot.seq
    scenario = snapshot.scenario
  }

  return {
    apply,
    hydrate,
    snapshot: () => ({
      objects: [...objects.values()],
      seq,
      ...(scenario === undefined ? {} : { scenario }),
    }),
    getObject: (id: ObjectId) => objects.get(id),
  }
}
