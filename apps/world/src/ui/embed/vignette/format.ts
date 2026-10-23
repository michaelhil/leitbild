// Words around the numbers a vignette writes. The numbers themselves come from
// the one formatter beside quantityUnits, so a live readout shows exactly the
// digits its card cites.
import { distanceParts, durationParts, numberText, unitSymbol } from '../../../core/observation/model.ts'

/** Value and unit symbol, as the card reads it: "91.3 %", "287.4 °C", "3". */
export const quantityText = (value: number, unit: string): string => {
  const symbol = unitSymbol(unit)
  return symbol === '' ? numberText(value, unit) : `${numberText(value, unit)} ${symbol}`
}

/**
 * A label without the object the vignette is titled by: "<object> · <observable>" reads "<observable>" under a title
 * "<object>", or "<object> · <element>", or where `subject` names the one object every part is on (an answer's
 * title names it its own way, W7.3), and without the element every value is on ("· AFW valve A"); the whole label
 * stays in the tooltip.
 */
export const underTitle = (label: string, title: string, subject?: { readonly object: string; readonly element?: string }): string => {
  const object = title.split(' · ')[0]!
  const shown = [title, object, ...subject === undefined ? [] : [subject.object]].find(prefix => label.startsWith(`${prefix} · `))
  const own = shown === undefined ? label : label.slice(shown.length + 3)
  return subject?.element !== undefined && own.endsWith(` · ${subject.element}`) ? own.slice(0, -(subject.element.length + 3)) : own
}

/** A Run time as the footer and "since" read it: hh:mm:ss. */
export const clockText = (at: string | number): string => new Date(at).toISOString().slice(11, 19)

/** A duration as the card writes it: "45 s", "4 min", "2 h". */
export const durationText = (seconds: number): string => { const parts = durationParts(seconds); return `${parts.value} ${parts.unit}` }

/** A distance as the card writes it: metres under a kilometre, else kilometres. */
export const distanceText = (metres: number): string => { const parts = distanceParts(metres); return `${parts.value} ${parts.unit}` }

/**
 * What every vignette's footer says it is, beside its clock: a view World generated from the model, or one the
 * Assistant composed; never an operating display. Until its view is read, only the latter.
 */
export const provenanceMark = (view: { readonly by?: 'assistant' } | undefined): string => provenanceMarks(view)[0]

/** The mark in its words, then the same said shorter, for a footer too narrow for the first (a 360 or 300 px chat answer): never cut. */
export const provenanceMarks = (view: { readonly by?: 'assistant' } | undefined): readonly [string, ...string[]] =>
  view === undefined ? ['not an operating display', 'not for operating']
    : view.by === 'assistant' ? ['AI-composed view · not an operating display', 'AI view · not for operating', 'AI · not for operating']
      : ['Generated from the model · not an operating display', 'Model view · not for operating', 'Model · not for operating']
