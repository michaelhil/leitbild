import { expect, test } from 'bun:test'
import { geoPointFromLonLat, type IsoTimestamp, type SpatialState } from '../src/core/model/index.ts'
import { fitObjectsTarget, homeMapTarget } from '../src/ui/run-view-actions.ts'

const positioned = (lon: number, lat: number): { readonly spatial: SpatialState } => ({ spatial: { frame: { kind: 'wgs84' }, position: { point: geoPointFromLonLat(lon, lat), observedAt: '2026-01-01T00:00:00Z' as IsoTimestamp } } })

test('camera fitting uses only supplied positions; absent geography is unavailable', () => {
  expect(fitObjectsTarget([])).toBeNull()
  const absent = { spatial: { frame: { kind: 'wgs84' as const } } }
  expect(fitObjectsTarget([absent])).toBeNull()
  expect(fitObjectsTarget([absent, positioned(11.4, 59.1)])).toEqual({ kind: 'point', center: [11.4, 59.1] })
  expect(fitObjectsTarget([positioned(12, 60), positioned(11, 59), positioned(10, 61)])).toEqual({ kind: 'bounds', bounds: [[10, 59], [12, 61]] })
})

test('Home retains exact authored geography and requests fitting to the current clear area', () => {
  expect(homeMapTarget({ center: geoPointFromLonLat(11.5, 59.2), zoom: 12.4, layers: [] })).toEqual({ kind: 'view', center: [11.5, 59.2], zoom: 12.4, bearing: 0, fitToAvailableArea: true })
})
