// applyEdits: field-level apply of the edit vocabulary, then reference integrity, protection, authority
// (A2 and adversary item 8) and test minimums over the whole result. Pure: no I/O. A list applies all or
// nothing; a refusal throws a PlanningError naming the edit, the keys and the expected fields.
import { z } from 'zod'
import { planningError } from '../errors.ts'
import { durationMs } from '../time/units.ts'
import { editSchema, type Edit } from './edit-schema.ts'
import {
  combineWorldFacts, planInputsSchema,
  type Origin, type PlanInputs, type Source, type WorldRef,
} from './schema.ts'
import { publishedInputSchema } from '../api/contract.ts'
import { labelled, weakeningWords } from './summary.ts'

type Inputs = PlanInputs
type Equipment = Inputs['equipment'][number]
type Job = Inputs['jobs'][number]
type Rule = Inputs['rules'][number]
type Resource = Inputs['resources'][number]
type Purchase = Inputs['purchases'][number]
type Kind = Edit['edit']
type EditOf<K extends Kind> = Extract<Edit, { edit: K }>

/** Who made a change, as stored. */
export interface StoredActor { readonly kind: 'human' | 'agent' | 'service'; readonly id?: string; readonly name?: string }

export interface EditContext {
  /** ISO instant of the change; used for linkedAt and ordered.at. */
  readonly now: string
  readonly by: StoredActor
  /** The plan's drafted brackets (Plan.drafts): Module state, never written by an edit. */
  readonly drafts?: ReadonlySet<string>
}

/** One structured change; summary.ts turns it into words. */
export interface ChangeRecord {
  readonly verb: 'added' | 'changed' | 'removed'
  readonly what: Exclude<Kind, 'remove'> | 'group'
  readonly key: string
  readonly fields: readonly string[]
}

/** An edit that removes or weakens a hard rule's coverage. Saving it needs authority. */
export interface Weakening {
  readonly code: 'needs_authority' | 'below_minimum'
  readonly edit: number
  readonly about: readonly string[]
  readonly what: 'support' | 'group' | 'function' | 'locator' | 'job-kind' | 'isolation' | 'covering-equipment' | 'covering-job' | 'precondition' | 'protected' | 'rule' | 'equipment' | 'minimum' | 'below-minimum'
}

export interface EditOutcome {
  readonly inputs: Inputs
  readonly changes: readonly ChangeRecord[]
  readonly weakens: readonly Weakening[]
  /** The Run reference changed, so World copies of the previous Run were cleared. */
  readonly runChanged: boolean
  /** The plan's drafted brackets after the edits, sorted: drafting adds; any edit or removal of one ends it. */
  readonly drafts: readonly string[]
}

// ───────────── refusals ─────────────

const kindOptions = new Map(editSchema.options.map(option => [option.shape.edit.value as Kind, option]))

/** The failing field's published sub-schema and the kind's field names, at most about 1.5 KB. */
export const expectedFor = (kind: Kind | undefined, field: string | undefined): Record<string, unknown> => {
  const option = kind === undefined ? undefined : kindOptions.get(kind)
  if (option === undefined) return { edits: [...kindOptions.keys()] }
  const published = publishedInputSchema(option) as { properties?: Record<string, unknown> }
  const fields = Object.keys(published.properties ?? {})
  const sub = field === undefined ? undefined : published.properties?.[field]
  const subText = sub === undefined ? '' : JSON.stringify(sub)
  return {
    edit: kind, fields,
    ...(field === undefined ? {} : { field }),
    ...(sub === undefined ? {} : subText.length <= 1_200 ? { schema: sub } : { schema: { description: (sub as { description?: string }).description ?? field, note: 'read the whole schema with workspace_explore includeInputSchema' } }),
  }
}

const invalid = (index: number, kind: Kind, field: string | undefined, message: string): never => {
  throw planningError(400, 'invalid_request', `Edit ${index + 1} (${kind}): ${message}`, { edit: index, expected: expectedFor(kind, field) })
}
const unknown = (index: number | undefined, about: readonly string[], message: string): never => {
  throw planningError(400, 'unknown_reference', message, { ...(index === undefined ? {} : { edit: index }), about: about.slice(0, 4) })
}

// ───────────── helpers ─────────────

/** Any offset in, UTC out, in the plan's compact form. */
export const utc = (instant: string): string => new Date(instant).toISOString().replace('.000Z', 'Z')
const period = (value: { readonly start: string; readonly end: string }) => ({ start: utc(value.start), end: utc(value.end) })
const sourceOf = (given: Source | undefined): Source => given === undefined ? { by: 'planner' } : { by: given.by, ...(given.note === undefined ? {} : { note: given.note }) }
const same = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right)

/** Sets a field from an edit: undefined keeps it, null clears it, anything else replaces it. */
const assign = <T extends object, K extends keyof T>(target: T, field: K, value: T[K] | null | undefined, fields: string[], name = String(field)): void => {
  if (value === undefined) return
  if (value === null) {
    if (field in target) { delete target[field]; fields.push(name) }
    return
  }
  if (!same(target[field], value)) { target[field] = value; fields.push(name) }
}

/** Equipment a hard rule or a span-limited group covers: removing or loosening its coverage needs authority. */
const ruledEquipment = (inputs: Inputs): ReadonlySet<string> => {
  const ruledGroups = new Set(inputs.rules.flatMap(rule => rule.kind === 'span-limit' ? [rule.group] : []))
  return new Set([
    ...inputs.rules.flatMap(rule => rule.kind === 'protected' ? rule.equipment : rule.kind === 'keep-in-service' ? rule.members.flatMap(member => 'equipment' in member ? [member.equipment] : []) : []),
    ...inputs.equipment.filter(item => item.group !== undefined && ruledGroups.has(item.group)).map(item => item.key),
  ])
}
/** Adversary item 8: equipment a rule names or a group holds. */
const coveredEquipment = (inputs: Inputs): ReadonlySet<string> =>
  new Set([...ruledEquipment(inputs), ...inputs.equipment.filter(item => item.group !== undefined).map(item => item.key)])

