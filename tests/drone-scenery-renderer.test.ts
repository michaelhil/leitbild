import { describe, expect, test } from 'bun:test'
import * as THREE from 'three'
import type { DroneMapWorldSnapshot, DroneWorldLineFeature, DroneWorldPoint } from '../src/ui/drone/drone-map-world.ts'
import { mergeDroneWorldLinesForScenery } from '../src/ui/drone/drone-map-world.ts'
import { createDroneMapWorldGroup } from '../src/ui/drone/drone-world-renderer.ts'

const square = (
  centerX: number,
  centerZ: number,
  half: number,
): ReadonlyArray<DroneWorldPoint> => [
  { x: centerX - half, z: centerZ - half },
  { x: centerX + half, z: centerZ - half },
  { x: centerX + half, z: centerZ + half },
  { x: centerX - half, z: centerZ + half },
  { x: centerX - half, z: centerZ - half },
]

const snapshot: DroneMapWorldSnapshot = {
  key: 'test-scenery',
  center: { lon: 10.75, lat: 59.91 },
  radiusM: 600,
  zoom: 14,
  tileCount: 1,
  polygons: [
    {
      id: 'building:1',
      kind: 'building',
      className: 'commercial',
      rings: [square(-40, -20, 18)],
      distanceM: 42,
      areaM2: 1_296,
      heightM: 24,
    },
    {
      id: 'water:1',
      kind: 'water',
      className: 'river',
      rings: [square(75, 35, 34)],
      distanceM: 62,
      areaM2: 4_624,
    },
    {
      id: 'landcover:1',
      kind: 'landcover',
      className: 'wood',
      rings: [square(20, 110, 72)],
      distanceM: 96,
      areaM2: 20_736,
    },
  ],
  lines: [{
    id: 'road:1',
    kind: 'road',
    className: 'primary',
    name: 'Renderer Test Road',
    isBridge: true,
    isTunnel: false,
    path: [
      { x: -180, z: -90 },
      { x: 0, z: -20 },
      { x: 185, z: 30 },
    ],
    widthM: 18,
    verticalOffsetM: 3.2,
    distanceM: 20,
    lengthM: 390,
  }],
  points: [
    {
      id: 'poi:1',
      kind: 'poi',
      className: 'hospital',
      label: 'Hospital',
      point: { x: 28, z: -48 },
    },
    {
      id: 'road-label:1',
      kind: 'road_label',
      className: 'primary',
      label: 'Renderer Test Road',
      point: { x: 0, z: -20 },
    },
  ],
  coverage: {
    decoded: { polygons: 3, lines: 1, points: 2 },
    selected: {
      polygons: 3,
      lines: 1,
      points: 2,
      buildings: 1,
      roads: 1,
      waterPolygons: 1,
      waterways: 0,
      vegetationPolygons: 1,
      roadLabels: 1,
      pois: 1,
    },
    lineFragmentsMerged: 0,
    notes: [],
  },
}

const blockedVegetationSnapshot: DroneMapWorldSnapshot = {
  key: 'test-blocked-vegetation',
  center: { lon: 10.75, lat: 59.91 },
  radiusM: 250,
  zoom: 14,
  tileCount: 1,
  polygons: [
    {
      id: 'building:blocking',
      kind: 'building',
      className: 'commercial',
      rings: [square(0, 0, 80)],
      distanceM: 0,
      areaM2: 25_600,
      heightM: 20,
    },
    {
      id: 'landcover:blocked',
      kind: 'landcover',
      className: 'wood',
      rings: [square(0, 0, 80)],
      distanceM: 0,
      areaM2: 25_600,
    },
  ],
  lines: [],
  points: [],
  coverage: {
    decoded: { polygons: 2, lines: 0, points: 0 },
    selected: {
      polygons: 2,
      lines: 0,
      points: 0,
      buildings: 1,
      roads: 0,
      waterPolygons: 0,
      waterways: 0,
      vegetationPolygons: 1,
      roadLabels: 0,
      pois: 0,
    },
    lineFragmentsMerged: 0,
    notes: [],
  },
}

