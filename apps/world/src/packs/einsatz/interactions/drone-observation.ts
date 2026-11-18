import { z } from 'zod'
import { audienceVisibleTo, notificationIdSchema, objectIdSchema, type InteractionEffect, type InteractionHandler, type InteractionSignal, type ObjectId, type OperationalObject } from '../../../core/model/index.ts'
import { closeDraft, openDraft, recordTask, taskIn } from '../engine/draft.ts'
import { taskDataSchema, type EngineState, type TaskRecord, type Transition } from '../engine/model.ts'
import { patch } from '../engine/values.ts'
import { einsatzPackId } from '../ids.ts'

/**
 * The Drone Pack's reconnaissance observation of an Einsatz task. The Drone
 * signal only proves that a validated sensor observed a target; Einsatz owns
 * what it means for a task. The signal type and payload are read through a
 * schema owned here, so Einsatz imports nothing of the Drone Pack.
 *
 * The Einsatz runtime is the only writer of its objects, so the two halves
 * of an observation judge the same signal with the same function: the
 * interaction handler emits the notice, and the runtime, observing the
 * committed signal, records the observation on the task (`observeTask`),
 * which `world.einsatz.situation` shows on the call row.
 */

export const reconnaissanceObservationSignalType = 'reconnaissance.observation.requested'

const payloadSchema = z.object({
  observerId: objectIdSchema,
  targetId: objectIdSchema,
  sensorId: z.string().min(1).max(128),
  observedAtMs: z.number().finite().nonnegative(),
}).strict()

/** What an observation signal means for Einsatz: nothing (another Pack's target), refused with why, or a task observed. */
export type ObservationVerdict =
  | { readonly kind: 'not-einsatz' }
  | { readonly kind: 'refused'; readonly message: string }
  | { readonly kind: 'observed'; readonly taskId: string; readonly observed: NonNullable<TaskRecord['observed']>; readonly message: string }

/**
 * Whether every view that sees the task also sees the observer, so the
 * observer's label may be written on the task. A Run without sides writes
 * no audience; then everyone sees both.
 */
const observerSeenWithTask = (observer: OperationalObject, task: OperationalObject): boolean => {
  const audience = task.audience
  if (audience === undefined) return true
  if (audience === 'public') return observer.audience === 'public'
  return audience.every(side => audienceVisibleTo(observer.audience, [side]))
}

/**
 * Judges an observation signal against the Run's committed objects. Only a
 * target of this Pack is Einsatz's to judge; of those, only a task records
 * an observation, made by the object that sent the signal.
 */
export const judgeObservation = (signal: InteractionSignal, objectById: (id: ObjectId) => OperationalObject | undefined): ObservationVerdict => {
  const payload = payloadSchema.safeParse(signal.payload)
  if (!payload.success) {
    const aimsHere = signal.targets.some(endpoint => endpoint.kind === 'object' && objectById(endpoint.id)?.packId === einsatzPackId)
    return aimsHere ? { kind: 'refused', message: 'The reconnaissance signal does not carry an observer, a target, a sensor and an observation time' } : { kind: 'not-einsatz' }
  }
  const target = objectById(payload.data.targetId)
  if (target === undefined || target.packId !== einsatzPackId) return { kind: 'not-einsatz' }
  const observer = objectById(payload.data.observerId)
  if (observer === undefined || signal.source.kind !== 'object' || signal.source.id !== observer.id) {
    return { kind: 'refused', message: 'The reconnaissance observer is not available' }
  }
  if (!signal.targets.some(endpoint => endpoint.kind === 'object' && endpoint.id === target.id)) {
    return { kind: 'refused', message: 'The reconnaissance target does not match the signal target' }
  }
  if (!taskDataSchema.safeParse(target.packData).success) return { kind: 'refused', message: `${target.label} is not a task; only a task records an observation` }
  if (!observerSeenWithTask(observer, target)) {
    return { kind: 'refused', message: `${observer.label} is not seen by every side that sees ${target.label}, so its observation is not recorded` }
  }
  return {
    kind: 'observed',
    taskId: target.id,
    observed: { by: observer.label, atMs: payload.data.observedAtMs },
    message: `${observer.label} observed ${target.label}`,
  }
}

/** Records an observation on a task as one task transition; the latest observation replaces the one before. */
export const observeTask = (state: EngineState, taskId: string, observed: NonNullable<TaskRecord['observed']>): { readonly state: EngineState; readonly transitions: ReadonlyArray<Transition> } => {
  const draft = openDraft(state)
  recordTask(draft, patch(taskIn(draft, taskId), { observed }))
  return { state: closeDraft(draft), transitions: draft.transitions }
}

const notice = (signal: InteractionSignal, verdict: Exclude<ObservationVerdict, { readonly kind: 'not-einsatz' }>): InteractionEffect => ({
  type: 'notification.emit',
  notification: {
    id: notificationIdSchema.parse(`notification:reconnaissance:${crypto.randomUUID()}`),
    simulationRunId: signal.simulationRunId,
    at: signal.at,
    title: verdict.kind === 'observed' ? 'Observation recorded' : 'Observation not recorded',
    message: verdict.message,
    severity: verdict.kind === 'observed' ? 'notice' : 'warning',
    source: signal.source,
    targets: signal.targets,
    signalId: signal.id,
  },
})

/** The interaction handler: the notice for each observation of an Einsatz object, recorded or refused. */
export const createDroneObservationHandler = (): InteractionHandler => ({
  id: 'einsatz.drone-observation',
  priority: 60,
  accepts: signal => signal.type === reconnaissanceObservationSignalType,
  handle: async ({ signal, snapshot }) => {
    const objects = new Map(snapshot.objects.map(object => [object.id, object]))
    const verdict = judgeObservation(signal, id => objects.get(id))
    return verdict.kind === 'not-einsatz' ? [] : [notice(signal, verdict)]
  },
})
