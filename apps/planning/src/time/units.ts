/** Milliseconds per plan time unit. Durations, lags and limits use only these. */
export const timeUnitMs = { s: 1_000, min: 60_000, h: 3_600_000, d: 86_400_000 } as const
export type TimeUnit = keyof typeof timeUnitMs

/** Milliseconds per slot of each plan grid. */
export const gridSlotMs = { '30s': 30_000, '30min': 1_800_000 } as const
export type Grid = keyof typeof gridSlotMs

/**
 * The units Planning converts. A World value in any other unit cannot become a duration or a threshold;
 * the caller refuses it and names the unit.
 */
const unitTable: Readonly<Record<string, { readonly dimension: 'time' | 'mass'; readonly factor: number }>> = {
  ...Object.fromEntries(Object.entries(timeUnitMs).map(([unit, ms]) => [unit, { dimension: 'time' as const, factor: ms }])),
  kg: { dimension: 'mass', factor: 1 },
}

export type UnitConversion =
  | { readonly ok: true; readonly value: number }
  | { readonly ok: false; readonly code: 'unit_unknown' | 'unit_mismatch'; readonly unit: string }

export const isKnownUnit = (unit: string): boolean => Object.hasOwn(unitTable, unit)
export const isTimeUnit = (unit: string): unit is TimeUnit => Object.hasOwn(timeUnitMs, unit)

export const convertUnit = (value: number, from: string, to: string): UnitConversion => {
  const source = Object.hasOwn(unitTable, from) ? unitTable[from] : undefined
  if (source === undefined) return { ok: false, code: 'unit_unknown', unit: from }
  const target = Object.hasOwn(unitTable, to) ? unitTable[to] : undefined
  if (target === undefined) return { ok: false, code: 'unit_unknown', unit: to }
  if (source.dimension !== target.dimension) return { ok: false, code: 'unit_mismatch', unit: from }
  return { ok: true, value: from === to ? value : value * source.factor / target.factor }
}

export const durationMs = (value: number, unit: TimeUnit): number => value * timeUnitMs[unit]
