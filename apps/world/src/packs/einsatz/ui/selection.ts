import type { GeoJsonPoint } from '../../../core/model/index.ts'
import type { Stop, UnitOrderInput } from '../order-schema.ts'
import type { SituationUnit, UnitOptions } from '../situation/schema.ts'

/** Opening an asset selects it for dispatch; only a subsequent target selection may issue an order. */
export const doubleClickMs = 500
export const dispatchObjectKinds = ['unit', 'call', 'site', 'track'] as const
export type DispatchObjectKind = typeof dispatchObjectKinds[number]
export interface ClickedObject { readonly id: string; readonly kind: DispatchObjectKind }
export type Clicked = ClickedObject | { readonly kind: 'ground'; readonly point: GeoJsonPoint }
export type CurrentJob = NonNullable<UnitOptions['busy']>
export type PlanExpectation = UnitOptions['plan']
type Option = UnitOptions['targets'][number]
type TargetingUnit = Pick<SituationUnit, 'id' | 'status' | 'commandedBy' | 'carry'> & { readonly plan: readonly PlannedStop[] }
type PlannedStop = Pick<SituationUnit['plan'][number], 'id' | 'state' | 'label' | 'target'>

export type Decision =
  | { readonly kind: 'order'; readonly target: Stop; readonly expectedPlan: PlanExpectation; readonly job: CurrentJob | null; readonly replace: boolean; readonly add: boolean; readonly assigned: boolean; readonly currentLabel: string | null; readonly replaceReason?: string; readonly addReason?: string }
  | { readonly kind: 'remove'; readonly stops: ReadonlyArray<{ readonly id: string; readonly label: string; readonly index: number }>; readonly expectedPlan: PlanExpectation }

export type Selection =
  | { readonly kind: 'none'; readonly marked: string | null }
  | { readonly kind: 'unit'; readonly unitId: string; readonly decision?: Decision }
  | { readonly kind: 'call'; readonly callId: string }
  | { readonly kind: 'site'; readonly siteId: string }

export interface SelectionState {
  readonly selection: Selection
  readonly lastClick: { readonly key: string; readonly atMs: number } | null
}

export type SelectionEvent =
  | { readonly kind: 'click'; readonly on: Clicked; readonly atMs: number }
  | { readonly kind: 'target-row'; readonly target: Stop }
  | { readonly kind: 'stop'; readonly stopId: string }
  | { readonly kind: 'decide'; readonly choice: 'replace' | 'add' | 'cancel' | { readonly remove: string } }
  | { readonly kind: 'initial-order-accepted'; readonly unitId: string }
  | { readonly kind: 'back' | 'cleared' }

export type SelectionEffect =
  | { readonly kind: 'select'; readonly objectId: string | null }
  | { readonly kind: 'options'; readonly unitId: string }
  | { readonly kind: 'recommend'; readonly callId: string }
  | { readonly kind: 'submit'; readonly input: UnitOrderInput; readonly job: CurrentJob | null }
  | { readonly kind: 'remove'; readonly unitId: string; readonly stopId: string; readonly expectedPlan: PlanExpectation }
  | { readonly kind: 'feedback'; readonly text: string }

export interface SelectionStep { readonly state: SelectionState; readonly effects: ReadonlyArray<SelectionEffect> }
const none: Selection = { kind: 'none', marked: null }
export const initialSelection: SelectionState = { selection: none, lastClick: null }

export const selectedObjectOf = (selection: Selection): string | null => {
  switch (selection.kind) {
    case 'none': return selection.marked
    case 'unit': return selection.unitId
    case 'call': return selection.callId
    case 'site': return selection.siteId
  }
}

export const stopFor = (object: ClickedObject): Stop | null => {
  switch (object.kind) {
    case 'call': return { taskId: object.id }
    case 'site': return { siteId: object.id }
    case 'track': return { trackId: object.id }
    case 'unit': return null
  }
}

export const stopObjectId = (stop: Stop): string | null =>
  'taskId' in stop ? stop.taskId : 'siteId' in stop ? stop.siteId : 'trackId' in stop ? stop.trackId : null

