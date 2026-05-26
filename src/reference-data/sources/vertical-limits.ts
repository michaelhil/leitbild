// Vertical-limit conversion for airspace floors and ceilings.
// OpenAIP-style input → canonical { metres, reference, label }.
//
// References:
//   FT  — feet above the chosen datum
//   M   — metres above the chosen datum
//   FL  — flight level. FL 095 = 9500 ft pressure altitude (standard atmosphere).
//         Conversion to metres is mechanical: value * 100 ft * 0.3048 m/ft.
//         This matches what aviation displays use; we are not computing ISA altitude.
//   referenceDatum:
//     GND — above ground level
//     MSL — mean sea level
//     STD — ISA standard datum (typical for FL values)
//   UNL — unlimited ceiling; preserved as null numeric with label "UNL".
//
// Anything else throws. No silent fallbacks (per AGENTS.md).

export type VerticalReference = 'GND' | 'MSL' | 'STD' | 'UNL'

export interface VerticalLimit {
  readonly metres: number | null
  readonly reference: VerticalReference
  readonly label: string
}

export interface RawVerticalLimit {
  readonly value: number | null
  readonly unit: 'FT' | 'M' | 'FL' | null
  readonly referenceDatum: 'GND' | 'MSL' | 'STD' | null
}

const FT_PER_FL = 100
const M_PER_FT = 0.3048

const isUnlimited = (raw: RawVerticalLimit): boolean =>
  raw.value === null || raw.value >= 99000

const labelFor = (raw: RawVerticalLimit, reference: VerticalReference): string => {
  if (reference === 'UNL') return 'UNL'
  if (raw.value === null || raw.unit === null) return reference
  if (raw.unit === 'FL') return `FL${String(raw.value).padStart(3, '0')}`
  if (raw.unit === 'FT' && raw.value === 0 && reference === 'GND') return 'GND'
  if (raw.unit === 'M') return `${raw.value} m ${reference}`
  return `${raw.value} ft ${reference}`
}

const referenceFor = (raw: RawVerticalLimit): VerticalReference => {
  if (isUnlimited(raw)) return 'UNL'
  if (raw.referenceDatum === 'GND') return 'GND'
  if (raw.referenceDatum === 'MSL') return 'MSL'
  if (raw.referenceDatum === 'STD') return 'STD'
  if (raw.unit === 'FL' && raw.referenceDatum === null) return 'STD'
  throw new Error(`vertical-limit: unrecognised referenceDatum ${raw.referenceDatum ?? '<null>'} (value=${raw.value}, unit=${raw.unit})`)
}

const metresFor = (raw: RawVerticalLimit): number | null => {
  if (isUnlimited(raw)) return null
  if (raw.value === null || raw.unit === null) {
    throw new Error('vertical-limit: missing value or unit for a non-unlimited limit')
  }
  switch (raw.unit) {
    case 'M': return raw.value
    case 'FT': return raw.value * M_PER_FT
    case 'FL': return raw.value * FT_PER_FL * M_PER_FT
    default: throw new Error(`vertical-limit: unrecognised unit ${raw.unit}`)
  }
}

export const normaliseVerticalLimit = (raw: RawVerticalLimit): VerticalLimit => {
  const reference = referenceFor(raw)
  const metres = metresFor(raw)
  return { metres, reference, label: labelFor(raw, reference) }
}
