import { describe, expect, test } from 'bun:test'
import { compileSceneryGlbTile } from '../src/map/scenery-glb.ts'
import { sceneryRoadTileFromSceneryTile, sceneryRoadTileSchema, type SceneryTile } from '../src/map/scenery.ts'
import {
  droneSceneryTileCacheBudget,
  estimateDroneSceneryTileBytesForCache,
} from '../src/ui/drone/drone-scenery-tiles.ts'
import { buildRoadSurfaceMeshes, roadTileUrlFromModelUrl } from '../src/ui/drone/drone-road-overlay.ts'

const readAscii = (
  bytes: Uint8Array,
  start: number,
  length: number,
): string =>
  new TextDecoder().decode(bytes.slice(start, start + length))

const glbJson = (
  bytes: Uint8Array,
): Record<string, unknown> => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const jsonLength = view.getUint32(12, true)
  const jsonType = view.getUint32(16, true)
  expect(jsonType).toBe(0x4e4f534a)
  return JSON.parse(readAscii(bytes, 20, jsonLength).trim()) as Record<string, unknown>
}

const recordArray = (value: unknown): ReadonlyArray<Record<string, unknown>> =>
  Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => item !== null && typeof item === 'object' && !Array.isArray(item))
    : []

const usedMaterialNames = (
  json: Record<string, unknown>,
): ReadonlySet<unknown> => {
  const materials = recordArray(json.materials)
  const meshes = recordArray(json.meshes)
  const used = new Set<unknown>()
  for (const mesh of meshes) {
    for (const primitive of recordArray(mesh.primitives)) {
      const materialIndex = primitive.material
      if (typeof materialIndex !== 'number') continue
      used.add(materials[materialIndex]?.name)
    }
  }
  return used
}

const glbBinaryChunk = (
  bytes: Uint8Array,
): Uint8Array => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const jsonLength = view.getUint32(12, true)
  const binHeaderOffset = 20 + ((jsonLength + 3) & ~3)
  const binLength = view.getUint32(binHeaderOffset, true)
  const binType = view.getUint32(binHeaderOffset + 4, true)
  expect(binType).toBe(0x004e4942)
  return bytes.slice(binHeaderOffset + 8, binHeaderOffset + 8 + binLength)
}

const numberRecord = (value: unknown): Record<string, number> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).filter((entry): entry is [string, number] => typeof entry[1] === 'number'))
    : {}

const primitivePositionsByMaterialName = (
  bytes: Uint8Array,
  materialNamePattern: RegExp,
): ReadonlyArray<ReadonlyArray<readonly [number, number, number]>> => {
  const json = glbJson(bytes)
  const bin = glbBinaryChunk(bytes)
  const materials = recordArray(json.materials)
  const meshes = recordArray(json.meshes)
  const accessors = recordArray(json.accessors)
  const bufferViews = recordArray(json.bufferViews)
  const matchingMaterialIndexes = new Set(
    materials.flatMap((material, index) => materialNamePattern.test(String(material.name ?? '')) ? [index] : []),
  )
  const primitives = meshes.flatMap(mesh => recordArray(mesh.primitives))
  return primitives.flatMap(primitive => {
    if (!matchingMaterialIndexes.has(Number(primitive.material))) return []
    const attributes = numberRecord(primitive.attributes)
    const accessor = accessors[attributes.POSITION ?? -1]
    if (!accessor) return []
    const bufferView = bufferViews[Number(accessor.bufferView)]
    if (!bufferView) return []
    const count = Number(accessor.count)
    const byteOffset = Number(bufferView.byteOffset ?? 0) + Number(accessor.byteOffset ?? 0)
    const view = new DataView(bin.buffer, bin.byteOffset + byteOffset, count * 12)
    const positions: Array<readonly [number, number, number]> = []
    for (let index = 0; index < count; index += 1) {
      const offset = index * 12
      positions.push([
        view.getFloat32(offset, true),
        view.getFloat32(offset + 4, true),
        view.getFloat32(offset + 8, true),
      ])
    }
    return [positions]
  })
}