export const stopKey = (stop: Stop): string => stopObjectId(stop) ?? ('point' in stop ? stop.point.coordinates.join(',') : '')

export const planExpectation = (plan: readonly PlannedStop[]): PlanExpectation => plan.map(({ id, state }) => ({ id, state }))
export const samePlan = (a: PlanExpectation, b: PlanExpectation): boolean =>
  a.length === b.length && a.every((step, index) => step.id === b[index]!.id && step.state === b[index]!.state)

export const matchingOptions = (unit: TargetingUnit | undefined, options: UnitOptions | null): UnitOptions | null =>
  unit !== undefined && options?.unitId === unit.id && samePlan(planExpectation(unit.plan), options.plan) ? options : null

export const canTarget = (unit: TargetingUnit): boolean => unit.commandedBy === null && unit.status.tone !== 'out'

const unchanged = (state: SelectionState): SelectionStep => ({ state, effects: [] })
const feedback = (state: SelectionState, text: string): SelectionStep => ({ state, effects: [{ kind: 'feedback', text }] })

const transition = (state: SelectionState, next: Selection): SelectionStep => {
  const previous = state.selection
  const id = selectedObjectOf(next)
  if (id === selectedObjectOf(previous)) return unchanged(state)
  const effects: SelectionEffect[] = [{ kind: 'select', objectId: id }]
  if (next.kind === 'unit') effects.push({ kind: 'options', unitId: next.unitId })
  if (next.kind === 'call') effects.push({ kind: 'recommend', callId: next.callId })
  return { state: { ...state, selection: next }, effects }
}

const decisionFor = (state: SelectionState, unitId: string, decision: Decision): SelectionStep =>
  unchanged({ ...state, selection: { kind: 'unit', unitId, decision } })

const removeDecision = (state: SelectionState, unit: TargetingUnit, predicate: (stop: PlannedStop) => boolean): SelectionStep => {
  const stops = unit.plan.flatMap((stop, index) => predicate(stop) ? [{ id: stop.id, label: stop.label, index: index + 1 }] : [])
  if (!stops.length) return unchanged(state)
  return decisionFor(state, unit.id, { kind: 'remove', stops, expectedPlan: planExpectation(unit.plan) })
}

const targetStep = (state: SelectionState, target: Stop, unit: TargetingUnit | undefined, options: UnitOptions | null): SelectionStep => {
  if (!unit || !canTarget(unit)) return unchanged(state)
  const match = stopKey(target)
  if (unit.plan.some(stop => stopKey(stop.target) === match)) return removeDecision(state, unit, stop => stopKey(stop.target) === match)
  const current = matchingOptions(unit, options)
  if (current === null) return feedback(state, 'Reading targets. Try again in a moment.')
  const listed: Option | undefined = current.targets.find(entry => stopKey(entry.target) === match)
  if (!('point' in target) && listed === undefined) {
    return feedback(state, current.refused.find(entry => stopKey(entry.target) === match)?.text ?? 'This target is not available.')
  }
  const assigned = current.plan.length > 0 || current.busy !== null
  const loaded = unit.carry?.load.some(entry => entry.count > 0) ?? false
  const replace = listed?.canReplace ?? (current.moveRefusal === undefined && !loaded && (!assigned || unit.plan[0]?.state === 'active'))
  const add = listed?.canAdd ?? assigned
  if (!assigned && !('point' in target)) {
    if (!replace) return feedback(state, 'This target is not available.')
    return { state, effects: [{ kind: 'submit', input: { units: [unit.id], stops: [target], expectedPlan: current.plan }, job: null }] }
  }
  if (!assigned && !replace) return feedback(state, current.moveRefusal ?? 'This unit cannot move here.')
  return decisionFor(state, unit.id, {
    kind: 'order', target, expectedPlan: current.plan, job: current.busy, replace, add, assigned,
    currentLabel: unit.plan.find(stop => stop.state === 'active')?.label ?? null,
    ...(listed?.replaceRefusal === undefined ? {} : { replaceReason: listed.replaceRefusal }),
    ...(listed?.addRefusal === undefined ? {} : { addReason: listed.addRefusal }),
  })
}