describe('drone scenery renderer', () => {
  test('builds rich source-backed scenery from decoded map features', () => {
    const group = createDroneMapWorldGroup(snapshot)
    const sceneryKinds = new Set<string>()
    let hasDoubleSidedBuildingWall = false

    group.traverse(child => {
      const kind = child.userData.droneSceneryKind
      if (typeof kind === 'string') sceneryKinds.add(kind)
      if (child instanceof THREE.Mesh) {
        const materials = Array.isArray(child.material) ? child.material : [child.material]
        if (materials.some(material => material.side === THREE.DoubleSide)) hasDoubleSidedBuildingWall = true
      }
    })

    expect(hasDoubleSidedBuildingWall).toBe(true)
    expect(sceneryKinds.has('building-roof')).toBe(true)
    expect(sceneryKinds.has('shoreline')).toBe(true)
    expect(sceneryKinds.has('road-furniture')).toBe(true)
    expect(sceneryKinds.has('vegetation')).toBe(true)
    expect(sceneryKinds.has('poi-beacon')).toBe(true)
    expect(sceneryKinds.has('road-label-sign')).toBe(true)
  })

  test('does not place derived vegetation inside source-backed solid features', () => {
    const group = createDroneMapWorldGroup(blockedVegetationSnapshot)
    const sceneryKinds = new Set<string>()
    group.traverse(child => {
      const kind = child.userData.droneSceneryKind
      if (typeof kind === 'string') sceneryKinds.add(kind)
    })

    expect(sceneryKinds.has('building-roof')).toBe(true)
    expect(sceneryKinds.has('vegetation')).toBe(false)
  })

  test('merges source-identical road fragments without fusing anonymous local roads', () => {
    const baseRoad: Omit<DroneWorldLineFeature, 'id' | 'path' | 'distanceM' | 'lengthM'> = {
      sourceRef: 'transportation:way-1',
      kind: 'road',
      className: 'primary',
      name: 'Continuous Road',
      isBridge: false,
      isTunnel: false,
      widthM: 18,
      verticalOffsetM: 0,
    }
    const anonymousLocal: Omit<DroneWorldLineFeature, 'id' | 'path' | 'distanceM' | 'lengthM'> = {
      kind: 'road',
      className: 'residential',
      isBridge: false,
      isTunnel: false,
      widthM: 6.4,
      verticalOffsetM: 0,
    }
    const features: ReadonlyArray<DroneWorldLineFeature> = [
      {
        ...baseRoad,
        id: 'primary:a',
        path: [{ x: -20, z: 0 }, { x: 0, z: 0 }],
        distanceM: 0,
        lengthM: 20,
      },
      {
        ...baseRoad,
        id: 'primary:b',
        path: [{ x: 0.6, z: 0.2 }, { x: 22, z: 0 }],
        distanceM: 0,
        lengthM: 21.4,
      },
      {
        ...anonymousLocal,
        id: 'local:a',
        path: [{ x: -10, z: 12 }, { x: 0, z: 12 }],
        distanceM: 12,
        lengthM: 10,
      },
      {
        ...anonymousLocal,
        id: 'local:b',
        path: [{ x: 0.5, z: 12 }, { x: 10, z: 12 }],
        distanceM: 12,
        lengthM: 9.5,
      },
    ]
    const merged = mergeDroneWorldLinesForScenery(features)
    const mergedPrimary = merged.filter(feature => feature.name === 'Continuous Road')
    const anonymous = merged.filter(feature => feature.className === 'residential')

    expect(mergedPrimary).toHaveLength(1)
    expect(mergedPrimary[0]?.path).toHaveLength(3)
    expect(anonymous).toHaveLength(2)
  })
})
