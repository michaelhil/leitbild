import type { ComposedDisplayThreshold } from './ic-thresholds.ts'

// Operator wording shared by the compose result (what the agent is told the
// display shows) and the embedded view (what the operator reads), so an answer
// can name values and thresholds exactly as the display does.

const unitLabels: Readonly<Record<string, string>> = {
  percent: '%',
  degC: '°C',
  // Fractions (speeds, positions, bus voltages) read as percent: 1.00 → 100 %.
  fraction: '%',
}

export const unitLabel = (unit: string): string => unitLabels[unit] ?? unit

/** A native value in the unit the display shows it in. */
export const displayValue = (value: number, unit: string): number =>
  unit === 'fraction' ? Number((value * 100).toPrecision(12)) : value

/** Precision follows magnitude; trend readers compare, they do not audit digits. */
export const valueDigits = (value: number): number => {
  const magnitude = Math.abs(value)
  return magnitude >= 100 ? 0 : magnitude >= 10 ? 1 : magnitude >= 1 ? 2 : 3
}

export const formatValue = (value: number): string => value.toFixed(valueDigits(value))

/** A native value as the display shows it, with its unit: "100 %", "15.7 MPa". */
export const formatQuantity = (value: number, unit: string): string => {
  const label = unitLabel(unit)
  return `${formatValue(displayValue(value, unit))}${label === '' ? '' : ` ${label}`}`
}

const kindAbbreviation = { trip: 'TRIP', alarm: 'ALM', control: 'CTL' } as const

/** Direction, kind and the exact configured value: "LO ALM 30 %". */
export const thresholdName = (
  threshold: Pick<ComposedDisplayThreshold, 'direction' | 'kind' | 'value'>,
  unit: string,
  options: { readonly withUnit: boolean } = { withUnit: true },
): string => {
  const label = options.withUnit ? unitLabel(unit) : ''
  return `${threshold.direction === 'low' ? 'LO' : 'HI'} ${kindAbbreviation[threshold.kind]} ${displayValue(threshold.value, unit)}${label === '' ? '' : ` ${label}`}`
}

export interface ThresholdMargin {
  readonly threshold: ComposedDisplayThreshold
  /** Distance before the rule acts, in native units; negative once the value is beyond it. */
  readonly margin: number
}

/** The alarm or trip threshold the value is closest to acting on. */
export const nearestThresholdMargin = (
  value: number,
  thresholds: ReadonlyArray<ComposedDisplayThreshold>,
): ThresholdMargin | null => {
  const margins = thresholds
    .filter(threshold => threshold.kind !== 'control')
    .map(threshold => ({
      threshold,
      margin: threshold.operator === '<' || threshold.operator === '<=' ? value - threshold.value : threshold.value - value,
    }))
  if (margins.length === 0) return null
  return margins.reduce((nearest, candidate) => candidate.margin < nearest.margin ? candidate : nearest)
}

/** "LO ALM 30 % · 4.50 above", or "past LO ALM 30 %" once the value is beyond it. */
export const marginText = (margin: ThresholdMargin, unit: string): string => {
  const name = thresholdName(margin.threshold, unit)
  const qualified = margin.threshold.modeLabel === undefined ? '' : ` (${margin.threshold.modeLabel})`
  if (margin.margin < 0) return `past ${name}${qualified}`
  return `${name}${qualified} · ${formatValue(displayValue(margin.margin, unit))} ${margin.threshold.direction === 'low' ? 'above' : 'below'}`
}

/** Simulation time of day as the display header shows it: "10:01:00". */
export const simulationClock = (ms: number): string => new Date(ms).toISOString().slice(11, 19)