const coordinatePlanesFor = (
  positions: ReadonlyArray<ReadonlyArray<readonly [number, number, number]>>,
): {
  readonly minX: number
  readonly maxX: number
  readonly minZ: number
  readonly maxZ: number
} => {
  const flat = positions.flat()
  return {
    minX: Math.min(...flat.map(position => position[0])),
    maxX: Math.max(...flat.map(position => position[0])),
    minZ: Math.min(...flat.map(position => position[2])),
    maxZ: Math.max(...flat.map(position => position[2])),
  }
}

const facadeReliefOffset = (
  position: readonly [number, number, number],
  planes: ReturnType<typeof coordinatePlanesFor>,
): number | null => {
  const offsets = [
    position[0] < planes.minX ? planes.minX - position[0] : null,
    position[0] > planes.maxX ? position[0] - planes.maxX : null,
    position[2] < planes.minZ ? planes.minZ - position[2] : null,
    position[2] > planes.maxZ ? position[2] - planes.maxZ : null,
  ].filter((value): value is number => value !== null)
  return offsets.length === 0 ? null : Math.min(...offsets)
}

const roundedYValues = (
  positions: ReadonlyArray<ReadonlyArray<readonly [number, number, number]>>,
): ReadonlyArray<number> => [
  ...new Set(positions.flat().map(position => Number(position[1].toFixed(3)))),
].sort((left, right) => left - right)

const firstYValue = (
  bytes: Uint8Array,
  materialNamePattern: RegExp,
): number => {
  const values = roundedYValues(primitivePositionsByMaterialName(bytes, materialNamePattern))
  expect(values.length).toBeGreaterThan(0)
  return values[0]!
}

const tilePoint = (x: number, y: number): [number, number] => [x, y]

const testTile: SceneryTile = {
  schemaVersion: 1,
  tileEncoding: 'leitbild-scenery-feature-json-v1',
  recipeId: 'drone-urban-flight',
  sourceTilesetId: 'leitbild-osm-norway',
  tile: { z: 14, x: 8686, y: 4758, extent: 4096 },
  features: {
    polygons: [
      {
        id: 'building:1',
        sourceLayer: 'building',
        kind: 'building',
        className: 'commercial',
        rings: [[
          tilePoint(1600, 1800),
          tilePoint(1900, 1800),
          tilePoint(1900, 2100),
          tilePoint(1600, 2100),
          tilePoint(1600, 1800),
        ]],
        heightM: 26,
      },
      {
        id: 'water:1',
        sourceLayer: 'water',
        kind: 'water',
        className: 'river',
        rings: [[
          tilePoint(2150, 1850),
          tilePoint(2650, 1850),
          tilePoint(2650, 2180),
          tilePoint(2150, 2180),
          tilePoint(2150, 1850),
        ]],
      },
      {
        id: 'park:1',
        sourceLayer: 'landuse',
        kind: 'landuse',
        className: 'park',
        rings: [[
          tilePoint(1200, 2450),
          tilePoint(1850, 2450),
          tilePoint(1850, 3180),
          tilePoint(1200, 3180),
          tilePoint(1200, 2450),
        ]],
      },
    ],
    lines: [
      {
        id: 'road:1',
        sourceLayer: 'transportation',
        sourceRef: 'osm:way:1',
        kind: 'road',
        className: 'primary',
        name: 'Renderer Test Road',
        isBridge: false,
        isTunnel: false,
        path: [
          tilePoint(900, 1650),
          tilePoint(1800, 1900),
          tilePoint(3100, 1980),
        ],
        widthM: 17,
        verticalOffsetM: 0,
      },
      {
        id: 'waterway:1',
        sourceLayer: 'waterway',
        kind: 'waterway',
        className: 'stream',
        isBridge: false,
        isTunnel: false,
        path: [
          tilePoint(2500, 1700),
          tilePoint(2800, 2250),
        ],
        widthM: 7,
        verticalOffsetM: 0,
      },
    ],
    labels: [
      {
        id: 'poi:1',
        sourceLayer: 'poi',
        kind: 'poi',
        className: 'hospital',
        label: 'Hospital',
        point: tilePoint(1740, 1720),
      },
    ],
  },
}

const testTileAtZoom = (
  z: number,
  x: number,
  y: number,
): SceneryTile => ({
  ...testTile,
  tile: {
    ...testTile.tile,
    z,
    x,
    y,
  },
})