/** A World value read now whose unit Planning cannot convert is refused, naming the unit. */
const refuseUnconvertible = (index: number, kind: Kind, field: string, refs: readonly WorldRef[], inputs: Inputs, unit: string): void => {
  const combined = combineWorldFacts(refs, inputs.world.facts, unit)
  if (!combined.ok && (combined.code === 'unit_unknown' || combined.code === 'unit_mismatch' || combined.code === 'world_value_not_number')) {
    invalid(index, kind, field, combined.code === 'world_value_not_number'
      ? `World value ${combined.ref.fact} is not a number with a unit`
      : `World value ${combined.ref.fact} is in "${combined.unit}", which cannot be used as ${unit}`)
  }
}

// ───────────── the kinds ─────────────

interface Working {
  readonly next: Inputs
  readonly changes: ChangeRecord[]
  readonly weakens: Weakening[]
  readonly touchedTests: Set<string>
  /** The plan's drafted brackets, as the edits leave them (Plan.drafts). */
  readonly drafts: Set<string>
  /** Brackets drafted by this edit list, and those a later edit in the list then changed. */
  readonly drafted: Set<string>
  readonly draftsEdited: Set<string>
  runChanged: boolean
}

const record = (state: Working, verb: ChangeRecord['verb'], what: ChangeRecord['what'], key: string, fields: readonly string[]): void => {
  if (verb === 'changed' && fields.length === 0) return
  state.changes.push({ verb, what, key, fields: [...fields] })
}

const needField = <T>(value: T | undefined | null, index: number, kind: Kind, field: string, key: string): T => {
  if (value === undefined || value === null) return invalid(index, kind, field, `a new ${kind} "${key}" needs ${field}`)
  return value
}

/**
 * Availability for the whole window follows the window (walk 3, R3-1): a calendar that is exactly the old
 * window (one period, no weekly hours, no exceptions) becomes the new window in the same edit. Shifts and
 * partial periods stay where they are.
 */
const moveWholeWindowCalendars = (state: Working, before: Inputs['settings']['window'], after: Inputs['settings']['window']): void => {
  if (before === null || after === null || (before.start === after.start && before.end === after.end)) return
  const same = (left: { readonly start: string; readonly end: string }, right: { readonly start: string; readonly end: string }) =>
    Date.parse(left.start) === Date.parse(right.start) && Date.parse(left.end) === Date.parse(right.end)
  for (const calendar of state.next.calendars) {
    if (calendar.weekly.length > 0 || calendar.except.length > 0 || calendar.periods.length !== 1 || !same(calendar.periods[0]!, before)) continue
    calendar.periods = [{ start: after.start, end: after.end }]
    record(state, 'changed', 'calendar', calendar.key, ['moved with the plan window'])
  }
}

const editPlan = (state: Working, edit: EditOf<'plan'>, context: EditContext): void => {
  const settings = state.next.settings
  const fields: string[] = []
  assign(settings, 'title', edit.title, fields)
  assign(settings, 'purpose', edit.purpose, fields)
  assign(settings, 'timeZone', edit.timeZone, fields)
  const before = settings.window
  assign(settings, 'window', edit.window === undefined ? undefined : period(edit.window), fields)
  moveWholeWindowCalendars(state, before, settings.window)
  assign(settings, 'dataDate', edit.dataDate === undefined ? undefined : utc(edit.dataDate), fields)
  if (edit.run !== undefined && edit.run !== (settings.run?.id ?? null)) {
    settings.run = edit.run === null ? null : { id: edit.run, linkedAt: utc(context.now) }
    // The copies describe the previous Run; the next refresh reads the new one.
    if (state.next.world.refreshedAt !== null || state.next.world.facts.length > 0) {
      state.next.world = { refreshedAt: null, facts: [] }
      fields.push('world values cleared')
    }
    state.runChanged = true
    fields.push('run')
  }
  record(state, 'changed', 'plan', 'plan', fields)
}

const editEquipment = (state: Working, edit: EditOf<'equipment'>, index: number): void => {
  const { next } = state
  const existing = next.equipment.find(item => item.key === edit.key)
  const ruled = ruledEquipment(next)
  const fields: string[] = []
  const item: Equipment = existing ?? { key: edit.key, label: needField(edit.label, index, 'equipment', 'label', edit.key), supportedBy: [] }
  assign(item, 'label', edit.label, fields)
  if (edit.group !== undefined && existing?.group !== undefined && edit.group !== existing.group && ruled.has(edit.key)) {
    state.weakens.push({ code: 'needs_authority', edit: index, about: [edit.key, existing.group], what: 'group' })
  }
  assign(item, 'group', edit.group, fields)
  if (edit.groupLabel !== undefined) {
    const group = item.group ?? invalid(index, 'equipment', 'groupLabel', 'groupLabel names the group given in group')
    const known = next.groups.find(entry => entry.key === group)
    if (known === undefined) { next.groups.push({ key: group, label: edit.groupLabel }); record(state, 'added', 'group', group, []) }
    else if (known.label !== edit.groupLabel) { known.label = edit.groupLabel; record(state, 'changed', 'group', group, ['label']) }
  }
  if (edit.supportedBy !== undefined) {
    const removed = item.supportedBy.filter(key => !edit.supportedBy!.includes(key))
    if (existing !== undefined && removed.length > 0) state.weakens.push({ code: 'needs_authority', edit: index, about: [edit.key, ...removed], what: 'support' })
    assign(item, 'supportedBy', [...new Set(edit.supportedBy)], fields)
  }
  // A function key says which items back each other up; changing or clearing it on covered equipment weakens that.
  if (edit.function !== undefined && existing?.function !== undefined && edit.function !== existing.function && ruled.has(edit.key)) {
    state.weakens.push({ code: 'needs_authority', edit: index, about: [edit.key, existing.function], what: 'function' })
  }
  assign(item, 'function', edit.function, fields)
  assign(item, 'source', edit.source === undefined ? undefined : sourceOf(edit.source), fields)
  // Protection and coverage bind to the World item through its locator: re-pointing covered equipment weakens them.
  if (existing !== undefined && edit.locator !== undefined && edit.locator !== (existing.locator ?? null) && existing.locator !== undefined && coveredEquipment(next).has(edit.key)) {
    state.weakens.push({ code: 'needs_authority', edit: index, about: [edit.key], what: 'locator' })
  }
  assign(item, 'locator', edit.locator, fields)
  if (existing === undefined) { next.equipment.push(item); record(state, 'added', 'equipment', edit.key, []) }
  else record(state, 'changed', 'equipment', edit.key, fields)
}

