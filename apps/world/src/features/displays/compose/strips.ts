/**
 * How a trend's pens share strips (W5.2), and the rows a trend takes (W5.4), for the composer that fits a trend and the
 * renderer that draws it (TrendStrip.svelte). One quantity on each strip: pens share one only where they measure one
 * quantity in one unit, alike read over decades or not, on scales within a factor of three, and draw the same limits
 * (a strip draws only the limits all its pens declare, so a pen whose limits differ gets its own and keeps them), at
 * most four to a strip; a state (on/off, a word) is never put on a numeric axis: states read as bands, after the
 * strips. A pen's scale is what its Pack declares, the largest of its limits, so a trend strips alike however its
 * values move.
 */
import type { Observable } from '../../../core/observation/model.ts'
import type { VignetteValue } from './model.ts'

type Threshold = Observable['thresholds'][number]
type Pen = Pick<VignetteValue, 'quantity' | 'unit' | 'valueType' | 'thresholds' | 'decades'>

/** A limit a strip draws as a line: not a control set point or a target, which steer a value and are no limit on it. */
export const drawsAsLimit = (threshold: Pick<Threshold, 'effect'>): boolean => threshold.effect !== 'control' && threshold.effect !== 'target'

/** A state (on/off, a word): drawn as a band over time, never on a numeric axis. */
export const isState = (pen: Pick<VignetteValue, 'valueType'>): boolean => pen.valueType !== 'number' && pen.valueType !== 'duration'

/** The scale a pen's Pack declares: the largest of its limits (its alarm and trip limits where it has any); none without limits. */
const scaleOf = (pen: Pen): number | undefined => {
  const limits = pen.thresholds.some(drawsAsLimit) ? pen.thresholds.filter(drawsAsLimit) : pen.thresholds
  const largest = Math.max(0, ...limits.map(limit => Math.abs(limit.value)))
  return largest > 0 ? largest : undefined
}

/** The limits a pen draws, by direction and value. */
const drawnLimits = (pen: Pen): string => [...new Set(pen.thresholds.filter(drawsAsLimit).map(limit => `${limit.direction} ${limit.value}`))].sort().join('|')

/** Pens drawn on one scale share a strip: one quantity, one unit, alike over decades, the same limits, and scales within a factor of three. */
const SCALE_FACTOR = 3
const shareStrip = (left: Pen, right: Pen): boolean => {
  if (left.quantity !== right.quantity || left.unit !== right.unit || (left.decades === true) !== (right.decades === true) || drawnLimits(left) !== drawnLimits(right)) return false
  const [a, b] = [scaleOf(left), scaleOf(right)]
  return a === undefined || b === undefined || Math.max(a, b) <= SCALE_FACTOR * Math.min(a, b)
}

const PENS_PER_STRIP = 4

/** A trend's strips in its pens' order: numeric pens on strips that share a scale, then their states on one band strip, at most four to each. */
export const stripsOf = <T extends Pen>(values: ReadonlyArray<T>): ReadonlyArray<ReadonlyArray<T>> => {
  const strips: T[][] = []
  for (const value of values.filter(pen => !isState(pen))) {
    const strip = strips.find(pens => pens.length < PENS_PER_STRIP && pens.every(pen => shareStrip(pen, value)))
    if (strip === undefined) strips.push([value])
    else strip.push(value)
  }
  const states = values.filter(isState)
  return [...strips, ...Array.from({ length: Math.ceil(states.length / PENS_PER_STRIP) }, (_, at) => states.slice(at * PENS_PER_STRIP, at * PENS_PER_STRIP + PENS_PER_STRIP))]
}

/** A numeric strip's plot: at least five rows (W5.4), whatever its pens. */
export const PLOT_ROWS = 5

/** A strip's rows: a plot and a legend row under it for each pen; a band strip a row for each state. */
export const stripRows = (strip: ReadonlyArray<Pick<VignetteValue, 'valueType'>>): number =>
  strip.length > 0 && strip.every(isState) ? strip.length : PLOT_ROWS + strip.length

/** A trend's rows: its strips' and the time axis under the last. */
export const trendRows = (strips: ReadonlyArray<ReadonlyArray<Pick<VignetteValue, 'valueType'>>>): number =>
  strips.reduce((sum, strip) => sum + stripRows(strip), 0) + 1
