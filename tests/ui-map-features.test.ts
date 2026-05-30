import { describe, expect, test } from 'bun:test'
import {
  geoPointFromLonLat,
  nowIso,
  type IsoTimestamp,
  type ObjectId,
  type OperationalObject,
  type PackId,
} from '../src/core/model/index.ts'
import type { PackMapAreaFeature, PackObjectPresentation } from '../src/core/packs/protocol.ts'
import { createMapFeatureStore } from '../src/ui/map-runtime/map-feature-store.ts'

const presentationFor = (object: OperationalObject): PackObjectPresentation => ({
  categoryId: object.packId === 'electric-grid' ? 'grid-branches' : object.packId,
  icon: object.packId === 'electric-grid' ? 'line' : object.packId,
  color: object.operational.status === 'constrained' ? '#b45309' : '#16834f',
  summary: object.label,
  fields: [],
  status: {
    tone: object.operational.status === 'constrained' ? 'working' : 'ready',
    label: object.operational.status,
    indicator: { shape: 'dot' },
  },
})

const makeObject = (
  id: string,
  patch: Partial<OperationalObject>,
): OperationalObject => ({
  id: id as ObjectId,
  kind: 'facility',
  packId: 'ambulance' as PackId,
  label: id,
  lifecycle: 'active',
  revision: 1,
  spatial: { frame: { kind: 'wgs84' } },
  operational: { status: 'normal', mode: 'simulated' },
  alerts: [],
  provenance: { source: 'simulator' },
  timestamps: { createdAt: nowIso(), updatedAt: nowIso() },
  ...patch,
})

const updateStore = (
  objects: ReadonlyArray<OperationalObject>,
  extras: {
    readonly selectedControllerId?: string | null
    readonly highlightedObjectIds?: ReadonlyArray<string>
    readonly placementPoints?: ReadonlyArray<ReturnType<typeof geoPointFromLonLat>>
    readonly packAreaFeatures?: ReadonlyArray<PackMapAreaFeature>
    readonly hasNewInfo?: (object: OperationalObject) => boolean
  } = {},
) => createMapFeatureStore().update({
  objects,
  selectedControllerId: extras.selectedControllerId ?? null,
  highlightedObjectIds: extras.highlightedObjectIds ?? [],
  placementPoints: extras.placementPoints ?? [],
  packAreaFeatures: extras.packAreaFeatures ?? [],
  hasNewInfo: extras.hasNewInfo ?? (() => false),
  presentationFor,
})

