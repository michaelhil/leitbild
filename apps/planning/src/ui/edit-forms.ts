// Form fields to edits in the plan's edit vocabulary. Keys are made here from names and never shown.
// A form that cannot become a valid edit says why in planner words; nothing is guessed.
import type { PlanningSubject } from '@leitbild/contracts'
import { editSchema, type Edit } from '../plan/edit-schema.ts'
import type { PlanInputs, Source } from '../plan/schema.ts'
import { isTimeUnit, type TimeUnit } from '../time/units.ts'
import { isTimeZone, localParts, localToInstant, type Weekday } from '../time/zone.ts'

export type Built = { readonly ok: true; readonly edits: readonly Edit[] } | { readonly ok: false; readonly problems: readonly string[] }

const refuse = (...problems: string[]): Built => ({ ok: false, problems })
const done = (...edits: Edit[]): Built => {
  const problems = edits.flatMap(edit => {
    const parsed = editSchema.safeParse(edit)
    return parsed.success ? [] : parsed.error.issues.map(issue => `${issue.path.join(' ') || 'This change'}: ${issue.message}`)
  })
  return problems.length > 0 ? { ok: false, problems } : { ok: true, edits }
}

/** A new plan-local key from a name, unique among `taken`. */
export const keyFor = (name: string, taken: Iterable<string>): string => {
  const used = new Set(taken)
  const base = name.normalize('NFKD').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'item'
  let key = base
  for (let index = 2; used.has(key); index += 1) key = `${base}-${index}`
  return key
}

const allKeys = (inputs: PlanInputs): Set<string> => new Set([
  ...inputs.equipment, ...inputs.groups, ...inputs.calendars, ...inputs.resources, ...inputs.purchases, ...inputs.methods, ...inputs.jobs, ...inputs.rules,
].map(item => item.key))

/** "2026-11-16T07:00" from a datetime-local field, read in `zone`. */
export const localInstant = (text: string, zone: string): string | null => {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(text)
  if (match === null) return null
  const [year, month, day, hour, minute] = match.slice(1).map(Number) as [number, number, number, number, number]
  return new Date(localToInstant(zone, { year, month, day, hour, minute })).toISOString()
}

