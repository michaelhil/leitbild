import { describe, expect, test } from 'bun:test'
import type { ControlInstanceId, GeoJsonLineString, OperationalObject } from '../src/core/model/index.ts'
import { geoPointFromLonLat } from '../src/core/model/index.ts'
import {
  createDisplayMotionState,
  displayObjectsFor,
  hasActiveDisplayMotion,
  reconcileDisplayMotionState,
} from '../src/ui/display-motion.ts'
import { osloAmbulanceTutorialScenario } from '../src/scenarios/index.ts'
import { createAmbulanceSimEngine } from '../src/packs/ambulance/sim/engine.ts'
import { createDirectRoutingAdapter } from '../src/routing/direct-adapter.ts'

const scenarioAmbulance = (): OperationalObject => {
  const object = createAmbulanceSimEngine({
    controlInstanceId: 'control-instance:display-motion-test' as ControlInstanceId,
    objects: osloAmbulanceTutorialScenario.initialObjects,
    routing: createDirectRoutingAdapter(),
  }).snapshot().objects.find(candidate => candidate.kind === 'mobile_entity')
  if (!object) throw new Error('scenario fixture missing ambulance')
  return object
}

const movingObject = (object: OperationalObject, longitude: number, latitude: number): OperationalObject => ({
  ...object,
  operational: {
    ...object.operational,
    status: 'en_route',
  },
  spatial: {
    ...object.spatial,
    position: {
      ...object.spatial.position!,
      point: geoPointFromLonLat(longitude, latitude),
      speedMps: 15,
    },
  },
})

describe('display motion interpolation', () => {
  test('interpolates moving objects between authoritative positions', () => {
    const ambulance = scenarioAmbulance()
    const previous = movingObject(ambulance, 10.7, 59.9)
    const next = movingObject(ambulance, 10.7002, 59.9002)
    const state = reconcileDisplayMotionState({
      previousState: createDisplayMotionState(),
      previousObjects: [previous],
      nextObjects: [next],
      nowMs: 1_000,
      interpolationMs: 1_000,
    })

    expect(hasActiveDisplayMotion(state, 1_500)).toBe(true)
    const displayed = displayObjectsFor([next], state, 1_500)[0]

    expect(displayed?.spatial.position?.point.coordinates[0]).toBeGreaterThan(previous.spatial.position!.point.coordinates[0])
    expect(displayed?.spatial.position?.point.coordinates[0]).toBeLessThan(next.spatial.position!.point.coordinates[0])
  })

  test('continues interpolating when volatile route details change', () => {
    const ambulance = scenarioAmbulance()
    const route: GeoJsonLineString = {
      type: 'LineString',
      coordinates: [
        geoPointFromLonLat(10.7, 59.9).coordinates,
        geoPointFromLonLat(10.72, 59.91).coordinates,
      ],
    }
    const withRoute = (object: OperationalObject, etaSeconds: number): OperationalObject => ({
      ...object,
      spatial: {
        ...object.spatial,
        route: {
          planned: route,
          source: 'operator',
          etaSeconds,
        },
      },
    })
    const previous = withRoute(movingObject(ambulance, 10.7, 59.9), 120)
    const next = withRoute(movingObject(ambulance, 10.7002, 59.9002), 119)
    const state = reconcileDisplayMotionState({
      previousState: createDisplayMotionState(),
      previousObjects: [previous],
      nextObjects: [next],
      nowMs: 1_000,
      interpolationMs: 1_000,
    })

    expect(hasActiveDisplayMotion(state, 1_500)).toBe(true)
    const displayed = displayObjectsFor([next], state, 1_500)[0]

    expect(displayed?.spatial.position?.point.coordinates[0]).toBeGreaterThan(previous.spatial.position!.point.coordinates[0])
    expect(displayed?.spatial.position?.point.coordinates[0]).toBeLessThan(next.spatial.position!.point.coordinates[0])
  })

  test('snaps instead of interpolating when a route changes', () => {
    const ambulance = scenarioAmbulance()
    const route: GeoJsonLineString = {
      type: 'LineString',
      coordinates: [
        geoPointFromLonLat(10.7, 59.9).coordinates,
        geoPointFromLonLat(10.72, 59.91).coordinates,
      ],
    }
    const previous = movingObject(ambulance, 10.7, 59.9)
    const next = {
      ...movingObject(ambulance, 10.7002, 59.9002),
      spatial: {
        ...movingObject(ambulance, 10.7002, 59.9002).spatial,
        route: {
          planned: route,
          source: 'operator' as const,
        },
      },
    }
    const state = reconcileDisplayMotionState({
      previousState: createDisplayMotionState(),
      previousObjects: [previous],
      nextObjects: [next],
      nowMs: 1_000,
      interpolationMs: 1_000,
    })

    expect(hasActiveDisplayMotion(state, 1_500)).toBe(false)
    expect(displayObjectsFor([next], state, 1_500)[0]?.spatial.position?.point).toEqual(next.spatial.position?.point)
  })

  test('snaps when a moving object stops', () => {
    const ambulance = scenarioAmbulance()
    const previous = movingObject(ambulance, 10.7, 59.9)
    const stopped = {
      ...movingObject(ambulance, 10.7002, 59.9002),
      operational: {
        ...ambulance.operational,
        status: 'available',
      },
      spatial: {
        ...movingObject(ambulance, 10.7002, 59.9002).spatial,
        position: {
          ...movingObject(ambulance, 10.7002, 59.9002).spatial.position!,
          speedMps: 0,
        },
      },
    }
    const state = reconcileDisplayMotionState({
      previousState: createDisplayMotionState(),
      previousObjects: [previous],
      nextObjects: [stopped],
      nowMs: 1_000,
      interpolationMs: 1_000,
    })

    expect(hasActiveDisplayMotion(state, 1_500)).toBe(false)
    expect(displayObjectsFor([stopped], state, 1_500)[0]?.spatial.position?.point).toEqual(stopped.spatial.position?.point)
  })
})