export const reduceSelection = (state: SelectionState, event: SelectionEvent, options: UnitOptions | null = null, unit?: TargetingUnit): SelectionStep => {
  const selection = state.selection
  const selected = selection.kind === 'unit' && unit?.id === selection.unitId ? unit : undefined
  switch (event.kind) {
    case 'click': {
      if (selection.kind === 'unit' && selection.decision !== undefined) return unchanged(state)
      const on = event.on
      const key = on.kind === 'ground' ? `ground:${on.point.coordinates.join(',')}` : `${on.kind}:${on.id}`
      if (state.lastClick?.key === key && event.atMs - state.lastClick.atMs < doubleClickMs) return unchanged(state)
      const next = { ...state, lastClick: { key, atMs: event.atMs } }
      if (on.kind === 'unit') return transition(next, { kind: 'unit', unitId: on.id })
      if (on.kind === 'ground') return selection.kind === 'unit' ? targetStep(next, { point: on.point }, selected, options) : transition(next, none)
      if (selection.kind === 'unit' && selected && canTarget(selected)) {
        const target = stopFor(on)!
        return targetStep(next, target, selected, options)
      }
      switch (on.kind) {
        case 'call': return transition(next, { kind: 'call', callId: on.id })
        case 'site': return transition(next, { kind: 'site', siteId: on.id })
        case 'track': return transition(next, { kind: 'none', marked: on.id })
      }
    }
    case 'target-row': return selection.kind === 'unit' && selection.decision === undefined ? targetStep(state, event.target, selected, options) : unchanged(state)
    case 'stop': return selection.kind === 'unit' && selection.decision === undefined && selected && canTarget(selected) ? removeDecision(state, selected, stop => stop.id === event.stopId) : unchanged(state)
    case 'decide': {
      if (selection.kind !== 'unit' || !selection.decision) return unchanged(state)
      const { unitId, decision } = selection
      const next: SelectionState = { ...state, selection: { kind: 'unit', unitId } }
      if (event.choice === 'cancel') return unchanged(next)
      if (!selected || !canTarget(selected) || !samePlan(planExpectation(selected.plan), decision.expectedPlan)) return feedback(next, 'The plan changed. Pick the target again.')
      if (decision.kind === 'remove') {
        const choice = event.choice
        if (typeof choice !== 'object' || !decision.stops.some(stop => stop.id === choice.remove)) return unchanged(state)
        return { state: next, effects: [{ kind: 'remove', unitId, stopId: choice.remove, expectedPlan: decision.expectedPlan }] }
      }
      const add = event.choice === 'add'
      if ((event.choice !== 'replace' && !add) || (add ? !decision.add : !decision.replace)) return unchanged(state)
      const job = add ? null : decision.job
      return { state: next, effects: [{ kind: 'submit', job, input: {
        units: [unitId], stops: [decision.target], expectedPlan: decision.expectedPlan,
        ...(decision.assigned ? { when: add ? 'after' : 'now' } : {}),
        ...(job === null ? {} : { drops: job.taskId }),
      } }] }
    }
    case 'initial-order-accepted': return selection.kind === 'unit' && selection.unitId === event.unitId
      ? transition({ ...state, lastClick: null }, none)
      : unchanged(state)
    case 'cleared': return unchanged({ ...state, selection: none })
    case 'back': return selection.kind === 'unit' && selection.decision !== undefined
      ? unchanged({ ...state, selection: { kind: 'unit', unitId: selection.unitId } })
      : transition(state, none)
  }
}

export const activationActs = (quietFromMs: number | null, atMs: number): boolean => quietFromMs === null || atMs - quietFromMs >= doubleClickMs

export const selectionChangeEvent = (state: SelectionState, objectId: string | null, kindOf: (objectId: string) => DispatchObjectKind | null, atMs: number): SelectionEvent | null => {
  if (objectId === selectedObjectOf(state.selection)) return null
  if (objectId === null) return { kind: 'cleared' }
  const kind = kindOf(objectId)
  if (kind === null) return { kind: 'cleared' }
  return { kind: 'click', on: { kind, id: objectId }, atMs }
}