/** The datetime-local field value for an instant, in `zone`. */
export const localInputValue = (instant: string, zone: string): string => {
  const local = localParts(zone, Date.parse(instant))
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${local.year}-${pad(local.month)}-${pad(local.day)}T${pad(local.hour)}:${pad(local.minute)}`
}

const number = (text: string): number | null => {
  if (text.trim() === '') return null
  const value = Number(text.replace(',', '.'))
  return Number.isFinite(value) ? value : null
}

const sourceOf = (by: Source['by'], note: string): Source =>
  note.trim() === '' ? { by } : { by, note: note.trim() }

// ───────────── plan ─────────────
export type GoalChoice = 'finish' | 'extra-cost' | 'unavailable-hours' | 'lateness'
export const goalChoiceWords: Readonly<Record<GoalChoice, string>> = {
  finish: 'Finish as early as possible',
  'extra-cost': 'Least extra cost',
  'unavailable-hours': 'Least equipment time out of service',
  lateness: 'Least lateness past job targets',
}

export interface PlanForm {
  readonly title: string
  readonly timeZone: string
  readonly windowStart: string
  readonly windowEnd: string
  readonly goals: readonly GoalChoice[]
  /** The plan's time step, chosen once at create. */
  readonly grid: '30min' | '30s'
}

export const gridChoices: ReadonlyArray<{ readonly value: PlanForm['grid']; readonly label: string }> = [
  { value: '30min', label: 'Half-hour (work weeks and outages)' },
  { value: '30s', label: '30 seconds (dispatch and emergency response)' },
]

/** The plan's name, zone and window. Goals follow in goalsEdit, once the plan's currency is known. */
export const planEdits = (form: PlanForm): Built => {
  const problems: string[] = []
  if (form.title.trim() === '') problems.push('Give the plan a name.')
  if (!isTimeZone(form.timeZone)) problems.push('Choose the site time zone, for example Europe/Oslo.')
  if (form.goals.length === 0) problems.push('Choose at least one goal.')
  if (problems.length > 0) return refuse(...problems)
  const start = localInstant(form.windowStart, form.timeZone)
  const end = localInstant(form.windowEnd, form.timeZone)
  if (start === null || end === null) return refuse('Give the window a start and an end.')
  if (Date.parse(end) <= Date.parse(start)) return refuse('The window must end after it starts.')
  return done({ edit: 'plan', title: form.title.trim(), timeZone: form.timeZone, window: { start, end } })
}

/** The goal order; extra cost is counted in the plan's currency, every other goal in hours. */
export const goalsEdit = (goals: readonly GoalChoice[], currency: string): Built =>
  goals.length === 0
    ? refuse('Choose at least one goal.')
    : done({ edit: 'goals', goals: goals.map(metric => ({ metric, tolerance: { value: 0, unit: metric === 'extra-cost' ? currency : 'h' } })) })

// ───────────── equipment, crews and tools from World ─────────────
export interface EquipmentForm { readonly group: string; readonly newGroup: string }

export const equipmentFromWorld = (subject: PlanningSubject, form: EquipmentForm, inputs: PlanInputs): Built => {
  if (inputs.equipment.some(item => item.locator === subject.locator)) return refuse(`${subject.label} is already in the plan.`)
  const keys = allKeys(inputs)
  const key = keyFor(subject.label, keys)
  if (form.newGroup.trim() !== '') {
    const group = keyFor(form.newGroup, [...keys, key])
    return done({ edit: 'equipment', key, label: subject.label, locator: subject.locator, supportedBy: [], group, groupLabel: form.newGroup.trim() })
  }
  return done({ edit: 'equipment', key, label: subject.label, locator: subject.locator, supportedBy: [], ...(form.group === '' ? {} : { group: form.group }) })
}

/** Numbers that are not times become attributes read from World, e.g. payload for a "where" need. */
export const worldAttributes = (subject: PlanningSubject) => {
  const taken: string[] = []
  return subject.facts.flatMap(fact => {
    if (typeof fact.value !== 'number' || fact.unit === undefined || isTimeUnit(fact.unit)) return []
    const key = keyFor(fact.label, taken)
    taken.push(key)
    return [{ key, label: fact.label, unit: fact.unit, fromWorld: { locator: subject.locator, fact: fact.id } }]
  })
}

export interface ToolForm { readonly kind: 'crew' | 'tool'; readonly calendar: string }

/** A World unit as a crew or tool, available on a calendar; a new calendar covers the whole window. */
export const resourceFromWorld = (subject: PlanningSubject, form: ToolForm, inputs: PlanInputs): Built => {
  if (inputs.resources.some(item => item.locator === subject.locator)) return refuse(`${subject.label} is already in the plan.`)
  const keys = allKeys(inputs)
  const key = keyFor(subject.label, keys)
  const attributes = worldAttributes(subject)
  if (form.calendar !== '') return done({ edit: 'resource', key, label: subject.label, kind: form.kind, count: 1, calendar: form.calendar, attributes, locator: subject.locator, source: { by: 'planner' } })
  const window = inputs.settings.window
  if (window === null) return refuse('Set the plan window first, or choose a shift for it.')
  const calendar = keyFor('whole-window', [...keys, key])
  return done(
    { edit: 'calendar', key: calendar, label: 'Available for the whole window', weekly: [], periods: [window], except: [], source: { by: 'planner' } },
    { edit: 'resource', key, label: subject.label, kind: form.kind, count: 1, calendar, attributes, locator: subject.locator, source: { by: 'planner' } },
  )
}

// ───────────── crews with their shifts ─────────────
export interface CrewForm {
  readonly label: string
  readonly kind: 'crew' | 'tool'
  readonly count: string
  readonly crewSize: string
  readonly calendar: string            // an existing calendar key, or '' for a new weekly shift
  readonly days: readonly Weekday[]
  readonly from: string
  readonly to: string
  readonly sourceBy: Source['by']
  readonly sourceNote: string
}

export const crewEdits = (form: CrewForm, inputs: PlanInputs): Built => {
  const problems: string[] = []
  if (form.label.trim() === '') problems.push('Give the crew or tool a name.')
  const count = number(form.count)
  if (count === null || !Number.isInteger(count) || count < 1) problems.push('How many: a whole number, at least 1.')
  const crewSize = form.crewSize.trim() === '' ? null : number(form.crewSize)
  if (crewSize !== null && (!Number.isInteger(crewSize) || crewSize < 1)) problems.push('People per crew: a whole number, at least 1.')
  if (form.sourceBy === 'reference' && form.sourceNote.trim() === '') problems.push('Name the reference it comes from.')
  if (form.calendar === '') {
    if (form.days.length === 0) problems.push('Choose the working days.')
    if (!/^\d{2}:\d{2}$/.test(form.from) || !/^\d{2}:\d{2}$/.test(form.to)) problems.push('Give the shift start and end, for example 07:00 and 15:00.')
    if (inputs.settings.timeZone === null) problems.push('Set the site time zone first: weekly shifts are in local time.')
  }
  if (problems.length > 0) return refuse(...problems)
  const keys = allKeys(inputs)
  const key = keyFor(form.label, keys)
  const source = sourceOf(form.sourceBy, form.sourceNote)
  const resource = (calendar: string): Edit => ({
    edit: 'resource', key, label: form.label.trim(), kind: form.kind, count: count!, calendar, attributes: [], source,
    ...(crewSize === null ? {} : { crewSize }),
  })
  if (form.calendar !== '') return done(resource(form.calendar))
  const calendar = keyFor(`${form.label} shift`, [...keys, key])
  return done(
    { edit: 'calendar', key: calendar, label: `${form.label.trim()}: ${form.from}–${form.to}`, weekly: [{ days: [...form.days], from: form.from, to: form.to }], periods: [], except: [], source },
    resource(calendar),
  )
}

// ───────────── jobs ─────────────
export interface JobForm {
  readonly title: string
  readonly kind: 'tag-out' | 'work' | 'test'
  readonly equipment: readonly string[]
  readonly inside: boolean
  readonly value: string
  readonly unit: TimeUnit
  readonly elapsed: boolean
  readonly low: string
  readonly high: string
  readonly sourceBy: Source['by']
  readonly sourceNote: string
  readonly crews: readonly string[]
  readonly amount: string
  readonly continuous: boolean
}

export const jobEdits = (form: JobForm, inputs: PlanInputs, key?: string): Built => {
  const problems: string[] = []
  if (form.title.trim() === '') problems.push('Say what the job does.')
  const value = number(form.value)
  if (value === null || value <= 0) problems.push('Give the hours (or minutes) the job takes.')
  const low = number(form.low), high = number(form.high)
  if ((low === null) !== (high === null)) problems.push('Give both ends of the range, or neither.')
  if (low !== null && high !== null && value !== null && !(low <= value && value <= high && high > 0)) problems.push('The range must hold the most likely value: low ≤ value ≤ high.')
  if (form.kind === 'work' && form.equipment.length > 1) problems.push('A work job is on at most one item; tag-outs and tests may cover several.')
  if (form.kind !== 'work' && form.equipment.length === 0) problems.push('Choose the equipment it tags out or tests.')
  if (form.crews.length === 0) problems.push('Choose the crew or tool that does it.')
  const amount = number(form.amount)
  if (amount === null || !Number.isInteger(amount) || amount < 1) problems.push('How many crews or tools at once: a whole number, at least 1.')
  if (form.sourceBy === 'reference' && form.sourceNote.trim() === '') problems.push('Name the reference the estimate comes from.')
  if (problems.length > 0) return refuse(...problems)
  return done({
    edit: 'job', key: key ?? keyFor(form.title, allKeys(inputs)),
    title: form.title.trim(), kind: form.kind, equipment: [...form.equipment],
    isolation: form.kind === 'work' && form.inside && form.equipment.length > 0 ? 'inside' : 'none',
    duration: {
      value: value!, unit: form.unit, calendar: form.elapsed ? 'elapsed' : 'working',
      ...(low === null || high === null ? {} : { range: { low, high } }),
      source: sourceOf(form.sourceBy, form.sourceNote),
    },
    needs: [{ anyOf: [...form.crews], amount: amount! }],
    durationWith: [], continuous: form.continuous, checks: [], tags: [],
  })
}

/** A changed estimate on an existing job. */
export const estimateEdit = (key: string, value: string, unit: TimeUnit, by: Source['by'], note: string): Built => {
  const parsed = number(value)
  if (parsed === null || parsed <= 0) return refuse('Give the new estimate.')
  if (by === 'reference' && note.trim() === '') return refuse('Name the reference the estimate comes from.')
  return done({ edit: 'job', key, duration: { value: parsed, unit, source: sourceOf(by, note) } })
}

/** Fix a job's start; previewed first. */
export const lockEdit = (key: string, local: string, zone: string): Built => {
  const at = localInstant(local, zone)
  return at === null ? refuse('Choose the start time.') : done({ edit: 'job', key, lock: at })
}
export const unlockEdit = (key: string): Built => done({ edit: 'job', key, lock: null })

// ───────────── links ─────────────
export interface LinkForm {
  readonly from: string
  readonly to: string
  readonly type: 'FS' | 'SS' | 'FF'
  readonly lag: string
  readonly lagUnit: TimeUnit
}

export const linkTypeWords = { FS: 'finishes before … starts', SS: 'starts before … starts', FF: 'finishes before … finishes' } as const

export const linkEdit = (form: LinkForm): Built => {
  if (form.from === '' || form.to === '') return refuse('Choose both jobs.')
  if (form.from === form.to) return refuse('A job cannot follow itself.')
  const lag = form.lag.trim() === '' ? 0 : number(form.lag)
  if (lag === null || lag < 0) return refuse('The wait between them is zero or more.')
  return done({ edit: 'link', from: form.from, to: form.to, type: form.type, lag: { value: lag, unit: form.lagUnit } })
}

// ───────────── rules ─────────────
export interface RuleForm {
  readonly kind: 'protected' | 'keep-in-service' | 'span-limit' | 'due'
  readonly words: string
  readonly sourceBy: Source['by']
  readonly sourceNote: string
  readonly equipment: readonly string[]
  readonly members: readonly string[]
  readonly atLeast: string
  readonly group: string
  readonly limit: string
  readonly limitUnit: TimeUnit
  readonly job: string
  /** datetime-local in the plan's zone */
  readonly finishBy: string
}

const insideWindow = (inputs: PlanInputs, at: string): boolean => {
  const window = inputs.settings.window
  return window === null || (Date.parse(window.start) < Date.parse(at) && Date.parse(at) <= Date.parse(window.end))
}

export const ruleEdit = (form: RuleForm, inputs: PlanInputs): Built => {
  const problems: string[] = []
  if (form.words.trim() === '') problems.push('Write the rule in your own words.')
  if (form.sourceBy === 'reference' && form.sourceNote.trim() === '') problems.push('Name the reference the rule comes from.')
  const base = { edit: 'rule' as const, key: keyFor(form.words.slice(0, 40), allKeys(inputs)), kind: form.kind, words: form.words.trim(), source: sourceOf(form.sourceBy, form.sourceNote) }
  switch (form.kind) {
    case 'protected':
      if (form.equipment.length === 0) problems.push('Choose the equipment that must never be touched.')
      return problems.length > 0 ? refuse(...problems) : done({ ...base, equipment: [...form.equipment] })
    case 'keep-in-service': {
      const atLeast = number(form.atLeast)
      if (form.members.length < 2) problems.push('Choose at least two items or crews that back each other up.')
      if (atLeast === null || !Number.isInteger(atLeast) || atLeast < 1) problems.push('How many must stay in service: a whole number, at least 1.')
      else if (atLeast > form.members.length) problems.push(`At least ${atLeast} of ${form.members.length} cannot be kept in service; choose fewer or add members.`)
      return problems.length > 0 ? refuse(...problems) : done({ ...base, members: [...form.members], atLeast: atLeast! })
    }
    case 'due': {
      const zone = inputs.settings.timeZone
      const at = zone === null ? null : localInstant(form.finishBy, zone)
      if (form.job === '') problems.push('Choose the job that must finish.')
      if (zone === null) problems.push('Set the site time zone first.')
      else if (at === null) problems.push('Give the latest finish.')
      else if (!insideWindow(inputs, at)) problems.push('The due time must lie inside the plan window.')
      return problems.length > 0 ? refuse(...problems) : done({ ...base, job: form.job, finishBy: at! })
    }
    case 'span-limit': {
      const limit = number(form.limit)
      if (form.group === '') problems.push('Choose the function group.')
      if (limit === null || limit <= 0) problems.push('Give the longest allowed outage.')
      return problems.length > 0 ? refuse(...problems) : done({ ...base, group: form.group, limit: { value: limit!, unit: form.limitUnit }, singleEntry: true })
    }
  }
}

/** A due rule's new time. Moving it later weakens a hard rule, so the preview asks who agreed. */
export const dueMoveEdit = (key: string, local: string, inputs: PlanInputs): Built => {
  const zone = inputs.settings.timeZone
  if (zone === null) return refuse('Set the site time zone first.')
  const at = localInstant(local, zone)
  if (at === null) return refuse('Give the new latest finish.')
  if (!insideWindow(inputs, at)) return refuse('The due time must lie inside the plan window.')
  return done({ edit: 'rule', key, finishBy: at })
}

export const runLinkEdit = (runId: string | null): Built => done({ edit: 'plan', run: runId })
export const purchaseAllowedEdit = (key: string, allowed: boolean): Built => done({ edit: 'purchase', key, allowed })
