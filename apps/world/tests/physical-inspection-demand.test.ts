import { expect, test } from 'bun:test'
import type { PackPhysicalSceneDescriptor } from '../src/core/packs/scene.ts'
import { projectedInspectionFeature, automaticInspectionDemand } from '../src/ui/map/physical-scene/inspection-demand.ts'

const descriptor: PackPhysicalSceneDescriptor = { id: 'scene', targetObjectId: 'owner', revision: 'r', modelDigest: 'm', anchor: [0, 0], bearing: 0, bounds: { min: [0, 0, 0], max: [10, 10, 10] }, levels: [{ id: 'floor', label: 'Floor', elevation: 0, cutHeight: 2 }], locationValid: true, subjectIds: [], inspectionFeatureMetres: 1 }
test('access-scale projection uses the least legible planar direction rather than a bounding diagonal', () => {
  const project = (point: { lng: number; lat: number }) => ({ x: point.lng * 1_000_000, y: point.lat * 20_000 })
  const pixels = projectedInspectionFeature(descriptor, project)
  expect(pixels).toBeGreaterThan(.1); expect(pixels).toBeLessThan(.3)
  expect(projectedInspectionFeature({ ...descriptor, bearing: 90 }, project)).toBeCloseTo(pixels, 6)
  expect(automaticInspectionDemand(pixels, 1000, 1)).toBe(false)
  expect(automaticInspectionDemand(pixels * 10, 1000, 1)).toBe(true)
  expect(automaticInspectionDemand(1000, .5, 1)).toBe(false)
})
test('missing inspection scale is unsupported for automatic demand, while invalid declared scale is rejected', () => {
  const { inspectionFeatureMetres: _, ...missing } = descriptor
  expect(projectedInspectionFeature(missing, () => ({ x: 100, y: 100 }))).toBe(0)
  expect(() => projectedInspectionFeature({ ...descriptor, inspectionFeatureMetres: NaN }, () => ({ x: 100, y: 100 }))).toThrow('finite positive')
})
