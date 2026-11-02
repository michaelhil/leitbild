import type { SimulationRunRuntime } from '../simulation-runs/runtime.ts'
import type { Actor } from '../simulation-runs/actors.ts'
import { refObjectId } from '../model/alerts.ts'
import type { GuideCondition, GuideConditionResult } from './model.ts'
import { isQueryReadRefusal } from '../../simulation/query-read-policy.ts'

/** A deciding observation is acquired through the same caller-bound port used by the displays. */
export const evaluateGuideCondition = async (input: {
  condition: GuideCondition; runtime: SimulationRunRuntime; actor: Actor; startsAt: string;
  canInspect: (objectId: string) => boolean; wallNow?: () => number;
}): Promise<GuideConditionResult> => {
  const { runtime, condition } = input
  const snapshot = runtime.snapshot()
  const wallNow = input.wallNow ?? Date.now
  const at = snapshot.clock?.currentTime ?? new Date(wallNow()).toISOString()
  const base = { at, sequence: snapshot.seq, clock: snapshot.clock === undefined ? 'wall' as const : 'simulation' as const }
  if (condition.kind === 'clock') {
    if (snapshot.clock === undefined) return { ...base, status: 'unknown', reason: 'The simulation clock is unavailable' }
    const seconds = (Date.parse(snapshot.clock.currentTime) - Date.parse(input.startsAt)) / 1_000
    const met = (condition.afterSeconds === undefined || seconds >= condition.afterSeconds) && (condition.beforeSeconds === undefined || seconds <= condition.beforeSeconds)
    return { ...base, status: met ? 'satisfied' : 'contradicted', value: seconds, reason: met ? 'The authored simulation-time bound is satisfied' : 'The current simulation time is outside this guide step\'s bound' }
  }
  const objectId = condition.kind === 'object-status' ? condition.objectId : refObjectId(condition.ref)
  if (!input.canInspect(objectId)) return { ...base, status: 'refused', reason: 'The deciding evidence is not available to this caller' }
  if (condition.kind === 'object-status') {
    const object = snapshot.objects.find(object => object.id === objectId)
    if (!object) return { ...base, status: 'unknown', reason: 'The required object is not currently present' }
    const met = object.operational.status === condition.status
    return { ...base, value: object.operational.status, status: met ? 'satisfied' : 'contradicted', reason: met ? 'The observed object status matches' : 'The observed object status does not match' }
  }
  const port = runtime.observations(input.actor)
  try {
  const declarations = await port.declarations([objectId])
  const declaration = declarations[0]
  if (declaration === undefined || 'refused' in declaration) return { ...base, status: 'refused', reason: 'The observation declaration is unavailable' }
  const observable = declaration.observables.find(observable => observable.ref === condition.ref)
  if (!observable) return { ...base, status: 'unknown', reason: 'The guide observation is not declared by the current model' }
  if (observable.quantity !== condition.quantity || observable.unit !== condition.unit) return { ...base, status: 'unknown', reason: 'The guide quantity/unit does not match the current observation declaration' }
  const read = await port.read({ refs: [condition.ref] })
  if (read.refused.length > 0) return { ...base, status: 'refused', reason: 'The deciding observation was refused' }
  const observation = read.observations.find(observation => observation.ref === condition.ref)
  if (!observation || typeof observation.value !== typeof condition.value || typeof observation.value !== 'number' && typeof observation.value !== 'boolean' && typeof observation.value !== 'string') return { ...base, status: 'unknown', reason: 'The deciding observation is unavailable or has a different value type' }
  const evidence = { at: observation.at, clock: observation.clock, sequence: snapshot.seq, ref: condition.ref, value: observation.value, unit: condition.unit }
  const now = observation.clock === 'wall' ? wallNow() : Date.parse(runtime.snapshot().clock?.currentTime ?? at)
  const age = now - Date.parse(observation.at)
  if (observation.quality === 'stale' || age > condition.maxAgeSeconds * 1_000) return { ...evidence, status: 'stale', reason: 'The deciding observation is stale' }
  if (observation.quality !== 'good' || age < 0) return { ...evidence, status: 'unknown', reason: 'Observation quality/time does not establish this condition' }
  if (!input.canInspect(objectId)) return { ...base, status: 'refused', reason: 'Access to the deciding evidence changed while it was acquired' }
  const value = observation.value, expected = condition.value
  const met = condition.operator === 'eq' ? value === expected : typeof value === 'number' && typeof expected === 'number' && (condition.operator === 'lt' ? value < expected
    : condition.operator === 'lte' ? value <= expected : condition.operator === 'gt' ? value > expected : value >= expected)
  return { ...evidence, status: met ? 'satisfied' : 'contradicted', reason: met ? 'The acquired observation satisfies the stated comparison' : 'The acquired observation contradicts the stated comparison' }
  } catch (error) {
    if (!isQueryReadRefusal(error)) throw error
    return { ...base, status: error.code === 'query_policy_superseded' ? 'stale' : 'refused', reason: 'The deciding evidence is unavailable in the current inspection picture; acquire it again before continuing' }
  }
}
