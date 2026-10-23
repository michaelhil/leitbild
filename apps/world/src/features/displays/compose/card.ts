/**
 * The card a vignette returns (architecture A5): one keyed item per line,
 * written as the renderer writes it (one number format, core/observation).
 * A value reads "<number> <unit>", its priority word at caution or above,
 * "since hh:mm:ss" for a state and "<effect> in 4 min" from its time to act;
 * a demand reads as the command it is ("CMD yes"), as a values view writes it;
 * its limits are its declared thresholds. An alert reads "<priority> ·
 * <message>" with its marks and no numbers; an object its core slots. Each
 * item names the object its label begins with (`object`). The named items
 * come first; what 48 items or 1,900 characters leave out is counted in
 * `more`.
 */
import { DISPLAY_CARD_MAX_ITEMS, DISPLAY_CARD_MAX_TEXT, displayCardSchema, displayCardTextLength, type DisplayCard, type DisplayCardAdjustment, type DisplayCardItem } from '@leitbild/contracts'
import { priorityLevels } from '../../../core/model/alerts.ts'
import { criterionWords, distanceParts, durationParts, numberShown, numberText, unitSymbol, type Observation, type Quantity } from '../../../core/observation/model.ts'
import type { AlertRow } from '../alerts/rows.ts'
import type { Declared } from './declared.ts'
import type { EntityRow, SlotDeclaration, VignetteSample } from './model.ts'

type Item = Omit<DisplayCardItem, 'key'>
type Shown = { readonly value: number; readonly decimals: number }
type Words = { readonly text: string; readonly number: Shown }

const clock = (at: string): string => at.slice(11, 19)
const shown = (value: number, unit: string, kind?: Quantity, decades = false): Shown => numberShown(value, unit, kind, decades)
const quantity = (value: number, unit: string, kind?: Quantity, decades = false): string =>
  unitSymbol(unit) === '' ? numberText(value, unit, kind, decades) : `${numberText(value, unit, kind, decades)} ${unitSymbol(unit)}`
const duration = (seconds: number): Words => { const { value, unit } = durationParts(seconds); return { text: `${value} ${unit}`, number: { value, decimals: 0 } } }
const distance = (metres: number): Words => { const { value, unit } = distanceParts(metres); return { text: `${numberText(value, unit)} ${unit}`, number: shown(value, unit) } }
/** A number as a slot of this unit code shows it: seconds as a duration, metres as a distance. */
const slotWords = (value: number, unit: string): Words => unit === 's' ? duration(value) : unit === 'm' ? distance(value) : { text: quantity(value, unit), number: shown(value, unit) }
const atLeastCaution = (priority: string | null | undefined): boolean => priority != null && priorityLevels.indexOf(priority as never) >= priorityLevels.indexOf('caution')

/** The object an item's label begins with, where its label holds it whole. */
const objectOf = (label: string, object: string): { readonly object?: string } =>
  object.length <= 80 && (label === object || label.startsWith(`${object} · `)) ? { object } : {}