const editCalendar = (state: Working, edit: EditOf<'calendar'>, index: number): void => {
  const existing = state.next.calendars.find(entry => entry.key === edit.key)
  const fields: string[] = []
  const calendar = existing ?? { key: edit.key, label: needField(edit.label, index, 'calendar', 'label', edit.key), weekly: [], periods: [], except: [], source: sourceOf(edit.source) }
  assign(calendar, 'label', edit.label, fields)
  assign(calendar, 'weekly', edit.weekly, fields)
  assign(calendar, 'periods', edit.periods?.map(period), fields)
  assign(calendar, 'except', edit.except?.map(period), fields)
  if (existing !== undefined) assign(calendar, 'source', edit.source === undefined ? undefined : sourceOf(edit.source), fields)
  if (existing === undefined) { state.next.calendars.push(calendar); record(state, 'added', 'calendar', edit.key, []) }
  else record(state, 'changed', 'calendar', edit.key, fields)
}

const editResource = (state: Working, edit: EditOf<'resource'>, index: number): void => {
  const existing = state.next.resources.find(entry => entry.key === edit.key)
  const fields: string[] = []
  const resource: Resource = existing ?? {
    key: edit.key,
    label: needField(edit.label, index, 'resource', 'label', edit.key),
    kind: needField(edit.kind, index, 'resource', 'kind', edit.key),
    count: needField(edit.count, index, 'resource', 'count', edit.key),
    calendar: needField(edit.calendar, index, 'resource', 'calendar', edit.key),
    attributes: [],
    source: sourceOf(edit.source),
  }
  assign(resource, 'label', edit.label, fields)
  assign(resource, 'kind', edit.kind, fields)
  assign(resource, 'count', edit.count, fields)
  assign(resource, 'crewSize', edit.crewSize, fields)
  assign(resource, 'calendar', edit.calendar, fields)
  if (edit.attributes !== undefined) {
    const attributes = edit.attributes.map(attribute => {
      // A World value is never stored: it is computed from inputs.world.facts, which only refresh writes.
      const origin: Origin = attribute.fromWorld !== undefined ? { by: 'world', refs: [attribute.fromWorld] } : sourceOf(attribute.source)
      if (attribute.fromWorld !== undefined) refuseUnconvertible(index, 'resource', 'attributes', [attribute.fromWorld], state.next, attribute.unit)
      const value = attribute.fromWorld !== undefined ? null : attribute.value ?? invalid(index, 'resource', 'attributes', `attribute ${attribute.key} needs a value or World values`)
      return { key: attribute.key, label: attribute.label, value, unit: attribute.unit, changes: (attribute.changes ?? []).map(change => ({ at: utc(change.at), value: change.value })), origin }
    })
    assign(resource, 'attributes', attributes, fields)
  }
  assign(resource, 'maxJobs', edit.maxJobs, fields)
  assign(resource, 'locator', edit.locator, fields)
  if (existing !== undefined) assign(resource, 'source', edit.source === undefined ? undefined : sourceOf(edit.source), fields)
  if (existing === undefined) { state.next.resources.push(resource); record(state, 'added', 'resource', edit.key, []) }
  else record(state, 'changed', 'resource', edit.key, fields)
}

const editPurchase = (state: Working, edit: EditOf<'purchase'>, index: number, context: EditContext): void => {
  const existing = state.next.purchases.find(entry => entry.key === edit.key)
  const fields: string[] = []
  if (edit.calendar != null && edit.periods != null) invalid(index, 'purchase', 'periods', 'a purchase adds either a weekly calendar or one-off periods, not both')
  const adds: Purchase['adds'] | undefined = edit.calendar != null ? { calendar: edit.calendar } : edit.periods != null ? { periods: edit.periods.map(period) } : undefined
  const purchase: Purchase = existing ?? {
    key: edit.key,
    label: needField(edit.label, index, 'purchase', 'label', edit.key),
    resource: needField(edit.resource, index, 'purchase', 'resource', edit.key),
    adds: needField(adds, index, 'purchase', 'calendar', edit.key),
    replaces: [], price: {},
    allowed: needField(edit.allowed, index, 'purchase', 'allowed', edit.key),
  }
  assign(purchase, 'label', edit.label, fields)
  assign(purchase, 'resource', edit.resource, fields)
  if (adds !== undefined) assign(purchase, 'adds', adds, fields)
  else if ((edit.calendar === null && 'calendar' in purchase.adds) || (edit.periods === null && 'periods' in purchase.adds)) {
    invalid(index, 'purchase', 'calendar', 'a purchase must add a calendar or periods; give the other in the same edit')
  }
  assign(purchase, 'replaces', edit.replaces?.map(period), fields)
  const price = { ...purchase.price }
  const priceFields: string[] = []
  assign(price, 'perPersonHour', edit.perPersonHour, priceFields)
  assign(price, 'perPeriodUsed', edit.perPeriodUsed, priceFields)
  assign(price, 'once', edit.once, priceFields)
  if (priceFields.length > 0) { purchase.price = price; fields.push(...priceFields) }
  assign(purchase, 'orderBy', edit.orderBy === undefined || edit.orderBy === null ? edit.orderBy : utc(edit.orderBy), fields)
  if (edit.ordered === true && purchase.ordered === undefined) { purchase.ordered = { at: utc(context.now), by: { ...context.by } }; fields.push('ordered') }
  if (edit.ordered === false && purchase.ordered !== undefined) { delete purchase.ordered; fields.push('ordered') }
  assign(purchase, 'allowed', edit.allowed, fields)
  if (existing === undefined) { state.next.purchases.push(purchase); record(state, 'added', 'purchase', edit.key, []) }
  else record(state, 'changed', 'purchase', edit.key, fields)
}

