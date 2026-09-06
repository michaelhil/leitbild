// Requested-unit presentation only. Signal identity and native values remain
// graph/runtime-owned; this does not interpret procedures or alter controls.
interface UnitSource {
  readonly unit: string
  readonly quantity: string
}

type UnitResolution =
  | { readonly status: 'native'; readonly unit: string }
  | { readonly status: 'converted'; readonly unit: string; readonly convert: (value: number) => number }
  | { readonly status: 'unavailable'; readonly unit: string; readonly reason: string }

export const resolveRequestedSignalUnit = (source: UnitSource, requestedUnit: string): UnitResolution => {
  // Physical symbols are case-sensitive (MW is not mW). Only the explicitly
  // supported boolean spellings are equivalent; do not normalize arbitrary units.
  const requested = requestedUnit.trim()
  if (requested === source.unit || (source.unit === 'boolean' && requested === 'bool')) return { status: 'native', unit: source.unit }
  if (source.quantity === 'temperature' || source.quantity === 'temperatureDelta') {
    const offset = source.quantity === 'temperature' ? 32 : 0
    if (source.unit === 'degC' && requested === 'degF') return { status: 'converted', unit: 'degF', convert: value => value * 9 / 5 + offset }
    if (source.unit === 'degF' && requested === 'degC') return { status: 'converted', unit: 'degC', convert: value => (value - offset) * 5 / 9 }
  }
  return {
    status: 'unavailable', unit: source.unit,
    reason: `Conversion from ${source.unit} to ${requestedUnit} is unavailable; no conversion or model-specific mapping is declared. Native values remain in ${source.unit}.`,
  }
}

export interface RequestedSignalValueView {
  readonly status: 'native' | 'converted' | 'unavailable'
  readonly value: number | boolean
  readonly unit: string
  readonly requestedUnit: string
  readonly reason?: string
}

export const requestedSignalValueView = (
  source: UnitSource & { readonly value: number | boolean },
  requestedUnit: string,
): RequestedSignalValueView => {
  const resolution = resolveRequestedSignalUnit(source, requestedUnit)
  const native = { value: source.value, unit: source.unit, requestedUnit }
  if (resolution.status === 'unavailable') return { ...native, status: 'unavailable', reason: resolution.reason }
  if (resolution.status === 'native') return { ...native, status: 'native' }
  if (typeof source.value !== 'number' || !Number.isFinite(source.value)) return {
    ...native, status: 'unavailable', reason: `Conversion from ${source.unit} to ${requestedUnit} requires a finite numeric value.`,
  }
  const value = resolution.convert(source.value)
  if (!Number.isFinite(value)) return { ...native, status: 'unavailable', reason: `Conversion from ${source.unit} to ${requestedUnit} produced a non-finite value.` }
  return { status: 'converted', value, unit: resolution.unit, requestedUnit }
}
