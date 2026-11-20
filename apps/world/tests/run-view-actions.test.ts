import { expect, test } from 'bun:test'
import { geoPointFromLonLat, type IsoTimestamp, type SpatialState } from '../src/core/model/index.ts'
import { fitObjectsTarget, homeMapTarget, runCameraButtons, type RunCameraButton } from '../src/ui/run-view-actions.ts'

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

test('the map always offers Home and Fit all visible, and Fit selection only while an object with a map position is selected', () => {
  const home: RunCameraButton = { id: 'home', label: 'Home: the scenario\u2019s starting view', disabledReason: null }
  const fit: RunCameraButton = { id: 'fit-visible', label: 'Fit everything visible', disabledReason: null }
  const selection: RunCameraButton = { id: 'fit-selected', label: 'Fit the selected object', disabledReason: null }
  expect(runCameraButtons({ visiblePositions: true, selectionOnMap: false })).toEqual([home, fit])
  expect(runCameraButtons({ visiblePositions: true, selectionOnMap: true })).toEqual([home, fit, selection])
  // With nothing drawn on the map, Fit all visible stays in its place and says why a press does nothing.
  expect(runCameraButtons({ visiblePositions: false, selectionOnMap: false })).toEqual([home, { ...fit, disabledReason: 'No visible object positions' }])
  // Each button names its own target: no two share a label.
  const labels = runCameraButtons({ visiblePositions: true, selectionOnMap: true }).map(button => button.label)
  expect(new Set(labels).size).toBe(labels.length)
})