const editMethod = (state: Working, edit: EditOf<'method'>, index: number): void => {
  const existing = state.next.methods.find(entry => entry.key === edit.key)
  const fields: string[] = []
  const method = existing ?? { key: edit.key, label: needField(edit.label, index, 'method', 'label', edit.key), options: needField(edit.options, index, 'method', 'options', edit.key) }
  assign(method, 'label', edit.label, fields)
  if (edit.options !== undefined) {
    const options = edit.options.map(option => {
      const words = existing?.options.find(old => old.key === option.key)?.words
      return { key: option.key, label: option.label, fixedCost: option.fixedCost, ...(words === undefined ? {} : { words }) }
    })
    assign(method, 'options', options, fields)
  }
  if (existing === undefined) { state.next.methods.push(method); record(state, 'added', 'method', edit.key, []) }
  else record(state, 'changed', 'method', edit.key, fields)
}

type DurationEdit = NonNullable<EditOf<'job'>['duration']>
const applyDuration = (index: number, current: Job['duration'] | undefined, edit: DurationEdit, inputs: Inputs, key: string): Job['duration'] => {
  if (edit.value !== undefined && edit.fromWorld != null) invalid(index, 'job', 'duration', 'a duration is a value or World values, not both')
  const unit = edit.unit ?? current?.unit ?? invalid(index, 'job', 'duration', `job "${key}" needs a duration unit`)
  const calendar = edit.calendar ?? current?.calendar ?? invalid(index, 'job', 'duration', `job "${key}" needs a duration calendar (working or elapsed)`)
  let value: number | null
  let origin: Origin
  if (edit.fromWorld != null) {
    if (edit.source !== undefined) invalid(index, 'job', 'duration', 'a World duration takes its source from World')
    refuseUnconvertible(index, 'job', 'duration', edit.fromWorld, inputs, unit)
    origin = { by: 'world', refs: edit.fromWorld }
    value = null
  } else if (edit.value !== undefined) {
    origin = sourceOf(edit.source)
    value = edit.value
  } else if (edit.fromWorld === null || current === undefined) {
    return invalid(index, 'job', 'duration', `job "${key}" needs an estimate: how long is it, and who says so?`)
  } else if (edit.source !== undefined) {
    if (current.origin.by === 'world') invalid(index, 'job', 'duration', 'a World duration takes its source from World; give a value to replace it')
    origin = sourceOf(edit.source)
    value = current.value
  } else {
    origin = current.origin
    value = current.value
  }
  const range = edit.range === null ? undefined : edit.range ?? current?.range
  return { value, unit, calendar, ...(range === undefined ? {} : { range }), origin }
}

const editJob = (state: Working, edit: EditOf<'job'>, index: number): void => {
  const { next } = state
  const existing = next.jobs.find(job => job.key === edit.key)
  const covered = coveredEquipment(next)
  const fields: string[] = []
  const kind = edit.kind ?? existing?.kind ?? invalid(index, 'job', 'kind', `a new job "${edit.key}" needs kind`)
  const isolation = edit.isolation ?? existing?.isolation ?? (kind === 'work' ? invalid(index, 'job', 'isolation', `work "${edit.key}" needs isolation: inside (on the tagged-out item) or none`) : 'none')
  const job: Job = existing ?? {
    key: edit.key,
    title: needField(edit.title, index, 'job', 'title', edit.key),
    kind, equipment: [], isolation,
    duration: applyDuration(index, undefined, needField(edit.duration, index, 'job', 'duration', edit.key), next, edit.key),
    durationWith: [], needs: [], continuous: false, checks: [], tags: [],
  }
  const before = existing === undefined ? undefined : structuredClone(existing)
  assign(job, 'title', edit.title, fields)
  assign(job, 'kind', edit.kind, fields)
  assign(job, 'equipment', edit.equipment === undefined ? undefined : [...new Set(edit.equipment)], fields)
  assign(job, 'isolation', edit.isolation, fields)
  if (existing !== undefined && edit.duration !== undefined) assign(job, 'duration', applyDuration(index, job.duration, edit.duration, next, edit.key), fields)
  if (edit.minimum !== undefined) {
    const old = job.minimum
    if (existing !== undefined && old !== undefined && (edit.minimum === null || durationMs(edit.minimum.value, edit.minimum.unit) < durationMs(old.value, old.unit))) {
      state.weakens.push({ code: 'needs_authority', edit: index, about: [edit.key], what: 'minimum' })
    }
    assign(job, 'minimum', edit.minimum, fields)
  }
  if (edit.needs !== undefined) {
    assign(job, 'needs', edit.needs.map(need => ({
      anyOf: [...new Set(need.anyOf)], amount: need.amount ?? 1, ...(need.where === undefined ? {} : { where: need.where }), handover: need.handover ?? false,
    })), fields)
  }
  if (edit.durationWith !== undefined) {
    const entries = (edit.durationWith ?? []).map(entry => {
      if ((entry.value === undefined) === (entry.fromWorld === undefined)) invalid(index, 'job', 'durationWith', `durationWith for ${entry.resource} is a value or World values`)
      const source = entry.source === undefined ? {} : { source: sourceOf(entry.source) }
      if (entry.fromWorld !== undefined) refuseUnconvertible(index, 'job', 'durationWith', entry.fromWorld, next, job.duration.unit)
      return entry.fromWorld !== undefined ? { resource: entry.resource, refs: entry.fromWorld, ...source } : { resource: entry.resource, value: entry.value!, ...source }
    })
    assign(job, 'durationWith', entries, fields)
  }
  assign(job, 'continuous', edit.continuous, fields)
  assign(job, 'method', edit.method, fields)
  assign(job, 'notBefore', edit.notBefore === undefined || edit.notBefore === null ? edit.notBefore : { at: utc(edit.notBefore.at), words: edit.notBefore.words, source: sourceOf(edit.notBefore.source) }, fields)
  assign(job, 'target', edit.target === undefined || edit.target === null ? edit.target : { finishBy: utc(edit.target.finishBy), words: edit.target.words }, fields)
  if (existing !== undefined && edit.checks !== undefined) {
    const kept = new Set(edit.checks.map(check => JSON.stringify(check)))
    const dropped = job.checks.filter(check => !kept.has(JSON.stringify(check)))
    if (dropped.length > 0) state.weakens.push({ code: 'needs_authority', edit: index, about: [edit.key, ...dropped.map(check => check.equipment)].slice(0, 4), what: 'precondition' })
  }
  assign(job, 'checks', edit.checks, fields)
  assign(job, 'lock', edit.lock === undefined || edit.lock === null ? edit.lock : { start: utc(edit.lock) }, fields)
  assign(job, 'tags', edit.tags === undefined ? undefined : [...new Set(edit.tags)], fields)
  assign(job, 'locator', edit.locator, fields)

  if (before !== undefined) {
    const touched = [...new Set([...before.equipment, ...job.equipment])].filter(key => covered.has(key))
    if (before.kind !== job.kind && touched.length > 0) state.weakens.push({ code: 'needs_authority', edit: index, about: [edit.key, ...touched], what: 'job-kind' })
    if (before.isolation === 'inside' && job.isolation === 'none' && touched.length > 0) state.weakens.push({ code: 'needs_authority', edit: index, about: [edit.key, ...touched], what: 'isolation' })
    const dropped = before.equipment.filter(key => !job.equipment.includes(key) && covered.has(key))
    if (before.kind !== 'work' && dropped.length > 0) state.weakens.push({ code: 'needs_authority', edit: index, about: [edit.key, ...dropped], what: 'covering-equipment' })
  }
  if (job.kind === 'test' && (edit.duration !== undefined || edit.durationWith !== undefined || edit.minimum !== undefined || edit.kind !== undefined || existing === undefined)) state.touchedTests.add(job.key)
  if (existing === undefined) { next.jobs.push(job); record(state, 'added', 'job', edit.key, []) }
  else record(state, 'changed', 'job', edit.key, fields)
}

