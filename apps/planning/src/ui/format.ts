// Planner words for times, durations, money and where a value comes from. Times are civil time in
// the plan's zone ("Mon 07:00"); durations are hours or minutes; nothing is shown as a count of seconds.
import type { PlanningFact, PlanningFactBasis } from '@leitbild/contracts'
import type { CertifiedSize, Source } from '../plan/schema.ts'
import { isTimeUnit, timeUnitMs } from '../time/units.ts'
import { localParts } from '../time/zone.ts'

const weekdayWords = { sun: 'Sun', mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat' } as const
const monthWords = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const
const pad = (value: number): string => String(value).padStart(2, '0')
const hourMs = timeUnitMs.h
const minuteMs = timeUnitMs.min

export interface TimeFormat {
  /** The zone times are shown in: the plan's, or UTC until the plan has one (the screen says so). */
  readonly zone: string
  readonly zoneSet: boolean
  /** "07:00", or "08:05:30" when the time is not on a whole minute. */
  readonly time: (instant: string | number) => string
  /** "Mon 07:00" */
  readonly clock: (instant: string | number) => string
  /** "Mon 16 Nov" */
  readonly day: (instant: string | number) => string
  /** "Mon 16 Nov 07:00" */
  readonly when: (instant: string | number) => string
  /** "Mon 07:00–10:00" or "Mon 07:00 – Tue 03:30" */
  readonly range: (start: string | number, end: string | number) => string
}

const ms = (instant: string | number): number => typeof instant === 'number' ? instant : Date.parse(instant)

export const createTimeFormat = (zone: string | null): TimeFormat => {
  const shown = zone ?? 'UTC'
  const parts = (instant: string | number) => localParts(shown, ms(instant))
  const time = (instant: string | number): string => {
    const local = parts(instant)
    return `${pad(local.hour)}:${pad(local.minute)}${local.second === 0 ? '' : `:${pad(local.second)}`}`
  }
  const dayKey = (instant: string | number): string => {
    const local = parts(instant)
    return `${local.year}-${local.month}-${local.day}`
  }
  const clock = (instant: string | number): string => `${weekdayWords[parts(instant).weekday]} ${time(instant)}`
  const day = (instant: string | number): string => {
    const local = parts(instant)
    return `${weekdayWords[local.weekday]} ${local.day} ${monthWords[local.month - 1]}`
  }
  return {
    zone: shown, zoneSet: zone !== null, time, clock, day,
    when: instant => `${day(instant)} ${time(instant)}`,
    range: (start, end) => dayKey(start) === dayKey(end) ? `${clock(start)}–${time(end)}` : `${clock(start)} – ${clock(end)}`,
  }
}

const trimmed = (value: number, places: number): string => {
  const factor = 10 ** places
  return String(Math.round(value * factor) / factor)
}

/** A length of time in planner words: "38 h", "3.5 h", "45 min", "2 min 10 s". Never "130 s". */
export const spanText = (milliseconds: number): string => {
  const sign = milliseconds < 0 ? '−' : ''
  const size = Math.abs(milliseconds)
  if (size >= hourMs) return `${sign}${trimmed(size / hourMs, 1)} h`
  const minutes = Math.floor(size / minuteMs)
  const seconds = Math.round((size - minutes * minuteMs) / 1_000)
  if (minutes === 0) return `${sign}${seconds} s`
  return `${sign}${minutes} min${seconds === 0 ? '' : ` ${seconds} s`}`
}

export const durationText = (value: number, unit: string): string => {
  if (!isTimeUnit(unit)) return `${trimmed(value, 2)} ${unit}`
  if (value === 0) return unit === 's' || unit === 'min' ? '0 min' : '0 h'
  return spanText(value * timeUnitMs[unit])
}

export const hoursText = (hours: number): string => spanText(hours * hourMs)

/** A number of hours without its unit, for "34 crew-hours": "34", "37.5". */
export const hoursNumber = (hours: number): string => trimmed(hours, 1)

const grouped = (value: number): string => {
  const [whole, fraction] = trimmed(value, 2).split('.')
  const digits = (whole ?? '0').replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return fraction === undefined ? digits : `${digits}.${fraction}`
}

export const isCurrency = (unit: string): boolean => /^[A-Z]{3}$/.test(unit)

/** "NOK 464,250" */
export const moneyText = (amount: number, currency: string): string => `${currency} ${grouped(amount)}`

/** A value with its unit in planner words: time as a duration, money with its currency, else "1,500 kg". */
export const quantityText = (value: number, unit: string): string => {
  if (isTimeUnit(unit)) return durationText(value, unit)
  if (isCurrency(unit)) return moneyText(value, unit)
  return `${grouped(value)} ${unit}`
}

export const basisWord = (basis: PlanningFactBasis): string => ({
  design: 'design value', configured: 'configured', observed: 'observed', 'owner-estimate': 'owner estimate',
} satisfies Record<PlanningFactBasis, string>)[basis]

/** A mark is a shape plus a word, so it never depends on colour. */
export interface Mark { readonly shape: string; readonly word: string }

export const sourceMark = (source: Source | { readonly by: 'world' }): Mark => ({
  planner: { shape: '●', word: 'Planner' },
  assumption: { shape: '△', word: 'Assumption' },
  reference: { shape: '§', word: 'Reference' },
  world: { shape: '◉', word: 'From World' },
} as const)[source.by]

/** "Assumption: vendor promise" */
export const sourceText = (source: Source): string => {
  const mark = sourceMark(source)
  return source.note === undefined ? mark.word : `${mark.word}: ${source.note}`
}

/** A World value in words, e.g. "Running: yes" or "Payload: 1,500 kg". Units outside the table keep their own name. */
export const factValueText = (fact: Pick<PlanningFact, 'label' | 'value' | 'unit'>): string => {
  if (typeof fact.value === 'boolean') return `${fact.label}: ${fact.value ? 'yes' : 'no'}`
  if (typeof fact.value === 'string') return `${fact.label}: ${fact.value}`
  return `${fact.label}: ${fact.unit === undefined ? grouped(fact.value) : quantityText(fact.value, fact.unit)}`
}

/** Ends a sentence with one full stop, whatever the words it was built from end with. */
export const sentence = (text: string): string => /[.!?]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`

/** "read Thu 10:02 (simulation time)": a World value's time is the simulation's, in the plan zone. */
export const readAt = (at: string, format: TimeFormat): string => `read ${format.clock(at)} (simulation time)`

/** "Running: yes · observed · read Thu 10:02 (simulation time)" */
export const factText = (fact: Pick<PlanningFact, 'label' | 'value' | 'unit' | 'basis' | 'at'>, format: TimeFormat): string =>
  `${factValueText(fact)} · ${basisWord(fact.basis)} · ${readAt(fact.at, format)}`

/**
 * Whether a World value belongs on a routine screen. Model digests, World locators and bare lists of
 * step numbers are provenance for reviewers, not planner information, and are not shown.
 */
export const routineFact = (fact: Pick<PlanningFact, 'value'>): boolean => {
  if (typeof fact.value !== 'string') return true
  const text = fact.value.trim()
  return !(/^[0-9a-f]{16,}$/i.test(text) || /%[0-9A-F]{2}/.test(text) || /^[a-z][a-z0-9-]*\/\S+$/.test(text) || /^\d+(\s+\d+)+$/.test(text) || text.length > 80)
}

/**
 * The certified size in planner words, as plan/summary.ts says it: exactly "Certified plan size: pending the
 * owner's decision" until the owner decides; the evidence is detail, shown only on request.
 */
export const certifiedSizeWords = (size: CertifiedSize): string => size.decided
  ? `Certified plan size: ${size.family}, up to ${size.maxJobs} jobs`
  : 'Certified plan size: pending the owner\'s decision'
/** Generate's refusal of a plan above the size, as plan/summary.ts says it. */
export const sizeRefusalWords = (size: CertifiedSize, jobs: number): string =>
  `${certifiedSizeWords(size)}. This plan has ${jobs} jobs; Generate takes up to ${size.maxJobs}${size.decided ? '' : ' until then'}.`