describe('map feature store', () => {
  test('projects positioned operational objects into semantic point features', () => {
    const ambulance = makeObject('ambulance:1', {
      kind: 'mobile_entity',
      packId: 'ambulance' as PackId,
      spatial: {
        frame: { kind: 'wgs84' },
        position: {
          point: geoPointFromLonLat(10.75, 59.91),
          observedAt: '2026-05-30T00:00:00.000Z' as IsoTimestamp,
        },
      },
    })

    const snapshot = updateStore([ambulance], {
      selectedControllerId: ambulance.id,
      highlightedObjectIds: [ambulance.id],
      hasNewInfo: object => object.id === ambulance.id,
    })
    const point = snapshot.points[0]

    expect(snapshot.points).toHaveLength(1)
    expect(point?.id).toBe(ambulance.id)
    expect(point?.symbolId).toBe('ambulance')
    expect(point?.selected).toBe(true)
    expect(point?.highlighted).toBe(true)
    expect(point?.hasNewInfo).toBe(true)
    expect(point?.position.slice(0, 2)).toEqual([10.75, 59.91])
  })

  test('projects selected mobile routes without mutating object geometry', () => {
    const route = {
      type: 'LineString' as const,
      coordinates: [
        geoPointFromLonLat(10.75, 59.91).coordinates,
        geoPointFromLonLat(10.80, 59.93).coordinates,
        geoPointFromLonLat(10.85, 59.94).coordinates,
      ],
    }
    const ambulance = makeObject('ambulance:route', {
      kind: 'mobile_entity',
      packId: 'ambulance' as PackId,
      spatial: {
        frame: { kind: 'wgs84' },
        position: {
          point: geoPointFromLonLat(10.80, 59.93),
          observedAt: '2026-05-30T00:00:01.000Z' as IsoTimestamp,
        },
        route: {
          planned: route,
          progress: {
            segmentIndex: 1,
            updatedAt: '2026-05-30T00:00:01.000Z' as IsoTimestamp,
          },
          source: 'simulator',
        },
      },
    })

    const snapshot = updateStore([ambulance], { selectedControllerId: ambulance.id })
    const routePath = snapshot.paths.find(path => path.kind === 'route')

    expect(routePath?.selected).toBe(true)
    expect(routePath?.path[0]).toEqual(geoPointFromLonLat(10.80, 59.93).coordinates)
    expect(route.coordinates[0]).toEqual(geoPointFromLonLat(10.75, 59.91).coordinates)
  })

  test('projects traffic and weather line objects while leaving grid reference geometry out of operational paths', () => {
    const traffic = makeObject('traffic:line', {
      kind: 'zone',
      packId: 'traffic' as PackId,
      spatial: {
        frame: { kind: 'wgs84' },
        geometry: {
          type: 'LineString',
          coordinates: [
            geoPointFromLonLat(10.70, 59.90).coordinates,
            geoPointFromLonLat(10.72, 59.92).coordinates,
          ],
        },
      },
    })
    const weather = makeObject('weather:line', {
      kind: 'zone',
      packId: 'weather' as PackId,
      spatial: traffic.spatial,
    })
    const grid = makeObject('grid:branch', {
      kind: 'zone',
      packId: 'electric-grid' as PackId,
      spatial: traffic.spatial,
      operational: { status: 'constrained', mode: 'simulated' },
    })

    const snapshot = updateStore([traffic, weather, grid])

    expect(snapshot.paths.map(path => path.kind).sort()).toEqual(['traffic', 'weather-line'])
  })

  test('projects pack area features and symbols into deck-ready area families', () => {
    const polygon = {
      type: 'Polygon' as const,
      coordinates: [[
        geoPointFromLonLat(10.70, 59.90).coordinates,
        geoPointFromLonLat(10.82, 59.90).coordinates,
        geoPointFromLonLat(10.82, 59.98).coordinates,
        geoPointFromLonLat(10.70, 59.90).coordinates,
      ]],
    }
    const features: ReadonlyArray<PackMapAreaFeature> = [
      {
        id: 'weather-grid:8:cell-1',
        categoryId: 'weather',
        geometry: polygon,
        color: '#2563eb',
        summary: 'base cell',
      },
      {
        id: 'weather:test-area',
        categoryId: 'weather',
        geometry: polygon,
        anchorPoint: geoPointFromLonLat(10.75, 59.91),
        symbol: { icon: 'weather', tone: 'working' },
        color: '#2563eb',
        summary: 'influence',
      },
    ]

    const snapshot = updateStore([], { packAreaFeatures: features })

    expect(snapshot.areas.map(area => area.kind)).toEqual(['weather-base', 'weather-influence'])
    expect(snapshot.areaSymbols).toHaveLength(1)
    expect(snapshot.areaSymbols[0]?.symbolId).toBe('weather')
  })

  test('keeps stable revisions when non-visual object revisions change', () => {
    const grid = makeObject('grid:branch', {
      kind: 'zone',
      packId: 'electric-grid' as PackId,
      spatial: {
        frame: { kind: 'wgs84' },
        geometry: {
          type: 'LineString',
          coordinates: [
            geoPointFromLonLat(10.70, 59.90).coordinates,
            geoPointFromLonLat(10.72, 59.92).coordinates,
          ],
        },
      },
    })
    const store = createMapFeatureStore()
    const first = store.update({
      objects: [grid],
      selectedControllerId: null,
      highlightedObjectIds: [],
      placementPoints: [],
      packAreaFeatures: [],
      hasNewInfo: () => false,
      presentationFor,
    })
    const second = store.update({
      objects: [{ ...grid, revision: 2 }],
      selectedControllerId: null,
      highlightedObjectIds: [],
      placementPoints: [],
      packAreaFeatures: [],
      hasNewInfo: () => false,
      presentationFor,
    })

    expect(second.revisions.paths).toBe(first.revisions.paths)
    expect(second.paths[0]).toBe(first.paths[0])
  })
})
