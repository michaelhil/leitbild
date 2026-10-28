/**
 * A sample as it travels from the display route to the vignette (§5.8): each part said once. An alert row leaves out
 * what the vignette derives the same from the row itself or from what the sample says once for its object (its key,
 * its object's label, Pack and category, its group, priority and raise time, its category's label and place, the
 * command acknowledging it); an observation shares the sample's exact timestamp/clock where equal; a lead row is
 * named by its ref where the caller holds its declaration (`held`), whole otherwise. The encoder leaves a field out
 * only where decoding gives it back equal, field by field, so the vignette
 * reads the very sample World composed (decodeSample(encodeSample(sample)) equals it).
 */
import type { AlertRow } from '../alerts/rows.ts'
import type { Observation } from '../../../core/observation/model.ts'
import type { VignetteSample, VignetteValue } from './model.ts'

type Acknowledge = NonNullable<AlertRow['acknowledge']>
type Category = NonNullable<AlertRow['category']>

/** What every alert row of one object shares, said once. */
export interface WireObject {
  readonly label: string
  readonly packId: string
  readonly categoryId: string
  /** Its rows' categories by id, where the sample's `categories` does not declare them for the object. */
  readonly categories?: Readonly<Record<string, { readonly label: string; readonly order: number }>>
  /** The command acknowledging one of its alerts: `input` with the alert's id at `alertField`. */
  readonly acknowledge?: { readonly capabilityId: string; readonly input: Acknowledge['input']; readonly alertField: string }
}

/** An alert row on the wire: what the vignette does not derive the same. */
export type WireAlertRow = Pick<AlertRow, 'objectId' | 'alert' | 'state' | 'expected' | 'tag' | 'action' | 'ownState'> & {
  readonly key?: string
  readonly objectLabel?: string
  readonly packId?: string
  readonly categoryId?: string
  readonly group?: AlertRow['group']
  readonly priority?: AlertRow['priority']
  readonly raised?: AlertRow['raised']
  /** By id where its object's categories place it; whole otherwise. */
  readonly category?: string | Category
  /** true: its object's command, for this alert. */
  readonly acknowledge?: true | Acknowledge
}

/** A reading keeps a different timestamp or clock; an equal sample stamp is said once. */
export type WireObservation = Omit<Observation, 'at' | 'clock'> & Partial<Pick<Observation, 'at' | 'clock'>>

export interface WireSample extends Omit<VignetteSample, 'alerts' | 'leads' | 'observations'> {
  readonly observations: ReadonlyArray<WireObservation>
  readonly alerts: ReadonlyArray<WireAlertRow>
  readonly objects?: Readonly<Record<string, WireObject>>
  /** By the index of each values view holding a lead request: its values now, by ref. */
  readonly leads?: Readonly<Record<number, ReadonlyArray<string>>>
  /** The declarations of the lead values the caller does not hold. */
  readonly declared?: ReadonlyArray<VignetteValue>
}

/** Equal as JSON values: a field left undefined is one not there. */
const same = (left: unknown, right: unknown): boolean => {
  if (left === right) return true
  if (typeof left !== 'object' || typeof right !== 'object' || left === null || right === null || Array.isArray(left) !== Array.isArray(right)) return false
  const [a, b] = [left as Record<string, unknown>, right as Record<string, unknown>]
  const keys = new Set([...Object.keys(a), ...Object.keys(b)].filter(key => a[key] !== undefined || b[key] !== undefined))
  return [...keys].every(key => same(a[key], b[key]))
}

/** What a row's key, group, priority and raise time are, read from its alert. */
const derived = (row: Pick<AlertRow, 'objectId' | 'alert'>) => {
  const subjectGroup = row.alert.subject !== undefined && 'group' in row.alert.subject ? row.alert.subject.group : undefined
  return {
    key: `${row.objectId}|${row.alert.id}`,
    group: subjectGroup === undefined ? { objectId: row.objectId } : { objectId: row.objectId, subjectGroup },
    priority: row.alert.priority ?? null,
    raised: row.alert.clock === undefined ? null : { at: row.alert.raisedAt, clock: row.alert.clock },
  }
}

/** A category by id, as the sample's declared categories of its object place it, else as its object says. */
const categoryOf = (id: string, objectId: string, sample: Pick<VignetteSample, 'categories'>, object: WireObject | undefined): Category | undefined => {
  const declared = sample.categories?.[objectId]
  const order = declared?.findIndex(category => category.id === id) ?? -1
  if (order >= 0) return { id, label: declared![order]!.label, order }
  const said = object?.categories?.[id]
  return said === undefined ? undefined : { id, ...said }
}

const acknowledgeOf = (template: NonNullable<WireObject['acknowledge']>, alertId: string): Acknowledge =>
  ({ capabilityId: template.capabilityId, input: { ...template.input, [template.alertField]: alertId } })

/** The field of an acknowledgement's input that names its alert, where exactly one does. */
const alertFieldOf = (row: AlertRow & { readonly acknowledge: Acknowledge }): string | undefined => {
  const fields = Object.entries(row.acknowledge.input).filter(([, value]) => value === row.alert.id).map(([field]) => field)
  return fields.length === 1 ? fields[0] : undefined
}

