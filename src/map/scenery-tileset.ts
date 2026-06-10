import {
  sceneryAssetFormat,
  sceneryAssetTilesetSchema,
  sceneryAssetTileEncoding,
  sceneryAssetTileTemplate,
  type SceneryAssetBounds,
  type SceneryAssetLodLevel,
  type SceneryAssetTileset,
  type SceneryAssetTileSummary,
  type SceneryTilesetFeatureCounts,
  type SceneryTilesetTile,
} from './scenery.ts'

interface SceneryTilesetBuildConfig {
  readonly tilesetId: string
  readonly sourceTilesetId: string
  readonly sourcePmtilesPath: string
  readonly builtAt: string
  readonly bounds: SceneryAssetBounds
  readonly zooms: ReadonlyArray<number>
  readonly lodLevels: ReadonlyArray<SceneryAssetLodLevel>
  readonly inputArtifacts: ReadonlyArray<{
    readonly kind: 'base-vector-pmtiles' | 'terrain-dem-pmtiles' | 'reference-pmtiles' | 'reference-sidecar-geojson'
    readonly id: string
    readonly path: string
    readonly required: boolean
  }>
  readonly recipes: ReadonlyArray<unknown>
  readonly outputRoot: string
  readonly counts: SceneryAssetTileset['extras']['leitbild']['counts']
  readonly tiles: ReadonlyArray<SceneryAssetTileSummary>
}

interface TileCoord {
  readonly z: number
  readonly x: number
  readonly y: number
}

interface TileNode {
  readonly coord: TileCoord
  summary: SceneryAssetTileSummary | null
  readonly children: Map<string, TileNode>
}

interface TileAggregate {
  readonly minHeightM: number
  readonly maxHeightM: number
  readonly byteLength: number
  readonly featureCounts: SceneryTilesetFeatureCounts
}

const metersPerDegreeLat = 111_320

const zeroFeatureCounts = (): SceneryTilesetFeatureCounts => ({
  polygons: 0,
  lines: 0,
  labels: 0,
  buildings: 0,
  roads: 0,
  water: 0,
  vegetation: 0,
})

const addFeatureCounts = (
  left: SceneryTilesetFeatureCounts,
  right: SceneryTilesetFeatureCounts,
): SceneryTilesetFeatureCounts => ({
  polygons: left.polygons + right.polygons,
  lines: left.lines + right.lines,
  labels: left.labels + right.labels,
  buildings: left.buildings + right.buildings,
  roads: left.roads + right.roads,
  water: left.water + right.water,
  vegetation: left.vegetation + right.vegetation,
})

const metersPerDegreeLonAt = (latDeg: number): number =>
  Math.max(1, Math.cos(latDeg * Math.PI / 180) * metersPerDegreeLat)

const tileKey = (coord: TileCoord): string =>
  `${coord.z}/${coord.x}/${coord.y}`

export const sceneryTileCenterLonLat = (
  tile: TileCoord,
): { readonly lon: number; readonly lat: number } => {
  const size = 2 ** tile.z
  const lon = (tile.x + 0.5) / size * 360 - 180
  const n = Math.PI - 2 * Math.PI * (tile.y + 0.5) / size
  const lat = 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)))
  return { lon, lat }
}

const tileCornerLonLat = (
  tile: TileCoord,
  cornerX: number,
  cornerY: number,
): { readonly lon: number; readonly lat: number } => {
  const size = 2 ** tile.z
  const lon = (tile.x + cornerX) / size * 360 - 180
  const n = Math.PI - 2 * Math.PI * (tile.y + cornerY) / size
  const lat = 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)))
  return { lon, lat }
}

export const sceneryTileBounds = (
  tile: TileCoord,
): SceneryAssetBounds => {
  const northWest = tileCornerLonLat(tile, 0, 0)
  const southEast = tileCornerLonLat(tile, 1, 1)
  return {
    minLon: northWest.lon,
    minLat: southEast.lat,
    maxLon: southEast.lon,
    maxLat: northWest.lat,
  }
}

const boundsCenter = (
  bounds: SceneryAssetBounds,
): { readonly lon: number; readonly lat: number } => ({
  lon: (bounds.minLon + bounds.maxLon) / 2,
  lat: (bounds.minLat + bounds.maxLat) / 2,
})

const localOffsetFromLonLat = (config: {
  readonly lon: number
  readonly lat: number
  readonly originLon: number
  readonly originLat: number
}): { readonly x: number; readonly z: number } => ({
  x: (config.lon - config.originLon) * metersPerDegreeLonAt(config.originLat),
  z: -(config.lat - config.originLat) * metersPerDegreeLat,
})

const tileSizeMeters = (
  bounds: SceneryAssetBounds,
  centerLat: number,
): { readonly widthM: number; readonly depthM: number } => ({
  widthM: Math.max(1, Math.abs(bounds.maxLon - bounds.minLon) * metersPerDegreeLonAt(centerLat)),
  depthM: Math.max(1, Math.abs(bounds.maxLat - bounds.minLat) * metersPerDegreeLat),
})

