import { join, resolve } from 'node:path'
import { readTerrainPmtilesMetadata, type TerrainDemEncoding } from '../../src/map/terrain-artifact.ts'
import { createMapPipelineConfig } from './config.ts'

const demEncodingFromEnv = (): TerrainDemEncoding => {
  const value = process.env.LEITBILD_TERRAIN_DEM_ENCODING ?? 'terrarium'
  if (value === 'terrarium' || value === 'mapbox') return value
  throw new Error(`unsupported LEITBILD_TERRAIN_DEM_ENCODING "${value}"`)
}

const config = createMapPipelineConfig()
const filePath = resolve(process.env.LEITBILD_TERRAIN_PMTILES_PATH ?? join(config.rootDir, 'current', 'terrain.pmtiles'))
const metadata = await readTerrainPmtilesMetadata({
  filePath,
  demEncoding: demEncodingFromEnv(),
})

console.log(JSON.stringify(metadata, null, 2))