const denseBudgetTile = (): SceneryTile => {
  const buildings: SceneryTile['features']['polygons'] = []
  const roads: SceneryTile['features']['lines'] = []
  const labels: SceneryTile['features']['labels'] = []
  for (let index = 0; index < 960; index += 1) {
    const column = index % 32
    const row = Math.floor(index / 32)
    const x = 140 + column * 118
    const y = 180 + row * 118
    buildings.push({
      id: `dense-building:${index}`,
      sourceLayer: 'building',
      kind: 'building',
      className: index % 5 === 0 ? 'commercial' : 'residential',
      rings: [[
        tilePoint(x, y),
        tilePoint(x + 52, y),
        tilePoint(x + 52, y + 52),
        tilePoint(x, y + 52),
        tilePoint(x, y),
      ]],
      heightM: 12 + index % 7 * 3,
    })
  }
  for (let index = 0; index < 960; index += 1) {
    const offset = 110 + index % 120 * 32
    roads.push({
      id: `dense-road:${index}`,
      sourceLayer: 'transportation',
      sourceRef: `osm:way:${index}`,
      kind: 'road',
      className: index % 4 === 0 ? 'primary' : 'residential',
      name: `Dense Road ${index}`,
      isBridge: false,
      isTunnel: false,
      path: [
        tilePoint(80, offset),
        tilePoint(2000, offset + index % 9 * 9),
        tilePoint(4010, offset + index % 5 * 11),
      ],
      widthM: index % 4 === 0 ? 15 : 8,
      verticalOffsetM: 0,
    })
  }
  for (let index = 0; index < 90; index += 1) {
    labels.push({
      id: `dense-poi:${index}`,
      sourceLayer: 'poi',
      kind: 'poi',
      className: 'hospital',
      label: `Dense POI ${index}`,
      point: tilePoint(180 + index % 18 * 190, 240 + Math.floor(index / 18) * 220),
    })
  }
  return {
    ...testTile,
    features: {
      polygons: buildings,
      lines: roads,
      labels,
    },
  }
}

const crossingRoadTile = (): SceneryTile => ({
  ...testTile,
  features: {
    polygons: [],
    labels: [],
    lines: [
      {
        id: 'crossing-road:a',
        sourceLayer: 'transportation',
        sourceRef: 'osm:way:crossing-a',
        kind: 'road',
        className: 'primary',
        isBridge: false,
        isTunnel: false,
        path: [
          tilePoint(900, 2050),
          tilePoint(3200, 2050),
        ],
        widthM: 16,
        verticalOffsetM: 0,
      },
      {
        id: 'crossing-road:b',
        sourceLayer: 'transportation',
        sourceRef: 'osm:way:crossing-b',
        kind: 'road',
        className: 'primary',
        isBridge: false,
        isTunnel: false,
        path: [
          tilePoint(2050, 900),
          tilePoint(2050, 3200),
        ],
        widthM: 16,
        verticalOffsetM: 0,
      },
    ],
  },
})

const bentRoadTile = (): SceneryTile => ({
  ...testTile,
  features: {
    polygons: [],
    labels: [],
    lines: [
      {
        id: 'bent-road:wide',
        sourceLayer: 'transportation',
        sourceRef: 'osm:way:bent-road',
        kind: 'road',
        className: 'primary',
        isBridge: false,
        isTunnel: false,
        path: [
          tilePoint(760, 2200),
          tilePoint(1550, 1820),
          tilePoint(1850, 2760),
          tilePoint(2580, 2040),
          tilePoint(3380, 2300),
        ],
        widthM: 22,
        verticalOffsetM: 0,
      },
    ],
  },
})

const closedRoadTile = (): SceneryTile => ({
  ...testTile,
  features: {
    polygons: [],
    labels: [],
    lines: [
      {
        id: 'closed-road:ring',
        sourceLayer: 'transportation',
        sourceRef: 'osm:way:closed-road',
        kind: 'road',
        className: 'primary',
        isBridge: false,
        isTunnel: false,
        path: [
          tilePoint(1200, 1200),
          tilePoint(2600, 1200),
          tilePoint(2600, 2600),
          tilePoint(1200, 2600),
          tilePoint(1200, 1200),
        ],
        widthM: 16,
        verticalOffsetM: 0,
      },
    ],
  },
})

