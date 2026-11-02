import type { OperationalObject } from '../../core/model/index.ts'
import type { QueryReadPolicy } from '../../simulation/query-read-policy.ts'
import { einsatzDataSchema, type EngineState, type UnitData, type TaskData } from './engine/model.ts'
import { trackDataSchema, trackIndexDataSchema } from './engine/combat-model.ts'
import { stepTargetId } from './steps.ts'

const recordReferences = (data: UnitData | TaskData): ReadonlyArray<string> => data.type === 'task'
  ? data.lastAction?.target === undefined ? [] : [data.lastAction.target]
  : [data.taskId, data.siteId, data.engage, data.target, data.lastAction?.target, ...data.orders.map(step => stepTargetId(step.target))].filter((id): id is string => id !== undefined)

export const einsatzInspectionReferences = (object: OperationalObject): ReadonlyArray<string> => {
  const type = (object.packData as { type?: string }).type
  if (type === 'track') { trackDataSchema.parse(object.packData); return [] }
  if (type === 'track-index') { const index = trackIndexDataSchema.parse(object.packData); return [...Object.keys(index.subjects), ...Object.values(index.subjects)] }
  return recordReferences(einsatzDataSchema.parse(object.packData))
}

/** Recommendations cannot offer a unit whose hidden plan determines its
 * eligibility. Do not fabricate a released/reassigned engine state. */
export const einsatzQueryState = (state: EngineState, policy: QueryReadPolicy): EngineState => !policy.restricted ? state : {
  ...state,
  units: new Map([...state.units].filter(([id, unit]) => policy.canInspect(id) && recordReferences(unit).every(policy.canInspect))),
  tasks: new Map([...state.tasks].filter(([id, task]) => policy.canInspect(id) && recordReferences(task).every(policy.canInspect))),
  motion: new Map([...state.motion].filter(([id]) => policy.canInspect(id))),
}
