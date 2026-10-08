import type { ComposedDisplayThreshold } from './ic-thresholds.ts'

// Operator wording shared by the compose result (what the agent is told the
// display shows) and the embedded view (what the operator reads), so an answer
// can name a threshold exactly as the display does.

const unitLabels: Readonly<Record<string, string>> = {
  percent: '%',
  degC: '°C',
  fraction: '',
}

export const unitLabel = (unit: string): string => unitLabels[unit] ?? unit

const kindAbbreviation = { trip: 'TRIP', alarm: 'ALM', control: 'CTL' } as const

/** Direction, kind and the exact configured value: "LO ALM 30 %". */
export const thresholdName = (
  threshold: Pick<ComposedDisplayThreshold, 'direction' | 'kind' | 'value'>,
  unit: string,
): string => {
  const label = unitLabel(unit)
  return `${threshold.direction === 'low' ? 'LO' : 'HI'} ${kindAbbreviation[threshold.kind]} ${threshold.value}${label === '' ? '' : ` ${label}`}`
}