const hairpinRoadTile = (): SceneryTile => ({
  ...testTile,
  features: {
    polygons: [],
    labels: [],
    lines: [
      {
        id: 'hairpin-road:fold',
        sourceLayer: 'transportation',
        sourceRef: 'osm:way:hairpin-road',
        kind: 'road',
        className: 'primary',
        isBridge: false,
        isTunnel: false,
        path: [
          tilePoint(1000, 1000),
          tilePoint(1700, 1000),
          tilePoint(1700, 1060),
          tilePoint(1020, 1060),
        ],
        widthM: 16,
        verticalOffsetM: 0,
      },
    ],
  },
})

const parallelRoadShoulderTile = (): SceneryTile => ({
  ...testTile,
  features: {
    polygons: [],
    labels: [],
    lines: [
      {
        id: 'parallel-road:a',
        sourceLayer: 'transportation',
        sourceRef: 'osm:way:parallel-road-a',
        kind: 'road',
        className: 'primary',
        isBridge: false,
        isTunnel: false,
        path: [
          tilePoint(1000, 1000),
          tilePoint(2500, 1000),
        ],
        widthM: 16,
        verticalOffsetM: 0,
      },
      {
        id: 'parallel-road:b',
        sourceLayer: 'transportation',
        sourceRef: 'osm:way:parallel-road-b',
        kind: 'road',
        className: 'primary',
        isBridge: false,
        isTunnel: false,
        path: [
          tilePoint(1000, 1070),
          tilePoint(2500, 1070),
        ],
        widthM: 16,
        verticalOffsetM: 0,
      },
    ],
  },
})

const outOfBoundsTile = (): SceneryTile => ({
  ...testTile,
  features: {
    polygons: [],
    labels: [],
    lines: [
      {
        id: 'out-of-bounds-road',
        sourceLayer: 'transportation',
        sourceRef: 'osm:way:out-of-bounds',
        kind: 'road',
        className: 'primary',
        isBridge: false,
        isTunnel: false,
        path: [
          tilePoint(-120, 2050),
          tilePoint(1200, 2050),
          tilePoint(4300, 2050),
        ],
        widthM: 16,
        verticalOffsetM: 0,
      },
    ],
  },
})

const overlappingSurfaceTile = (): SceneryTile => ({
  ...testTile,
  features: {
    labels: [],
    lines: [],
    polygons: [
      {
        id: 'surface:park',
        sourceLayer: 'landuse',
        sourceRef: 'landuse:park',
        kind: 'landuse',
        className: 'park',
        rings: [[
          tilePoint(1100, 1500),
          tilePoint(2900, 1500),
          tilePoint(2900, 3100),
          tilePoint(1100, 3100),
          tilePoint(1100, 1500),
        ]],
      },
      {
        id: 'surface:wood',
        sourceLayer: 'landcover',
        sourceRef: 'landcover:wood',
        kind: 'landcover',
        className: 'wood',
        rings: [[
          tilePoint(1700, 1850),
          tilePoint(3400, 1850),
          tilePoint(3400, 3400),
          tilePoint(1700, 3400),
          tilePoint(1700, 1850),
        ]],
      },
    ],
  },
})