const linkLabel = (link: { readonly from: string; readonly to: string; readonly type: string }) => `${link.from} ${link.type} ${link.to}`

const editLink = (state: Working, edit: EditOf<'link'>): void => {
  const existing = state.next.links.find(link => link.from === edit.from && link.to === edit.to && link.type === edit.type)
  const fields: string[] = []
  const link = existing ?? { from: edit.from, to: edit.to, type: edit.type, lag: edit.lag ?? { value: 0, unit: 'h' as const } }
  assign(link, 'lag', edit.lag, fields)
  assign(link, 'method', edit.method, fields)
  if (existing === undefined) { state.next.links.push(link); record(state, 'added', 'link', linkLabel(link), []) }
  else record(state, 'changed', 'link', linkLabel(link), fields)
}

const ruleFields = {
  protected: ['equipment'],
  'keep-in-service': ['members', 'atLeast', 'during'],
  'span-limit': ['group', 'limit', 'singleEntry'],
  due: ['job', 'finishBy'],
} as const

const editRule = (state: Working, edit: EditOf<'rule'>, index: number): void => {
  const { next } = state
  const existing = next.rules.find(rule => rule.key === edit.key)
  const kind = edit.kind ?? existing?.kind ?? invalid(index, 'rule', 'kind', `a new rule "${edit.key}" needs kind`)
  for (const [ruleKind, names] of Object.entries(ruleFields)) {
    if (ruleKind === kind) continue
    for (const name of names) if (edit[name as keyof typeof edit] !== undefined) invalid(index, 'rule', name, `${name} belongs to ${ruleKind} rules, not ${kind}`)
  }
  const base = existing?.kind === kind ? existing : undefined
  const words = edit.words ?? existing?.words ?? invalid(index, 'rule', 'words', `rule "${edit.key}" needs words: the rule in plain language`)
  const source: Source = edit.source !== undefined ? sourceOf(edit.source) : existing?.source ?? { by: 'planner' }
  const field = <T>(given: T | undefined, current: T | undefined, name: string): T => given ?? current ?? invalid(index, 'rule', name, `a ${kind} rule needs ${name}`)
  let rule: Rule
  if (kind === 'protected') {
    rule = { kind, key: edit.key, equipment: [...new Set(field(edit.equipment, base?.kind === 'protected' ? base.equipment : undefined, 'equipment'))], words, source }
  } else if (kind === 'keep-in-service') {
    const current = base?.kind === 'keep-in-service' ? base : undefined
    const members = edit.members === undefined ? field(undefined, current?.members, 'members') : [...new Set(edit.members)].map(key => {
      const isEquipment = next.equipment.some(item => item.key === key)
      const isResource = next.resources.some(resource => resource.key === key)
      if (isEquipment && isResource) invalid(index, 'rule', 'members', `${key} names both equipment and a crew or tool`)
      if (!isEquipment && !isResource) unknown(index, [key], `Rule ${edit.key} names ${key}, which is neither equipment nor a crew or tool in this plan`)
      return isEquipment ? { equipment: key } : { resource: key }
    })
    const during = edit.during === null ? undefined : edit.during === undefined ? current?.during : period(edit.during)
    rule = { kind, key: edit.key, members, atLeast: field(edit.atLeast, current?.atLeast, 'atLeast'), ...(during === undefined ? {} : { during }), words, source }
  } else if (kind === 'due') {
    const current = base?.kind === 'due' ? base : undefined
    rule = { kind, key: edit.key, job: field(edit.job, current?.job, 'job'), finishBy: edit.finishBy === undefined ? field(undefined, current?.finishBy, 'finishBy') : utc(edit.finishBy), words, source }
  } else {
    const current = base?.kind === 'span-limit' ? base : undefined
    rule = { kind, key: edit.key, group: field(edit.group, current?.group, 'group'), limit: field(edit.limit, current?.limit, 'limit'), singleEntry: field(edit.singleEntry, current?.singleEntry, 'singleEntry'), words, source }
  }
  if (existing === undefined) {
    next.rules.push(rule)
    record(state, 'added', 'rule', edit.key, [])
    return
  }
  if (same(existing, rule)) return
  const fields = Object.keys({ ...existing, ...rule }).filter(name => !same((existing as Record<string, unknown>)[name], (rule as Record<string, unknown>)[name]))
  state.weakens.push({ code: 'needs_authority', edit: index, about: [edit.key], what: 'rule' })
  next.rules[next.rules.indexOf(existing)] = rule
  record(state, 'changed', 'rule', edit.key, fields)
}

