import type { Annunciation } from '../../../core/observation/annunciation.ts'
import { simulationMs, type AlertRow } from './rows.ts'

// Alert rows as their Pack annunciates them (plan v5 W2.3–W2.7), per sample from
// the alert slot's facets and the Pack's static annunciation, nothing stored:
// each row's tag, the first-out group it is annunciated in by its label, its
// category, whether it is on one of its object's own states, whether it is
// expected after a first-out, and, while unacknowledged, the command a person
// acknowledges it by, where its Pack declares one for it. An alarm is expected
// after a first-out group where its Pack declares that group's actuation
// brings it in (expectedAfter):
// it is not first out itself, it came in after the group's first-out, or with
// it on other equipment, within the declared time, and that time has not run
// out since the first-out, past which one still standing is news again (the
// Pack's own rule, ic/alarm-philosophy.ts expectedAfterGroup, read there for a
// value's colour). Words are the Pack's.

type Indexed = { readonly alerts: ReadonlyMap<string, Annunciation['alerts'][number]>; readonly groups: ReadonlyMap<string, Annunciation['groups'][number]>; readonly categories: ReadonlyMap<string, { readonly label: string; readonly order: number }> }
const indexes = new WeakMap<Annunciation, Indexed>()
const indexOf = (annunciation: Annunciation): Indexed => indexes.get(annunciation) ?? (() => {
  const index = {
    alerts: new Map(annunciation.alerts.map(alert => [alert.id, alert])),
    groups: new Map(annunciation.groups.map(group => [group.id, group])),
    categories: new Map(annunciation.categories.map((category, order) => [category.id, { label: category.label, order }])),
  }
  indexes.set(annunciation, index)
  return index
})()

/**
 * Whether an alert row came in as the expected consequence of its object's first-out in `window.group`, and still is
 * at `nowMs` (Run time): `rows` are every alert row of its object, where the first-out is.
 */
export const expectedAfterFirstOut = (row: AlertRow, rows: ReadonlyArray<AlertRow>, window: { readonly group: string; readonly withinMs: number }, nowMs: number): boolean => {
  const at = simulationMs(row)
  if (row.alert.firstOut !== undefined || at === null) return false
  const trigger = rows.filter(other => other.objectId === row.objectId && other.alert.firstOut?.group === window.group && simulationMs(other) !== null)
    .sort((left, right) => simulationMs(left)! - simulationMs(right)!)[0]
  if (trigger === undefined || nowMs - simulationMs(trigger)! > window.withinMs) return false
  const lag = at - simulationMs(trigger)!
  const element = (candidate: AlertRow): string | undefined => candidate.alert.subject !== undefined && 'element' in candidate.alert.subject ? candidate.alert.subject.element : undefined
  const own = element(row) !== undefined && element(row) === element(trigger)
  return (lag > 0 || (lag === 0 && !own)) && lag <= window.withinMs
}

export interface AnnunciationContext {
  /** Its object's Pack annunciation; undefined where its Pack declares none. */
  readonly annunciation: (objectId: string) => Annunciation | undefined
  /** Every alert row of the object, where its first-outs are. */
  readonly objectRows: (objectId: string) => ReadonlyArray<AlertRow>
  /** The object's own states' refs (its safety functions, its mode). */
  readonly ownStates: (objectId: string) => ReadonlySet<string>
  /** The Run time the sample stands at; null on a wall clock, where nothing is placed after a first-out. */
  readonly nowMs: number | null
}

/** The rows as their Pack annunciates them now. */
export const annunciatedRows = (rows: ReadonlyArray<AlertRow>, context: AnnunciationContext): ReadonlyArray<AlertRow> => rows.map(row => {
  const declared = context.annunciation(row.objectId)
  const index = declared === undefined ? undefined : indexOf(declared)
  const alert = index?.alerts.get(row.alert.id)
  const group = alert?.group === undefined ? undefined : index!.groups.get(alert.group)
  const category = alert?.category === undefined ? undefined : index!.categories.get(alert.category)
  const window = alert?.expectedAfter
  const expected = window !== undefined && context.nowMs !== null && expectedAfterFirstOut(row, context.objectRows(row.objectId), window, context.nowMs)
    ? index!.groups.get(window.group)!.label : undefined
  const ownState = row.alert.observable !== undefined && context.ownStates(row.objectId).has(row.alert.observable)
  const acknowledge = declared?.acknowledge === undefined || alert === undefined || row.state === 'active-ack' ? undefined : {
    capabilityId: declared.acknowledge.capabilityId,
    input: { ...declared.acknowledge.input, [declared.acknowledge.objectField]: row.objectId, [declared.acknowledge.alertField]: row.alert.id },
  }
  return {
    ...row,
    ...(alert?.tag === undefined ? {} : { tag: alert.tag }),
    ...(group === undefined ? {} : { action: { label: group.label, ...(group.ends === undefined ? {} : { ends: group.ends }) } }),
    ...(category === undefined ? {} : { category: { id: alert!.category!, ...category } }),
    ...(expected === undefined ? {} : { expected: { after: expected } }),
    ...(ownState ? { ownState: true as const } : {}),
    ...(acknowledge === undefined ? {} : { acknowledge }),
  }
})