describe('drone scenery GLB compiler', () => {
  test('precompiles source-backed scenery into one valid GPU-ready GLB tile', () => {
    const result = compileSceneryGlbTile(testTile)
    expect(result).not.toBeNull()
    const { bytes, summary } = result!
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

    expect(view.getUint32(0, true)).toBe(0x46546c67)
    expect(view.getUint32(4, true)).toBe(2)
    expect(view.getUint32(8, true)).toBe(bytes.byteLength)
    expect(summary).toMatchObject({
      recipeId: 'drone-urban-flight',
      z: 14,
      x: 8686,
      y: 4758,
      lod: {
        zoom: 14,
      },
      featureCounts: {
        polygons: 3,
        lines: 2,
        labels: 1,
        buildings: 1,
        roads: 1,
        water: 2,
        vegetation: 1,
      },
    })
    expect(summary.bounds.minLon).toBeLessThan(summary.bounds.maxLon)
    expect(summary.bounds.minLat).toBeLessThan(summary.bounds.maxLat)
    expect(summary.boundingSphere.radiusM).toBeGreaterThan(100)
    expect(summary.lod.geometricErrorM).toBeGreaterThan(0)
    expect(summary.maxHeightM).toBeGreaterThan(summary.minHeightM)
    expect(bytes.byteLength).toBeLessThan(1_000_000)
  })

  test('bakes buildings, water, vegetation, lights, and POI primitives into the GLB while roads move to overlay tiles', () => {
    const result = compileSceneryGlbTile(testTile)
    expect(result).not.toBeNull()
    const json = glbJson(result!.bytes)
    const materialNames = usedMaterialNames(json)

    expect(materialNames.has('cool building wall')).toBe(true)
    expect(materialNames.has('building facade trim')).toBe(true)
    expect([
      'building roof',
      'light building roof',
      'green copper roof',
      'red tile roof',
      'dark roof membrane',
    ].some(name => materialNames.has(name))).toBe(true)
    expect(materialNames.has('roof parapets')).toBe(true)
    expect(materialNames.has('rooftop fixtures')).toBe(true)
    expect(materialNames.has('road shoulder')).toBe(false)
    expect(materialNames.has('road dark casing')).toBe(false)
    expect(materialNames.has('road asphalt')).toBe(false)
    expect(materialNames.has('major road asphalt')).toBe(false)
    expect(materialNames.has('baked road markings')).toBe(false)
    expect(materialNames.has('water surface')).toBe(true)
    expect(materialNames.has('tree canopy')).toBe(true)
    expect(materialNames.has('street lamp glass')).toBe(true)
    expect(materialNames.has('poi beacon')).toBe(true)
  })

  test('exports road centerlines and styling data to the road overlay sidecar', () => {
    const roadTile = sceneryRoadTileFromSceneryTile(testTile)
    const parsed = sceneryRoadTileSchema.safeParse(roadTile)

    expect(parsed.success).toBe(true)
    expect(roadTile.tileEncoding).toBe('leitbild-scenery-road-json-v1')
    expect(roadTile.roads).toHaveLength(1)
    expect(roadTile.roads[0]).toMatchObject({
      id: 'road:1',
      className: 'primary',
      widthM: 17,
      isBridge: false,
      isTunnel: false,
    })
    expect(roadTile.roads[0]!.path).toHaveLength(3)
  })

  test('keeps facades closed while placing detail on outward relief planes', () => {
    const result = compileSceneryGlbTile(testTile)
    expect(result).not.toBeNull()
    const wallPositions = primitivePositionsByMaterialName(result!.bytes, /building wall|warm building wall|cool building wall|brick building wall|stone building wall|dark glass building wall/)
    const detailPositions = primitivePositionsByMaterialName(result!.bytes, /building windows|building facade trim/)

    expect(wallPositions.length).toBeGreaterThan(0)
    expect(detailPositions.length).toBeGreaterThan(0)
    const facadePlanes = coordinatePlanesFor(wallPositions)
    const reliefOffsets: number[] = []
    for (const position of detailPositions.flat()) {
      const offset = facadeReliefOffset(position, facadePlanes)
      expect(offset).not.toBeNull()
      reliefOffsets.push(offset!)
    }
    expect(Math.min(...reliefOffsets)).toBeGreaterThanOrEqual(0.045)
    expect(Math.max(...reliefOffsets)).toBeLessThanOrEqual(0.09)
  })

  test('keeps GLB ground and water strata while road surfaces are owned by the overlay renderer', () => {
    const result = compileSceneryGlbTile(testTile)
    expect(result).not.toBeNull()
    const bytes = result!.bytes
    const parkY = firstYValue(bytes, /managed park grass/)
    const waterY = firstYValue(bytes, /water surface/)
    const materialNames = usedMaterialNames(glbJson(bytes))

    expect(waterY - parkY).toBeGreaterThanOrEqual(0.12)
    expect(materialNames.has('major road asphalt')).toBe(false)
    expect(materialNames.has('baked road markings')).toBe(false)
  })

  test('exports crossing roads to one overlay tile instead of stacking GLB depth lanes', () => {
    const result = compileSceneryGlbTile(crossingRoadTile())
    expect(result).not.toBeNull()
    const materialNames = usedMaterialNames(glbJson(result!.bytes))
    const roadTile = sceneryRoadTileFromSceneryTile(crossingRoadTile())

    expect(materialNames.has('major road asphalt')).toBe(false)
    expect(materialNames.has('baked road markings')).toBe(false)
    expect(roadTile.roads).toHaveLength(2)
  })

  test('keeps bent road surfaces out of GLB and in the road overlay sidecar', () => {
    const result = compileSceneryGlbTile(bentRoadTile())
    expect(result).not.toBeNull()
    const quality = result!.summary.quality
    const materialNames = usedMaterialNames(glbJson(result!.bytes))

    expect(sceneryRoadTileFromSceneryTile(bentRoadTile()).roads).toHaveLength(1)
    expect(materialNames.has('major road asphalt')).toBe(false)
    expect(quality?.sameMaterialHorizontalOverlapCount).toBe(0)
    expect(quality?.findings.some(finding => finding.code === 'scenery.depth.same_material_horizontal_overlap')).toBe(false)
  })

  test('keeps closed road topology as overlay data instead of overlapping GLB caps', () => {
    const result = compileSceneryGlbTile(closedRoadTile())
    expect(result).not.toBeNull()
    const quality = result!.summary.quality
    const roadTile = sceneryRoadTileFromSceneryTile(closedRoadTile())

    expect(roadTile.roads[0]!.path[0]).toEqual(roadTile.roads[0]!.path.at(-1))
    expect(quality?.closeHorizontalOverlapCount).toBe(0)
    expect(quality?.sameMaterialHorizontalOverlapCount).toBe(0)
    expect(quality?.findings.some(finding => finding.code === 'scenery.depth.close_horizontal_overlap')).toBe(false)
  })

  test('keeps sharp road folds as paint input instead of self-overlapping GLB slabs', () => {
    const result = compileSceneryGlbTile(hairpinRoadTile())
    expect(result).not.toBeNull()
    const quality = result!.summary.quality
    const roadTile = sceneryRoadTileFromSceneryTile(hairpinRoadTile())

    expect(roadTile.roads).toHaveLength(1)
    expect(roadTile.roads[0]!.path).toEqual(hairpinRoadTile().features.lines[0]!.path)
    expect(quality?.closeHorizontalOverlapCount).toBe(0)
    expect(quality?.sameMaterialHorizontalOverlapCount).toBe(0)
    expect(quality?.findings.some(finding => finding.code === 'scenery.depth.close_horizontal_overlap')).toBe(false)
  })

  test('keeps parallel roads in one overlay tile instead of allocating vertical GLB lanes', () => {
    const result = compileSceneryGlbTile(parallelRoadShoulderTile())
    expect(result).not.toBeNull()
    const quality = result!.summary.quality
    const roadTile = sceneryRoadTileFromSceneryTile(parallelRoadShoulderTile())

    expect(roadTile.roads).toHaveLength(2)
    expect(quality?.closeHorizontalOverlapCount).toBe(0)
    expect(quality?.sameMaterialHorizontalOverlapCount).toBe(0)
    expect(quality?.findings.some(finding => finding.code === 'scenery.depth.close_horizontal_overlap')).toBe(false)
  })

  test('arbitrates overlapping base surfaces into stable material strata', () => {
    const result = compileSceneryGlbTile(overlappingSurfaceTile())
    expect(result).not.toBeNull()
    const parkY = firstYValue(result!.bytes, /managed park grass/)
    const woodY = firstYValue(result!.bytes, /woodland floor/)
    const quality = result!.summary.quality

    expect(Math.abs(woodY - parkY)).toBeGreaterThanOrEqual(0.05)
    expect(quality?.closeHorizontalOverlapCount).toBe(0)
    expect(quality?.sameMaterialHorizontalOverlapCount).toBe(0)
    expect(quality?.findings.some(finding => finding.code === 'scenery.depth.close_horizontal_overlap')).toBe(false)
  })

  test('emits tile quality metrics for systematic scenery cleanup', () => {
    const result = compileSceneryGlbTile(testTile)
    expect(result).not.toBeNull()
    const quality = result!.summary.quality

    expect(quality).toBeDefined()
    expect(quality?.vertexCount).toBeGreaterThan(0)
    expect(quality?.triangleCount).toBeGreaterThan(0)
    expect(quality?.horizontalPlaneCount).toBeGreaterThan(0)
    expect(quality?.closeHorizontalOverlapCount).toBe(0)
    expect(quality?.sameMaterialHorizontalOverlapCount).toBe(0)
    expect(quality?.duplicateHorizontalTriangleCount).toBe(0)
    expect(quality?.outOfBoundsPointCount).toBe(0)
    expect(quality?.findings.some(finding => finding.code === 'scenery.depth.close_horizontal_overlap')).toBe(false)
    expect(quality?.findings.some(finding => finding.code === 'scenery.depth.duplicate_horizontal_triangles')).toBe(false)
  })

  test('flags out-of-bounds compiler input before it becomes a flicker hunt', () => {
    const result = compileSceneryGlbTile(outOfBoundsTile())
    expect(result).not.toBeNull()
    const quality = result!.summary.quality

    expect(quality?.outOfBoundsPointCount).toBeGreaterThan(0)
    expect(quality?.errorCount).toBeGreaterThan(0)
    expect(quality?.findings.some(finding => finding.code === 'scenery.geometry.out_of_bounds')).toBe(true)
  })

  test('declares compiler-owned scenery depth policies instead of relying on renderer z-bias guesses', () => {
    const result = compileSceneryGlbTile(testTile)
    expect(result).not.toBeNull()
    const json = glbJson(result!.bytes)
    const materials = recordArray(json.materials)
    const usedNames = usedMaterialNames(json)

    for (const material of materials.filter(material => usedNames.has(material.name))) {
      const extras = material.extras
      expect(extras && typeof extras === 'object' && !Array.isArray(extras)).toBe(true)
      expect(String((extras as Record<string, unknown>).droneSceneryDepthPolicy ?? '')).toMatch(/^(base-surface|integrated-facade|raised-geometry)$/)
    }
  })

  test('keeps scenery depth ownership out of Babylon material tuning', async () => {
    const source = await Bun.file(new URL('../src/ui/drone/drone-scene.ts', import.meta.url)).text()

    expect(source).not.toContain('sceneryMaterialDepthBias')
    expect(source).not.toContain('.zOffset')
    expect(source).not.toContain('maxZ: 12_000')
  })

  test('keeps coarse scenery tiles as lightweight fallback silhouettes', () => {
    const coarseResult = compileSceneryGlbTile(testTileAtZoom(12, 2170, 1191))
    const fullResult = compileSceneryGlbTile(testTile)
    expect(coarseResult).not.toBeNull()
    expect(fullResult).not.toBeNull()

    const coarseMaterialNames = usedMaterialNames(glbJson(coarseResult!.bytes))
    expect(coarseResult!.bytes.byteLength).toBeLessThan(fullResult!.bytes.byteLength)
    expect(coarseMaterialNames.has('cool building wall')).toBe(true)
    expect([
      'building roof',
      'light building roof',
      'green copper roof',
      'red tile roof',
      'dark roof membrane',
    ].some(name => coarseMaterialNames.has(name))).toBe(true)
    expect(coarseMaterialNames.has('building windows')).toBe(false)
    expect(coarseMaterialNames.has('building facade trim')).toBe(false)
    expect(coarseMaterialNames.has('roof parapets')).toBe(false)
    expect(coarseMaterialNames.has('rooftop fixtures')).toBe(false)
    expect(coarseMaterialNames.has('baked road markings')).toBe(false)
    expect(coarseMaterialNames.has('street lamp glass')).toBe(false)
    expect(coarseMaterialNames.has('tree canopy')).toBe(false)
    expect(coarseMaterialNames.has('poi beacon')).toBe(false)
  })

  test('keeps dense z14 decoration bounded without removing all visual detail', () => {
    const result = compileSceneryGlbTile(denseBudgetTile())
    expect(result).not.toBeNull()
    const materialNames = usedMaterialNames(glbJson(result!.bytes))

    expect(result!.bytes.byteLength).toBeLessThan(18_000_000)
    expect(materialNames.has('building windows')).toBe(true)
    expect(materialNames.has('building facade trim')).toBe(true)
    expect(materialNames.has('roof parapets')).toBe(true)
    expect(materialNames.has('rooftop fixtures')).toBe(true)
    expect(materialNames.has('baked road markings')).toBe(false)
    expect(materialNames.has('street lamp glass')).toBe(true)
    expect(materialNames.has('poi beacon')).toBe(true)
    expect(sceneryRoadTileFromSceneryTile(denseBudgetTile()).roads.length).toBe(960)
  })
})