export const valueItem = ({ observable, object }: Declared, observation: Observation | undefined): Item => {
  const label = `${object.label} · ${observable.label}`.slice(0, 80)
  const named = { label, ...objectOf(label, object.label) }
  // A criterion reads as a row writes it: how many of its checks that apply are met and those not yet met, or its comparison.
  if (observable.checks !== undefined) {
    const words = criterionWords(observable.checks, observation)
    return {
      ...named, reading: [words.text, ...(words.detail === null ? [] : [words.detail])].join(' · ').slice(0, 120), ...(words.unit === undefined ? {} : { unit: words.unit }),
      numbers: [...words.numbers], ...(observation === undefined ? {} : { priority: observation.priority }), subject: { ref: observable.ref },
    }
  }
  const value = observation?.value ?? null
  const numbers: Shown[] = []
  // A reading that measures nothing now (meaningfulWhile off) reads "—", as a readout shows it.
  const notApplicable = observation?.quality === 'not-applicable'
  const decades = observable.decades === true
  const stated = observable.states?.find(state => state.value === String(value))?.label ?? (typeof value === 'boolean' ? (value ? 'yes' : 'no') : String(value))
  const word = notApplicable ? '—'
    : typeof value === 'number' ? (numbers.push(shown(value, observable.unit, observable.quantity, decades)), quantity(value, observable.unit, observable.quantity, decades))
    : value === null ? 'no reading'
      // A demand says what is asked, never that it is so (H14), as a values view writes it (readout.ts).
      : observable.basis === 'command' ? `CMD ${stated}` : stated
  const threshold = observable.thresholds.find(entry => entry.id === observation?.timeToAct?.threshold)
  const toAct = observation?.timeToAct === undefined ? undefined : duration(observation.timeToAct.seconds)
  if (toAct !== undefined) numbers.push(toAct.number)
  const parts = [word,
    ...(observation !== undefined && observation.quality !== 'good' && !notApplicable ? [observation.quality] : []),
    ...(atLeastCaution(observation?.priority) ? [observation!.priority] : []),
    ...(observation?.since !== undefined ? [`since ${clock(observation.since.at)}`] : []),
    ...(toAct !== undefined ? [`${threshold?.effect ?? 'limit'} in ${toAct.text}`] : [])]
  const near = typeof value === 'number' ? (limit: number) => Math.abs(limit - value) : () => 0
  const limits = [...observable.thresholds].sort((left, right) => Number(right.id === observation?.past) - Number(left.id === observation?.past) || near(left.value) - near(right.value))
    .slice(0, 4).map(entry => shown(entry.value, observable.unit, observable.quantity, decades))
  return {
    ...named, reading: parts.join(' · ').slice(0, 120), ...(observable.unit === '' ? {} : { unit: observable.unit }), numbers,
    ...(limits.length === 0 ? {} : { limits }), ...(observation === undefined ? {} : { priority: observation.priority }), subject: { ref: observable.ref },
  }
}

export const alertItem = (row: AlertRow): Item => {
  const marks = [...(row.alert.firstOut !== undefined ? ['first out'] : []), ...(row.alert.advisory === true ? ['advisory'] : []),
    ...(row.alert.acknowledged ? ['acknowledged'] : []), ...(row.alert.returned === true ? ['returned'] : [])]
  const label = row.objectLabel.slice(0, 80)
  return {
    label, ...objectOf(label, row.objectLabel), reading: [row.priority ?? 'priority not declared', row.alert.message, ...marks].join(' · ').slice(0, 120), numbers: [],
    ...(row.priority === null ? {} : { priority: row.priority }), subject: { objectId: row.objectId, alertId: row.alert.id },
  }
}

/** An entity row in words, with the numbers it shows. */
export const entityItem = (row: EntityRow): Item => {
  const parts: Array<{ readonly text: string; readonly number?: Shown }> = [
    ...[row.status?.word, row.urgency].filter((word): word is string => word !== undefined).map(text => ({ text })),
    ...(row.alert === undefined ? [] : [{ text: `${row.alert.priority ?? `${row.alert.severity} (priority not declared)`} · ${row.alert.message}` }]),
    ...(row.etaS === undefined ? [] : [(words => ({ text: `ETA ${words.text}`, number: words.number }))(duration(row.etaS))]),
    ...(row.distanceM === undefined ? [] : [(words => ({ text: `${words.text} away`, number: words.number }))(distance(row.distanceM))]),
    ...(row.ageS === undefined ? [] : [(words => ({ text: `fix ${words.text} old`, number: words.number }))(duration(row.ageS))]),
    ...(row.closed === true ? [{ text: 'closed' }] : []),
  ]
  const label = row.label.slice(0, 80)
  return {
    label, ...objectOf(label, row.label), reading: (parts.map(part => part.text).join(' · ') || 'no slots').slice(0, 120),
    numbers: parts.flatMap(part => part.number === undefined ? [] : [part.number]).slice(0, 8), subject: { objectId: row.objectId },
  }
}