const geometricErrorForTile = (
  tile: TileCoord,
): number => {
  const center = sceneryTileCenterLonLat(tile)
  const bounds = sceneryTileBounds(tile)
  const size = tileSizeMeters(bounds, center.lat)
  return Math.max(0.75, Math.max(size.widthM, size.depthM) / 96)
}

const translationTransform = (
  x: number,
  y: number,
  z: number,
): ReadonlyArray<number> => [
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 1, 0,
  x, y, z, 1,
]

const tileBox = (config: {
  readonly coord: TileCoord
  readonly minHeightM: number
  readonly maxHeightM: number
}): ReadonlyArray<number> => {
  const center = sceneryTileCenterLonLat(config.coord)
  const size = tileSizeMeters(sceneryTileBounds(config.coord), center.lat)
  const heightM = Math.max(1, config.maxHeightM - config.minHeightM)
  const centerHeightM = (config.minHeightM + config.maxHeightM) / 2
  return [
    0, centerHeightM, 0,
    size.widthM / 2, 0, 0,
    0, heightM / 2, 0,
    0, 0, size.depthM / 2,
  ]
}

const rootBox = (config: {
  readonly bounds: SceneryAssetBounds
  readonly minHeightM: number
  readonly maxHeightM: number
}): ReadonlyArray<number> => {
  const center = boundsCenter(config.bounds)
  const size = tileSizeMeters(config.bounds, center.lat)
  const heightM = Math.max(1, config.maxHeightM - config.minHeightM)
  const centerHeightM = (config.minHeightM + config.maxHeightM) / 2
  return [
    0, centerHeightM, 0,
    size.widthM / 2, 0, 0,
    0, heightM / 2, 0,
    0, 0, size.depthM / 2,
  ]
}

const rootGeometricError = (
  bounds: SceneryAssetBounds,
): number => {
  const center = boundsCenter(bounds)
  const size = tileSizeMeters(bounds, center.lat)
  return Math.max(1, Math.max(size.widthM, size.depthM) / 32)
}

const parentCoordFor = (
  coord: TileCoord,
): TileCoord | null =>
  coord.z <= 0 ? null : { z: coord.z - 1, x: Math.floor(coord.x / 2), y: Math.floor(coord.y / 2) }

const ensureNode = (
  nodes: Map<string, TileNode>,
  coord: TileCoord,
): TileNode => {
  const key = tileKey(coord)
  const existing = nodes.get(key)
  if (existing) return existing
  const node: TileNode = { coord, summary: null, children: new Map() }
  nodes.set(key, node)
  const parent = parentCoordFor(coord)
  if (parent) ensureNode(nodes, parent).children.set(key, node)
  return node
}

const buildTree = (
  tiles: ReadonlyArray<SceneryAssetTileSummary>,
): ReadonlyArray<TileNode> => {
  const nodes = new Map<string, TileNode>()
  for (const summary of tiles) {
    const node = ensureNode(nodes, summary)
    node.summary = summary
  }
  return [...nodes.values()]
    .filter(node => node.coord.z === 0)
    .sort((left, right) => left.coord.x - right.coord.x || left.coord.y - right.coord.y)
}

const aggregateFor = (
  summary: SceneryAssetTileSummary | null,
  children: ReadonlyArray<TileAggregate>,
): TileAggregate => {
  const self = summary
    ? {
        minHeightM: summary.minHeightM,
        maxHeightM: summary.maxHeightM,
        byteLength: summary.byteLength,
        featureCounts: summary.featureCounts,
      }
    : {
        minHeightM: Number.POSITIVE_INFINITY,
        maxHeightM: Number.NEGATIVE_INFINITY,
        byteLength: 0,
        featureCounts: zeroFeatureCounts(),
      }
  const childCounts = children.reduce(
    (counts, child) => addFeatureCounts(counts, child.featureCounts),
    zeroFeatureCounts(),
  )
  return {
    minHeightM: Math.min(self.minHeightM, ...children.map(child => child.minHeightM), 0),
    maxHeightM: Math.max(self.maxHeightM, ...children.map(child => child.maxHeightM), 1),
    byteLength: self.byteLength + children.reduce((sum, child) => sum + child.byteLength, 0),
    featureCounts: addFeatureCounts(self.featureCounts, childCounts),
  }
}

const contentUriFor = (
  summary: SceneryAssetTileSummary,
): string =>
  `${encodeURIComponent(summary.recipeId)}/${summary.z}/${summary.x}/${summary.y}.glb`