describe('drone scenery runtime cache policy', () => {
  test('derives road overlay sidecars from loaded GLB tile URLs', () => {
    expect(roadTileUrlFromModelUrl(
      'https://leitbild.samsinn.app/map/scenery/current/drone-urban-flight/14/8686/4758.glb',
      '/map/scenery/current/{recipeId}/{z}/{x}/{y}.roads.json',
    )).toBe('/map/scenery/current/drone-urban-flight/14/8686/4758.roads.json')
  })

  test('sizes visible tile residency from source content bytes without exhausting the working set', () => {
    const representativeLargeTile = {
      content: {
        extras: {
          leitbild: {
            byteLength: 12 * 1024 * 1024,
          },
        },
      },
    } as unknown as Parameters<typeof estimateDroneSceneryTileBytesForCache>[0]

    const estimatedBytes = estimateDroneSceneryTileBytesForCache(representativeLargeTile)
    expect(estimatedBytes).toBe(15 * 1024 * 1024)
    expect(estimatedBytes * 20).toBeLessThan(droneSceneryTileCacheBudget.maxBytes)
    expect(droneSceneryTileCacheBudget.unloadPercent).toBeLessThan(0.18)
  })

  test('builds opaque road mesh layers instead of texture-backed alpha planes', async () => {
    const source = await Bun.file(new URL('../src/ui/drone/drone-road-overlay.ts', import.meta.url)).text()
    const meshes = buildRoadSurfaceMeshes({ tile: sceneryRoadTileFromSceneryTile(crossingRoadTile()) })

    expect(source).not.toContain('DynamicTexture')
    expect(source).not.toContain('MATERIAL_ALPHATEST')
    expect(source).not.toContain('useAlphaFromDiffuseTexture')
    expect(meshes).toHaveLength(1)
    expect(meshes[0]!.materialKey).toBe('road-asphalt')
    expect(meshes[0]!.colorHex).toBe('#3f474b')
    expect(meshes[0]!.triangleCount).toBeGreaterThan(0)
    expect(meshes[0]!.positions.length % 3).toBe(0)
    expect(new Set(Array.from({ length: meshes[0]!.positions.length / 3 }, (_value, index) => meshes[0]!.positions[index * 3 + 1]))).toEqual(new Set([meshes[0]!.y]))
  })

  test('separates real bridge roads by vertical layer without adding stacked road material bands', () => {
    const bridgeTile = sceneryRoadTileFromSceneryTile({
      ...crossingRoadTile(),
      features: {
        polygons: [],
        labels: [],
        lines: [
          ...crossingRoadTile().features.lines,
          {
            id: 'bridge-road:c',
            sourceLayer: 'transportation',
            sourceRef: 'osm:way:bridge-c',
            kind: 'road',
            className: 'primary',
            brunnel: 'bridge',
            isBridge: true,
            isTunnel: false,
            path: [
              tilePoint(900, 900),
              tilePoint(3200, 3200),
            ],
            widthM: 16,
            verticalOffsetM: 2.6,
          },
        ],
      },
    })
    const meshes = buildRoadSurfaceMeshes({ tile: bridgeTile })

    expect(meshes).toHaveLength(2)
    expect(new Set(meshes.map(mesh => mesh.materialKey))).toEqual(new Set(['road-asphalt']))
    expect(Math.max(...meshes.map(mesh => mesh.y)) - Math.min(...meshes.map(mesh => mesh.y))).toBeGreaterThanOrEqual(2.2)
  })
})
