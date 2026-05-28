import type { GeoJsonGeometry, NormalizedFeature } from '../../../reference-data/types.ts'
import type { GridReferenceCategory, GridReferenceFeatureProperties } from '../schemas/grid-reference.ts'

export interface OsmPowerFeatureInput {
  readonly source: string
  readonly elementType: 'node' | 'way' | 'relation'
  readonly id: number
  readonly tags: Readonly<Record<string, string>>
  readonly geometry: GeoJsonGeometry
  readonly geometrySource: GridReferenceFeatureProperties['geometrySource']
  readonly confidencePenalty?: boolean
}

export const numericTag = (tags: Readonly<Record<string, string>>, key: string): number | null => {
  const value = tags[key]
  if (!value) return null
  const match = value.replace(',', '.').match(/-?\d+(?:\.\d+)?/)
  if (!match) return null
  const parsed = Number(match[0])
  return Number.isFinite(parsed) ? parsed : null
}

export const positiveNumericTag = (tags: Readonly<Record<string, string>>, key: string): number | null => {
  const parsed = numericTag(tags, key)
  return parsed !== null && parsed > 0 ? parsed : null
}

const scaleOutputMw = (raw: string, value: number): number => {
  const lower = raw.toLowerCase()
  if (lower.includes('gw')) return value * 1000
  if (lower.includes('kw')) return value / 1000
  if (lower.includes('w') && !lower.includes('mw')) return value / 1_000_000
  return value
}

export const outputMw = (tags: Readonly<Record<string, string>>): number | null => {
  for (const key of ['plant:output:electricity', 'generator:output:electricity', 'output']) {
    const raw = tags[key]
    if (!raw) continue
    const parsed = positiveNumericTag(tags, key)
    if (parsed !== null) return scaleOutputMw(raw, parsed)
  }
  return null
}

export const voltageKv = (tags: Readonly<Record<string, string>>): ReadonlyArray<number> => {
  const value = tags.voltage ?? ''
  const parsed = value
    .split(/[;,]/)
    .flatMap(part => {
      const match = part.trim().replace(',', '.').match(/\d+(?:\.\d+)?/)
      return match ? [Number(match[0])] : []
    })
    .filter(value => Number.isFinite(value) && value > 0)
    .map(value => value >= 1000 ? value / 1000 : value)
  return [...new Set(parsed)].sort((left, right) => right - left)
}

export const maximumVoltageKv = (values: ReadonlyArray<number>): number | null =>
  values.length === 0 ? null : Math.max(...values)

export const categoryForPower = (power: string | undefined): GridReferenceCategory => {
  if (power === 'line') return 'line'
  if (power === 'cable') return 'cable'
  if (power === 'substation') return 'substation'
  if (power === 'transformer') return 'transformer'
  if (power === 'plant') return 'plant'
  if (power === 'generator') return 'generator'
  return 'unknown'
}

const hasTransmissionVoltage = (properties: GridReferenceFeatureProperties): boolean =>
  (properties.maxVoltageKv ?? 0) >= 66

const hasMaterialGeneration = (properties: GridReferenceFeatureProperties): boolean =>
  (properties.outputMw ?? 0) >= 10 || hasTransmissionVoltage(properties)

export const includeReferenceFeature = (properties: GridReferenceFeatureProperties): boolean => {
  if (properties.category === 'line' || properties.category === 'cable' || properties.category === 'transformer') {
    return hasTransmissionVoltage(properties)
  }
  if (properties.category === 'substation') return hasTransmissionVoltage(properties)
  if (properties.category === 'plant' || properties.category === 'generator') return hasMaterialGeneration(properties)
  return false
}

const assetKindForCategory = (
  category: GridReferenceCategory,
): GridReferenceFeatureProperties['assetKind'] => {
  if (category === 'line' || category === 'cable' || category === 'transformer') return 'branch'
  if (category === 'substation') return 'node'
  if (category === 'plant' || category === 'generator') return 'generator'
  if (category === 'load') return 'load'
  return 'unknown'
}

export const buildOsmPowerFeature = (
  input: OsmPowerFeatureInput,
): NormalizedFeature | null => {
  const category = categoryForPower(input.tags.power)
  if (category === 'unknown') return null
  const voltages = voltageKv(input.tags)
  const maxVoltage = maximumVoltageKv(voltages)
  const output = outputMw(input.tags)
  const hasKeyElectricalProperties = voltages.length > 0 ||
    input.tags.frequency !== undefined ||
    output !== null
  const properties: GridReferenceFeatureProperties = {
    source: input.source,
    category,
    assetKind: assetKindForCategory(category),
    externalId: `${input.elementType}/${input.id}`,
    name: input.tags.name ?? input.tags.ref ?? null,
    operator: input.tags.operator ?? input.tags.owner ?? null,
    voltageKv: [...voltages],
    maxVoltageKv: maxVoltage,
    frequencyHz: positiveNumericTag(input.tags, 'frequency'),
    circuits: positiveNumericTag(input.tags, 'circuits'),
    cables: positiveNumericTag(input.tags, 'cables'),
    power: input.tags.power ?? null,
    plantSource: input.tags['plant:source'] ?? input.tags['generator:source'] ?? null,
    outputMw: output,
    geometrySource: input.geometrySource,
    propertyProvenance: hasKeyElectricalProperties ? 'observed' : 'unknown',
    confidence: input.confidencePenalty ? 'low' : hasKeyElectricalProperties ? 'high' : 'medium',
    tags: { ...input.tags },
  }
  if (!includeReferenceFeature(properties)) return null
  return {
    type: 'Feature',
    id: `${input.source}:${input.elementType}:${input.id}`,
    geometry: input.geometry,
    properties,
  }
}