const editGoals = (state: Working, edit: EditOf<'goals'>): void => {
  if (same(state.next.goals, edit.goals)) return
  state.next.goals = structuredClone(edit.goals)
  record(state, 'changed', 'goals', 'goals', ['order'])
}

const editRemove = (state: Working, edit: EditOf<'remove'>, index: number, context: EditContext): void => {
  const { next } = state
  if (edit.what === 'link') {
    if (edit.from === undefined || edit.to === undefined || edit.type === undefined) return invalid(index, 'remove', 'from', 'a link is named by from, to and type')
    const at = next.links.findIndex(link => link.from === edit.from && link.to === edit.to && link.type === edit.type)
    if (at < 0) unknown(index, [edit.from, edit.to], `No ${edit.type} link from ${edit.from} to ${edit.to}`)
    next.links.splice(at, 1)
    record(state, 'removed', 'link', linkLabel(edit as { from: string; to: string; type: string }), [])
    return
  }
  const key = edit.key ?? invalid(index, 'remove', 'key', `removing ${edit.what} needs its key`)
  const collection = ({
    equipment: next.equipment, group: next.groups, calendar: next.calendars, resource: next.resources,
    purchase: next.purchases, method: next.methods, job: next.jobs, rule: next.rules,
  } as const)[edit.what] as Array<{ readonly key: string }>
  const at = collection.findIndex(entry => entry.key === key)
  if (at < 0) unknown(index, [key], `No ${edit.what} ${key} in this plan`)
  if (edit.what === 'equipment' && coveredEquipment(next).has(key)) state.weakens.push({ code: 'needs_authority', edit: index, about: [key], what: 'equipment' })
  if (edit.what === 'rule') state.weakens.push({ code: 'needs_authority', edit: index, about: [key], what: 'rule' })
  if (edit.what === 'job') {
    const job = next.jobs[at]!
    const covered = job.equipment.filter(item => coveredEquipment(next).has(item))
    // A bracket Planning drafted, that nobody changed or baselined since, never protected anything (walk 2,
    // R2-2). Draft status is the Module's own list, never anything an edit can write (adversary recheck 1).
    if (job.kind !== 'work' && covered.length > 0 && !state.drafts.has(key)) state.weakens.push({ code: 'needs_authority', edit: index, about: [key, ...covered], what: 'covering-job' })
    state.drafts.delete(key)
    const links = next.links.filter(link => link.from === key || link.to === key)
    next.links = next.links.filter(link => !links.includes(link))
    for (const link of links) record(state, 'removed', 'link', linkLabel(link), [])
  }
  collection.splice(at, 1)
  record(state, 'removed', edit.what, key, [])
}

// ───────────── the whole result ─────────────

const duplicates = (keys: readonly string[]): readonly string[] => keys.filter((key, at) => keys.indexOf(key) !== at)

/** Every key a plan names resolves; supports have no cycle. Throws unknown_reference naming the first gap. */
export const checkReferences = (inputs: Inputs): void => {
  const keys = (list: ReadonlyArray<{ readonly key: string }>) => new Set(list.map(entry => entry.key))
  const equipment = keys(inputs.equipment), groups = keys(inputs.groups), calendars = keys(inputs.calendars)
  const resources = keys(inputs.resources), jobs = keys(inputs.jobs)
  const missing = (owner: string, key: string, set: ReadonlySet<string>, what: string): void => {
    if (!set.has(key)) unknown(undefined, [owner, key], `${owner} names ${what} ${key}, which is not in this plan`)
  }
  for (const [what, list] of [['equipment', inputs.equipment], ['group', inputs.groups], ['calendar', inputs.calendars], ['crew or tool', inputs.resources],
    ['purchase', inputs.purchases], ['method', inputs.methods], ['job', inputs.jobs], ['rule', inputs.rules]] as const) {
    const repeated = duplicates((list as ReadonlyArray<{ readonly key: string }>).map(entry => entry.key))
    if (repeated.length > 0) throw planningError(400, 'invalid_request', `Two ${what} entries share the key ${repeated[0]}`, { about: [repeated[0]] })
  }
  const linkKeys = inputs.links.map(linkLabel)
  if (duplicates(linkKeys).length > 0) throw planningError(400, 'invalid_request', `The link ${duplicates(linkKeys)[0]} appears twice`, {})
  const methodOption = (owner: string, method: { readonly choice: string; readonly option: string } | undefined): void => {
    if (method === undefined) return
    const choice = inputs.methods.find(entry => entry.key === method.choice)
    if (choice === undefined) unknown(undefined, [owner, method.choice], `${owner} names method ${method.choice}, which is not in this plan`)
    if (!choice!.options.some(option => option.key === method.option)) unknown(undefined, [owner, method.option], `${owner} names option ${method.option} of ${method.choice}, which it does not have`)
  }
  // One World item is one piece of equipment, so protection and coverage cannot be sidestepped by a second key.
  const located = inputs.equipment.flatMap(item => item.locator === undefined ? [] : [item])
  for (const [at, item] of located.entries()) {
    const twin = located.slice(at + 1).find(other => other.locator === item.locator)
    if (twin !== undefined) throw planningError(400, 'invalid_request', `${item.key} and ${twin.key} name the same World item; one World item is one piece of equipment`, { about: [item.key, twin.key] })
  }
  for (const item of inputs.equipment) {
    if (item.group !== undefined) missing(item.key, item.group, groups, 'group')
    for (const supporter of item.supportedBy) {
      if (supporter === item.key) unknown(undefined, [item.key], `${item.key} cannot support itself`)
      missing(item.key, supporter, equipment, 'supporting equipment')
    }
  }
  const supporters = new Map(inputs.equipment.map(item => [item.key, item.supportedBy]))
  const visiting = new Set<string>(), done = new Set<string>()
  const walk = (key: string, path: readonly string[]): void => {
    if (done.has(key)) return
    if (visiting.has(key)) throw planningError(400, 'invalid_request', `Supports form a cycle: ${[...path, key].join(' → ')}`, { about: path.slice(-4) })
    visiting.add(key)
    for (const next of supporters.get(key) ?? []) walk(next, [...path, key])
    visiting.delete(key)
    done.add(key)
  }
  for (const item of inputs.equipment) walk(item.key, [])
  for (const resource of inputs.resources) missing(resource.key, resource.calendar, calendars, 'calendar')
  for (const purchase of inputs.purchases) {
    missing(purchase.key, purchase.resource, resources, 'crew or tool')
    if ('calendar' in purchase.adds) missing(purchase.key, purchase.adds.calendar, calendars, 'calendar')
  }
  for (const job of inputs.jobs) {
    for (const item of job.equipment) missing(job.key, item, equipment, 'equipment')
    if (job.kind === 'work' && job.equipment.length > 1) throw planningError(400, 'invalid_request', `Work ${job.key} is on one item at most; split it per item`, { about: [job.key] })
    for (const need of job.needs) {
      for (const resource of need.anyOf) missing(job.key, resource, resources, 'crew or tool')
      if (need.where !== undefined && !inputs.resources.some(resource => need.anyOf.includes(resource.key) && resource.attributes.some(attribute => attribute.key === need.where!.attribute))) {
        unknown(undefined, [job.key, need.where.attribute], `${job.key} asks for ${need.where.attribute}, which none of its crews or tools has`)
      }
    }
    for (const entry of job.durationWith) missing(job.key, entry.resource, resources, 'crew or tool')
    for (const check of job.checks) missing(job.key, check.equipment, equipment, 'equipment')
    methodOption(job.key, job.method)
  }
  for (const link of inputs.links) {
    missing(linkLabel(link), link.from, jobs, 'job')
    missing(linkLabel(link), link.to, jobs, 'job')
    if (link.from === link.to) unknown(undefined, [link.from], `A link from ${link.from} to itself has no meaning`)
    methodOption(linkLabel(link), link.method)
  }
  for (const rule of inputs.rules) {
    if (rule.kind === 'protected') for (const item of rule.equipment) missing(rule.key, item, equipment, 'equipment')
    if (rule.kind === 'keep-in-service') for (const member of rule.members) {
      if ('equipment' in member) missing(rule.key, member.equipment, equipment, 'equipment')
      else missing(rule.key, member.resource, resources, 'crew or tool')
    }
    if (rule.kind === 'span-limit') missing(rule.key, rule.group, groups, 'group')
    if (rule.kind === 'due') missing(rule.key, rule.job, jobs, 'job')
  }
  for (const goal of inputs.goals) for (const group of goal.scope?.groups ?? []) missing('a goal', group, groups, 'group')
}