const buildTile = (config: {
  readonly node: TileNode
  readonly originLon: number
  readonly originLat: number
}): { readonly tile: SceneryTilesetTile; readonly aggregate: TileAggregate } => {
  const children = [...config.node.children.values()]
    .sort((left, right) => left.coord.x - right.coord.x || left.coord.y - right.coord.y)
    .map(child => buildTile({ node: child, originLon: config.originLon, originLat: config.originLat }))
  const aggregate = aggregateFor(config.node.summary, children.map(child => child.aggregate))
  const center = sceneryTileCenterLonLat(config.node.coord)
  const offset = localOffsetFromLonLat({
    lon: center.lon,
    lat: center.lat,
    originLon: config.originLon,
    originLat: config.originLat,
  })
  const baseError = config.node.summary?.lod.geometricErrorM ?? geometricErrorForTile(config.node.coord)
  const childError = Math.max(0, ...children.map(child => child.tile.geometricError * 1.9))
  const tile: SceneryTilesetTile = {
    boundingVolume: {
      box: tileBox({
        coord: config.node.coord,
        minHeightM: aggregate.minHeightM,
        maxHeightM: aggregate.maxHeightM,
      }),
    },
    geometricError: Math.max(baseError, childError),
    refine: 'REPLACE',
    transform: translationTransform(offset.x, 0, offset.z),
    ...(config.node.summary
      ? {
          content: {
            uri: contentUriFor(config.node.summary),
            mimeType: sceneryAssetTileEncoding,
            extras: {
              leitbild: {
                recipeId: config.node.summary.recipeId,
                z: config.node.summary.z,
                x: config.node.summary.x,
                y: config.node.summary.y,
                byteLength: config.node.summary.byteLength,
                centerLon: config.node.summary.centerLon,
                centerLat: config.node.summary.centerLat,
                minHeightM: config.node.summary.minHeightM,
                maxHeightM: config.node.summary.maxHeightM,
                featureCounts: config.node.summary.featureCounts,
              },
            },
          },
        }
      : {}),
    ...(children.length > 0 ? { children: children.map(child => child.tile) } : {}),
    extras: {
      leitbild: {
        tileKey: tileKey(config.node.coord),
        ...(config.node.summary
          ? {
              recipeId: config.node.summary.recipeId,
              z: config.node.summary.z,
              x: config.node.summary.x,
              y: config.node.summary.y,
            }
          : {
              z: config.node.coord.z,
              x: config.node.coord.x,
              y: config.node.coord.y,
            }),
        hasContent: config.node.summary !== null,
        aggregateByteLength: aggregate.byteLength,
        aggregateFeatureCounts: aggregate.featureCounts,
      },
    },
  }
  return { tile, aggregate }
}

export const buildSceneryTilesetDocument = (
  config: SceneryTilesetBuildConfig,
): SceneryAssetTileset => {
  if (config.tiles.length === 0) {
    throw new Error('cannot build scenery 3D Tiles document without content tiles')
  }
  const origin = boundsCenter(config.bounds)
  const rootChildren = buildTree(config.tiles)
    .map(node => buildTile({ node, originLon: origin.lon, originLat: origin.lat }))
  const rootAggregate = aggregateFor(null, rootChildren.map(child => child.aggregate))
  const geometricError = Math.max(rootGeometricError(config.bounds), ...rootChildren.map(child => child.tile.geometricError * 2))
  const document = {
    asset: {
      version: '1.1' as const,
      tilesetVersion: config.builtAt,
      gltfUpAxis: 'z' as const,
      generator: 'Leitbild scenery 3D Tiles compiler',
    },
    geometricError,
    root: {
      boundingVolume: {
        box: rootBox({
          bounds: config.bounds,
          minHeightM: rootAggregate.minHeightM,
          maxHeightM: rootAggregate.maxHeightM,
        }),
      },
      geometricError,
      refine: 'REPLACE' as const,
      children: rootChildren.map(child => child.tile),
      extras: {
        leitbild: {
          tileKey: 'root',
          hasContent: false,
          aggregateByteLength: rootAggregate.byteLength,
          aggregateFeatureCounts: rootAggregate.featureCounts,
        },
      },
    },
    extras: {
      leitbild: {
        schemaVersion: 2 as const,
        artifactFormat: sceneryAssetFormat,
        tileEncoding: sceneryAssetTileEncoding,
        tilesetId: config.tilesetId,
        sourceTilesetId: config.sourceTilesetId,
        sourcePmtilesPath: config.sourcePmtilesPath,
        builtAt: config.builtAt,
        bounds: config.bounds,
        origin: {
          lon: origin.lon,
          lat: origin.lat,
          heightM: 0,
        },
        zooms: config.zooms,
        lodLevels: config.lodLevels,
        inputArtifacts: config.inputArtifacts,
        recipes: config.recipes,
        tileTemplate: sceneryAssetTileTemplate,
        outputRoot: config.outputRoot,
        counts: config.counts,
        tiles: config.tiles,
      },
    },
  }
  return sceneryAssetTilesetSchema.parse(document)
}
