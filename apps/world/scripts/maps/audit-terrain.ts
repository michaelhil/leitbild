import { join, resolve } from 'node:path'
import { createPmtilesElevationSamplerFactory, type ElevationSamplerBounds } from '../../src/map/pmtiles-elevation-sampler.ts'
import type { TerrainDemEncoding } from '../../src/map/terrain-artifact.ts'
import { createMapPipelineConfig } from './config.ts'

interface AuditPoint {
  readonly id: string
  readonly lon: number
  readonly lat: number
}

const terrainDemEncodingFromEnv = (): TerrainDemEncoding => {
  const raw = process.env.LEITBILD_TERRAIN_DEM_ENCODING ?? 'terrarium'
  if (raw === 'terrarium' || raw === 'mapbox') return raw
  throw new Error('LEITBILD_TERRAIN_DEM_ENCODING must be terrarium or mapbox')
}

const positiveNumberEnv = (
  key: string,
  defaultValue: number,
): number => {
  const raw = process.env[key]
  if (raw === undefined || raw.trim() === '') return defaultValue
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${key} must be a positive finite number`)
  return value
}

const auditPoints: ReadonlyArray<AuditPoint> = [
  { id: 'oslo-waterfront-bjorvika', lon: 10.7522, lat: 59.9064 },
  { id: 'oslo-city-centre', lon: 10.7387, lat: 59.9139 },
  { id: 'holmenkollen-hill', lon: 10.6654, lat: 59.9637 },
  { id: 'grefsenkollen-hill', lon: 10.7996, lat: 59.9562 },
]

const boundsForPoints = (
  points: ReadonlyArray<AuditPoint>,
): ElevationSamplerBounds => {
  const marginDeg = 0.01
  return {
    minLon: Math.min(...points.map(point => point.lon)) - marginDeg,
    minLat: Math.min(...points.map(point => point.lat)) - marginDeg,
    maxLon: Math.max(...points.map(point => point.lon)) + marginDeg,
    maxLat: Math.max(...points.map(point => point.lat)) + marginDeg,
  }
}

const config = createMapPipelineConfig()
const terrainPath = resolve(process.env.LEITBILD_TERRAIN_PMTILES_PATH ?? join(config.rootDir, 'current', 'terrain.pmtiles'))
const minExpectedReliefM = positiveNumberEnv('LEITBILD_TERRAIN_AUDIT_MIN_OSLO_RELIEF_M', 150)
const maxExpectedWaterfrontM = positiveNumberEnv('LEITBILD_TERRAIN_AUDIT_MAX_WATERFRONT_M', 80)
const reference = auditPoints[1]!
const factory = await createPmtilesElevationSamplerFactory({
  filePath: terrainPath,
  demEncoding: terrainDemEncodingFromEnv(),
  reference,
})
const sampler = await factory.samplerForBounds(boundsForPoints(auditPoints))
const samples = auditPoints.map(point => {
  const relativeHeightM = sampler.heightAtLonLat(point)
  return {
    ...point,
    relativeHeightM,
    absoluteHeightM: relativeHeightM + factory.reference.absoluteHeightM,
  }
})
const waterfront = samples.find(sample => sample.id === 'oslo-waterfront-bjorvika')
const hills = samples.filter(sample => sample.id.endsWith('-hill'))
if (!waterfront) throw new Error('terrain audit internal error: missing waterfront sample')
const firstHill = hills[0]
if (!firstHill) throw new Error('terrain audit internal error: missing hill samples')
const maxHill = hills.reduce((highest, sample) => sample.absoluteHeightM > highest.absoluteHeightM ? sample : highest, firstHill)
const reliefM = maxHill.absoluteHeightM - waterfront.absoluteHeightM
const failures = [
  waterfront.absoluteHeightM > maxExpectedWaterfrontM
    ? `waterfront height ${waterfront.absoluteHeightM.toFixed(1)}m exceeds ${maxExpectedWaterfrontM}m`
    : null,
  reliefM < minExpectedReliefM
    ? `Oslo hill relief ${reliefM.toFixed(1)}m is below ${minExpectedReliefM}m`
    : null,
].filter((failure): failure is string => failure !== null)
if (failures.length > 0) {
  throw new Error(`terrain audit failed for ${terrainPath}: ${failures.join('; ')}`)
}

console.log(JSON.stringify({
  terrainPath,
  demEncoding: factory.demEncoding,
  zoom: factory.zoom,
  reference: factory.reference,
  reliefM,
  samples,
}, null, 2))