/** An entity-floor object's slots, one item each. */
export const slotItems = (objectId: string, label: string, slots: ReadonlyArray<SlotDeclaration>, values: VignetteSample['slots'][string]): ReadonlyArray<Item> => slots.flatMap(slot => {
  const value = values[slot.key]?.value
  if (value === undefined) return []
  const words = typeof value === 'number' ? slotWords(value, slot.unit) : null
  const since = values[slot.key]?.since
  const named = `${label} · ${slot.label}`.slice(0, 80)
  return [{
    label: named, ...objectOf(named, label), reading: `${words?.text ?? (value === null ? 'no reading' : String(value))}${since === undefined ? '' : ` · since ${clock(since.at)}`}`.slice(0, 120),
    ...(slot.unit === '' || words === null ? {} : { unit: slot.unit }), numbers: words === null ? [] : [words.number], subject: { objectId },
  }]
})

/** What a card is about, as its vignette's subjects name it: elements (with the devices they bundle) and observables. */
export interface CardSubjects {
  readonly elements: ReadonlyArray<{ readonly objectId: string; readonly elementId: string }>
  readonly refs: ReadonlyArray<string>
}

/** A reading on a subject: a named observable, or one measured on a subject element or a device it bundles. */
export const onSubjects = (subjects: CardSubjects, declared: Declared | undefined): boolean => declared !== undefined
  && (subjects.refs.includes(declared.observable.ref) || subjects.elements.some(({ objectId, elementId }) => declared.object.id === objectId
    && (declared.element?.id === elementId || declared.element?.parent === elementId)))

/** An alert on a subject: on a named observable, or raised on a subject element or a device it bundles. */
const alertOnSubjects = (subjects: CardSubjects, row: AlertRow, parentOf: (objectId: string, elementId: string) => string | undefined): boolean => {
  const observable = row.alert.observable
  const element = row.alert.subject !== undefined && 'element' in row.alert.subject ? row.alert.subject.element : undefined
  return (observable !== undefined && subjects.refs.includes(observable)) || (element !== undefined && subjects.elements.some(entry => entry.objectId === row.objectId
    && (entry.elementId === element || parentOf(row.objectId, element) === entry.elementId)))
}

/** The most alerts a card lists after readings (W7.2): the rest are counted, never listed. */
export const CARD_ALERTS = 3

/**
 * The alerts a card lists, in its list's order with the subjects' own first. Where readings lead the card, the worst
 * three and a count of the rest; an alerts-only card lists what its list shows.
 */
export const cardAlerts = (rows: ReadonlyArray<AlertRow>, shown: number, readings: boolean, subjects: CardSubjects, parentOf: (objectId: string, elementId: string) => string | undefined): ReadonlyArray<AlertRow> => {
  if (!readings) return rows.slice(0, shown)
  const own = rows.filter(row => alertOnSubjects(subjects, row, parentOf))
  return [...own, ...rows.filter(row => !own.includes(row))].slice(0, Math.min(shown, CARD_ALERTS))
}

/**
 * Items in order, keyed from `firstKey`, within 48 items and the card's characters; `hidden` items the views left out
 * are counted in `more`, and so is any item the card itself trims, with an adjustment that says so.
 */
export const assembleCard = (at: DisplayCard['at'], items: ReadonlyArray<Item>, adjusted: ReadonlyArray<DisplayCardAdjustment>, hidden = 0, firstKey = 1): DisplayCard => {
  const keyed = items.map((item, index): DisplayCardItem => ({ key: `k${firstKey + index}`, ...item }))
  const fits = (count: number, notes: ReadonlyArray<DisplayCardAdjustment>): boolean => count <= DISPLAY_CARD_MAX_ITEMS
    && displayCardTextLength({ at, items: keyed.slice(0, count), more: hidden + keyed.length - count, adjusted: notes }) <= DISPLAY_CARD_MAX_TEXT
  if (fits(keyed.length, adjusted)) return displayCardSchema.parse({ at, items: keyed, more: hidden, adjusted })
  const trimmed = (count: number): ReadonlyArray<DisplayCardAdjustment> => [...adjusted.slice(0, 7),
    { kind: 'layout', text: `${keyed.length - count} items left off the card, which holds ${DISPLAY_CARD_MAX_ITEMS} items and ${DISPLAY_CARD_MAX_TEXT} characters` }]
  let count = Math.min(keyed.length, DISPLAY_CARD_MAX_ITEMS)
  while (count > 0 && !fits(count, trimmed(count))) count -= 1
  return displayCardSchema.parse({ at, items: keyed.slice(0, count), more: hidden + keyed.length - count, adjusted: trimmed(count) })
}
