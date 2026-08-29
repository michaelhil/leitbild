import type { PackReferenceDatasetBuilder } from '../../core/packs/protocol.ts'
import { createGridNorwayDataset, gridNorwayDatasetId } from './datasets/grid-norway.ts'

const parseBbox = (
  value: string | undefined,
): { readonly south: number; readonly west: number; readonly north: number; readonly east: number } => {
  const fallback = { south: 57.5, west: 4.0, north: 71.5, east: 31.5 }
  if (!value) return fallback
  const parts = value.split(',').map(part => Number(part.trim()))
  if (parts.length !== 4) {
    throw new Error('electric-grid pack: GRID_NORWAY_BBOX must be "south,west,north,east"')
  }
  const [south, west, north, east] = parts as [number, number, number, number]
  if (!Number.isFinite(south) || !Number.isFinite(west) || !Number.isFinite(north) || !Number.isFinite(east)) {
    throw new Error('electric-grid pack: GRID_NORWAY_BBOX must be "south,west,north,east"')
  }
  if (south >= north || west >= east) {
    throw new Error('electric-grid pack: GRID_NORWAY_BBOX must have south < north and west < east')
  }
  return { south, west, north, east }
}

export const electricGridReferenceDatasetBuilders: ReadonlyArray<PackReferenceDatasetBuilder> = [{
  id: gridNorwayDatasetId,
  build: (env) => createGridNorwayDataset({
    bbox: parseBbox(env.GRID_NORWAY_BBOX),
    sourceMode: env.GRID_NORWAY_SOURCE === 'overpass'
      ? 'overpass'
      : env.GRID_NORWAY_SOURCE === 'nve-nettanlegg'
        ? 'nve-nettanlegg'
        : 'osm-pbf',
    ...(env.GRID_NORWAY_OSM_PBF_PATH !== undefined ? { osmPbfPath: env.GRID_NORWAY_OSM_PBF_PATH } : {}),
    ...(env.GRID_NORWAY_OSM_PBF_URL !== undefined ? { osmPbfDownloadUrl: env.GRID_NORWAY_OSM_PBF_URL } : {}),
    ...(env.GRID_NORWAY_OSM_PBF_USER_AGENT !== undefined ? { osmPbfUserAgent: env.GRID_NORWAY_OSM_PBF_USER_AGENT } : {}),
    ...(env.GRID_NORWAY_OVERPASS_URL !== undefined ? { overpassEndpointUrl: env.GRID_NORWAY_OVERPASS_URL } : {}),
    ...(env.GRID_NORWAY_OVERPASS_USER_AGENT !== undefined ? { overpassUserAgent: env.GRID_NORWAY_OVERPASS_USER_AGENT } : {}),
    ...(env.GRID_NORWAY_NVE_NETTANLEGG_URL !== undefined ? { nveNettanleggEndpointUrl: env.GRID_NORWAY_NVE_NETTANLEGG_URL } : {}),
  }),
}]