/** The sample for the wire; `held`: the lead values whose declarations the caller holds, by ref. */
export const encodeSample = (sample: VignetteSample, held: ReadonlySet<string> = new Set()): WireSample => {
  const objects = new Map<string, { label: string; packId: string; categoryId: string; categories: Record<string, { label: string; order: number }>; acknowledge?: NonNullable<WireObject['acknowledge']> }>()
  for (const row of sample.alerts) {
    if (!objects.has(row.objectId)) objects.set(row.objectId, { label: row.objectLabel, packId: row.packId, categoryId: row.categoryId, categories: {} })
    const object = objects.get(row.objectId)!
    if (object.acknowledge === undefined && row.acknowledge !== undefined) {
      const alertField = alertFieldOf(row as AlertRow & { readonly acknowledge: Acknowledge })
      if (alertField !== undefined) {
        const { [alertField]: _alert, ...input } = row.acknowledge.input
        object.acknowledge = { capabilityId: row.acknowledge.capabilityId, input, alertField }
      }
    }
    if (row.category !== undefined && categoryOf(row.category.id, row.objectId, sample, undefined) === undefined && object.categories[row.category.id] === undefined) {
      object.categories[row.category.id] = { label: row.category.label, order: row.category.order }
    }
  }
  const said = new Map([...objects].map(([objectId, { categories, acknowledge, ...rest }]): [string, WireObject] =>
    [objectId, { ...rest, ...(Object.keys(categories).length === 0 ? {} : { categories }), ...(acknowledge === undefined ? {} : { acknowledge }) }]))
  const alerts = sample.alerts.map((row): WireAlertRow => {
    const object = said.get(row.objectId)!
    const from = derived(row)
    const { key, objectLabel, packId, categoryId, group, priority, raised, category, acknowledge, ...kept } = row
    return {
      ...kept,
      ...(key === from.key ? {} : { key }),
      ...(objectLabel === object.label ? {} : { objectLabel }),
      ...(packId === object.packId ? {} : { packId }),
      ...(categoryId === object.categoryId ? {} : { categoryId }),
      ...(same(group, from.group) ? {} : { group }),
      ...(priority === from.priority ? {} : { priority }),
      ...(same(raised, from.raised) ? {} : { raised }),
      ...(category === undefined ? {} : { category: same(categoryOf(category.id, row.objectId, sample, object), category) ? category.id : category }),
      ...(acknowledge === undefined ? {} : { acknowledge: object.acknowledge !== undefined && same(acknowledgeOf(object.acknowledge, row.alert.id), acknowledge) ? true as const : acknowledge }),
    }
  })
  const { alerts: _rows, leads, observations, ...rest } = sample
  const declared = leads === undefined ? [] : [...new Map(Object.values(leads).flat().filter(value => !held.has(value.ref)).map(value => [value.ref, value] as const)).values()]
  return {
    ...rest, alerts,
    observations: observations.map(({ at, clock, ...reading }) => ({
      ...reading,
      ...(at === sample.at.at ? {} : { at }),
      ...(clock === sample.at.clock ? {} : { clock }),
    })),
    ...(said.size === 0 ? {} : { objects: Object.fromEntries(said) }),
    ...(leads === undefined ? {} : { leads: Object.fromEntries(Object.entries(leads).map(([index, values]) => [index, values.map(value => value.ref)])) }),
    ...(declared.length === 0 ? {} : { declared }),
  }
}

/** The sample World composed, from the wire; `held`: the lead values the caller holds, by ref (what it named as held). */
export const decodeSample = (wire: WireSample, held: ReadonlyMap<string, VignetteValue> = new Map()): VignetteSample => {
  const { alerts: rows, objects = {}, leads, declared = [], observations, ...rest } = wire
  const known = new Map([...held, ...declared.map(value => [value.ref, value] as const)])
  const alerts = rows.map((row): AlertRow => {
    const object = objects[row.objectId]
    const from = derived(row)
    const { key, objectLabel, packId, categoryId, group, priority, raised, category, acknowledge, ...kept } = row
    const said = (field: string, value: string | undefined): string => {
      if (value === undefined) throw new Error(`sample: alert ${row.alert.id} names no ${field} and its object ${row.objectId} says none`)
      return value
    }
    const placed = typeof category === 'string' ? categoryOf(category, row.objectId, wire, object) : category
    if (typeof category === 'string' && placed === undefined) throw new Error(`sample: alert ${row.alert.id} names category ${category}, which its object does not place`)
    if (acknowledge === true && object?.acknowledge === undefined) throw new Error(`sample: alert ${row.alert.id} is acknowledged by its object's command, which it does not say`)
    return {
      ...kept,
      key: key ?? from.key,
      objectLabel: said('label', objectLabel ?? object?.label),
      packId: said('Pack', packId ?? object?.packId),
      categoryId: said('category id', categoryId ?? object?.categoryId),
      group: group ?? from.group,
      priority: priority === undefined ? from.priority : priority,
      raised: raised === undefined ? from.raised : raised,
      ...(placed === undefined ? {} : { category: placed }),
      ...(acknowledge === undefined ? {} : { acknowledge: acknowledge === true ? acknowledgeOf(object!.acknowledge!, row.alert.id) : acknowledge }),
    }
  })
  const value = (ref: string): VignetteValue => {
    const found = known.get(ref)
    if (found === undefined) throw new Error(`sample: lead value ${ref} has no declaration (neither held nor sent)`)
    return found
  }
  return {
    ...rest, alerts,
    observations: observations.map(({ at, clock, ...reading }) => ({
      ...reading,
      at: at === undefined ? wire.at.at : at,
      clock: clock === undefined ? wire.at.clock : clock,
    })),
    ...(leads === undefined ? {} : { leads: Object.fromEntries(Object.entries(leads).map(([index, refs]) => [index, refs.map(value)])) }),
  }
}