/** Jobs that name protected equipment: refused whatever the authority. */
export const protectedJobs = (inputs: Inputs): ReadonlyArray<{ readonly job: string; readonly equipment: string; readonly rule: string }> =>
  inputs.rules.flatMap(rule => rule.kind !== 'protected' ? [] : inputs.jobs.flatMap(job =>
    job.equipment.filter(item => rule.equipment.includes(item)).map(item => ({ job: job.key, equipment: item, rule: rule.key }))))

/**
 * Every duration a test may run with, by whatever path sets it: its own, each `durationWith` entry, and a
 * World value once read. A World value not read yet is not a duration (Generate refuses it as unread).
 */
export const effectiveDurations = (inputs: Inputs, job: Inputs['jobs'][number]): ReadonlyArray<{ readonly path: string; readonly ms: number; readonly by: 'person' | 'world' }> => {
  const world = (refs: readonly WorldRef[]) => {
    const combined = combineWorldFacts(refs, inputs.world.facts, job.duration.unit)
    return combined.ok ? durationMs(combined.value, job.duration.unit) : undefined
  }
  const own = job.duration.origin.by === 'world' ? world(job.duration.origin.refs) : durationMs(job.duration.value!, job.duration.unit)
  return [
    ...(own === undefined ? [] : [{ path: 'duration', ms: own, by: job.duration.origin.by === 'world' ? 'world' as const : 'person' as const }]),
    ...job.durationWith.flatMap(entry => {
      const ms = 'refs' in entry ? world(entry.refs) : durationMs(entry.value, job.duration.unit)
      return ms === undefined ? [] : [{ path: `durationWith ${entry.resource}`, ms, by: 'refs' in entry ? 'world' as const : 'person' as const }]
    }),
  ]
}

/** Tests that can run shorter than their declared minimum, by any path. */
export const belowMinimum = (inputs: Inputs, by?: 'person' | 'world'): ReadonlyArray<string> => inputs.jobs.filter(job =>
  job.kind === 'test' && job.minimum !== undefined
  && effectiveDurations(inputs, job).some(duration => (by === undefined || duration.by === by) && duration.ms < durationMs(job.minimum!.value, job.minimum!.unit))).map(job => job.key)

const draftNote = 'Drafted with the work on '
/** The draft duration of a bracketing job: stated as an assumption for the planner to change. */
const draftDuration = (label: string): Job['duration'] => ({ value: 1, unit: 'h', calendar: 'working', origin: { by: 'assumption', note: `${draftNote}${label}; set its real duration` } })

/**
 * Work on equipment is bracketed by its tag-out before and its return-to-service test after (the approved
 * plan). Inside work a job edit creates or changes on equipment with no tag-out or no test gets the missing
 * draft job(s) right after that edit, as assumptions the planner can change, so a later edit in the same
 * list can name a draft (for example to give it a crew).
 */
const draftBrackets = (state: Working, key: string): void => {
  const { next } = state
  const free = (base: string): string => {
    let candidate = base
    for (let n = 2; next.jobs.some(job => job.key === candidate); n += 1) candidate = `${base.slice(0, 60)}-${n}`
    return candidate
  }
  const work = next.jobs.find(job => job.key === key)
  if (work === undefined || work.kind !== 'work' || work.isolation !== 'inside') return
  for (const item of work.equipment) {
    const label = next.equipment.find(entry => entry.key === item)?.label ?? item
    const draft = (kind: 'tag-out' | 'test', base: string, title: string): void => {
      if (next.jobs.some(job => job.kind === kind && job.equipment.includes(item))) return
      const drafted = free(base)
      next.jobs.push({ key: drafted, title, kind, equipment: [item], isolation: 'none', duration: draftDuration(label), durationWith: [], needs: [], continuous: false, checks: [], tags: [] })
      state.drafted.add(drafted)
      state.drafts.add(drafted)
      state.changes.push({ verb: 'added', what: 'job', key: drafted, fields: ['drafted'] })
    }
    draft('tag-out', `${item}-TAG`, `Tag out ${label}`)
    draft('test', `${item}-RTS`, `Return ${label} to service and test`)
  }
}

