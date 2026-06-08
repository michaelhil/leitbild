import { describe, expect, test } from 'bun:test'
import * as THREE from 'three'
import type { DroneMapWorldSnapshot, DroneWorldPoint } from '../src/ui/drone/drone-map-world.ts'
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
})