/** A draft of this list made redundant by a bracket a later edit added, and not changed since, is dropped. */
const dropRedundantDrafts = (state: Working): void => {
  const { next } = state
  const redundant = next.jobs.filter(job => state.drafted.has(job.key) && !state.draftsEdited.has(job.key)
    && next.jobs.some(other => other.key !== job.key && !state.drafted.has(other.key) && other.kind === job.kind && job.equipment.every(item => other.equipment.includes(item))))
  if (redundant.length === 0) return
  const keys = new Set(redundant.map(job => job.key))
  for (const key of keys) state.drafts.delete(key)
  next.jobs = next.jobs.filter(job => !keys.has(job.key))
  next.links = next.links.filter(link => !keys.has(link.from) && !keys.has(link.to))
  for (let at = state.changes.length - 1; at >= 0; at -= 1) if (state.changes[at]!.what === 'job' && keys.has(state.changes[at]!.key) && state.changes[at]!.fields.includes('drafted')) state.changes.splice(at, 1)
}

/**
 * Applies an edit list to a copy of `inputs`. Refusals throw: invalid_request, unknown_reference,
 * protected_equipment. Weakenings are returned; the caller refuses them without authority (or shows them
 * in a preview).
 */
export const applyEdits = (inputs: Inputs, edits: readonly Edit[], context: EditContext): EditOutcome => {
  const state: Working = { next: structuredClone(inputs), changes: [], weakens: [], touchedTests: new Set(), drafts: new Set(context.drafts ?? []), drafted: new Set(), draftsEdited: new Set(), runChanged: false }
  edits.forEach((edit, index) => {
    switch (edit.edit) {
      case 'plan': return editPlan(state, edit, context)
      case 'equipment': return editEquipment(state, edit, index)
      case 'calendar': return editCalendar(state, edit, index)
      case 'resource': return editResource(state, edit, index)
      case 'purchase': return editPurchase(state, edit, index, context)
      case 'method': return editMethod(state, edit, index)
      case 'job': {
        // Any edit to a draft (duration, crew, minimum or anything else) makes it the planner's job.
        if (state.drafted.has(edit.key)) state.draftsEdited.add(edit.key)
        state.drafts.delete(edit.key)
        editJob(state, edit, index)
        return draftBrackets(state, edit.key)
      }
      case 'link': return editLink(state, edit)
      case 'rule': return editRule(state, edit, index)
      case 'goals': return editGoals(state, edit)
      case 'remove': return editRemove(state, edit, index, context)
    }
  })
  dropRedundantDrafts(state)
  const next = state.next
  checkReferences(next)
  const parsed = planInputsSchema.safeParse(next)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!
    throw planningError(400, 'invalid_request', `The plan would not be valid: ${issue.message} at ${issue.path.join('.')}`, { issues: parsed.error.issues.slice(0, 4).map(entry => ({ path: entry.path.map(String), message: entry.message })) })
  }
  const blocked = protectedJobs(parsed.data)
  if (blocked.length > 0) {
    const first = blocked[0]!
    const words = parsed.data.rules.find(rule => rule.key === first.rule)?.words ?? `${first.equipment} is protected.`
    // No authority lifts this one: protection must be removed first, which needs authority itself.
    throw planningError(409, 'protected_equipment', `${labelled(parsed.data, first.job)} would touch ${labelled(parsed.data, first.equipment)}, which is protected: ${words}`, { about: [first.job, first.equipment, first.rule], rule: words, lift: protectionLift })
  }
  const weakens = [...state.weakens]
  for (const key of belowMinimum(parsed.data, 'person')) {
    if (state.touchedTests.has(key)) weakens.push({ code: 'below_minimum', edit: edits.findLastIndex(edit => edit.edit === 'job' && edit.key === key), about: [key], what: 'below-minimum' })
  }
  const drafts = [...state.drafts].filter(key => parsed.data.jobs.some(job => job.key === key)).sort()
  return { inputs: parsed.data, changes: state.changes, weakens, runChanged: state.runChanged, drafts }
}

/** Who could lift a protection, for the refusal (walk 2, T20): in words, with no plan key. */
export const protectionLift = 'Only removing this protection rule lifts it, and removing the rule needs a named person\'s agreement.'

/** What every authority refusal asks: a named person's agreement, never one the caller makes up. */
export const authorityAsk = 'Name the person who agreed and their reason, as authority. Ask them; never fill this in yourself.'

/**
 * Refuses weakenings that have no authority: below a minimum first, then any other. The refusal carries,
 * for the screen and the Assistant, the rule in planner words and the authority it needs. `inputs` is the
 * plan before the edit, whose rules are the ones being loosened.
 */
export const requireAuthority = (weakens: readonly Weakening[], authority: { readonly name: string; readonly reason: string } | undefined, inputs: Inputs): void => {
  if (authority !== undefined || weakens.length === 0) return
  const needed = { needed: true, ask: authorityAsk }
  const below = weakens.find(weakening => weakening.code === 'below_minimum')
  if (below !== undefined) {
    throw planningError(409, 'below_minimum', `${labelled(inputs, below.about[0] ?? '')} would run shorter than its declared minimum. ${authorityAsk}`, {
      about: below.about, weakens: weakens.map(weakening => weakening.about[0]), rule: weakeningWords(below, inputs), authority: needed,
    })
  }
  const first = weakens[0]!
  throw planningError(409, 'needs_authority', `Edit ${first.edit + 1} loosens a hard rule on ${labelled(inputs, first.about[0] ?? '')}: ${weakeningWords(first, inputs)} ${authorityAsk}`, {
    about: first.about.slice(0, 4), weakens: [...new Set(weakens.flatMap(weakening => weakening.about.slice(0, 1)))].slice(0, 6),
    rule: weakeningWords(first, inputs), authority: needed,
  })
}

/** The exact edit-list schema, for boundary validation of create and edit. */
export const editListSchema = z.array(editSchema)
