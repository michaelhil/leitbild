import { expect, test } from 'bun:test'
import { physicalSceneInitialVisibleLayers } from '../src/core/packs/scene.ts'
import { physicalLayoutViewDefaults } from '../src/packs/physical-layout/view-defaults.ts'

test('Pack defaults follow declared arbitrary conduit references without changing retained defaults', () => {
  const layers = [{ id: 'pipe-network-v7', label: 'Water', defaultVisible: false }, { id: 'power-routing', label: 'Water', defaultVisible: false }, { id: 'enclosure', label: 'Walls', defaultVisible: false }]
  const source = { elements: [{ kind: 'pipe', layerId: 'pipe-network-v7' }, { kind: 'conductor', layerId: 'power-routing' }, { kind: 'wall', layerId: 'enclosure' }], routing: { connections: [{ layerId: 'pipe-network-v7' }] } }
  const before = JSON.stringify({ source, layers }), result = physicalLayoutViewDefaults(source, layers)
  expect(result.visibleLayerIds).toEqual(['pipe-network-v7', 'power-routing'])
  expect(physicalSceneInitialVisibleLayers({ layers, viewDefaults: result })).toEqual(result.visibleLayerIds)
  expect(JSON.stringify({ source, layers })).toBe(before)
})

test('undeclared or repeated default references are refused; no policy leaves source defaults intact', () => {
  const layers = [{ id: 'local', label: 'Layer', defaultVisible: false }]
  expect(() => physicalSceneInitialVisibleLayers({ layers, viewDefaults: { visibleLayerIds: ['foreign'] } })).toThrow('undeclared')
  expect(() => physicalSceneInitialVisibleLayers({ layers, viewDefaults: { visibleLayerIds: ['local', 'local'] } })).toThrow('unique')
  expect(() => physicalLayoutViewDefaults({ elements: [{ kind: 'pipe', layerId: 'foreign' }] }, layers)).toThrow('undeclared')
  expect(physicalSceneInitialVisibleLayers({ layers })).toEqual([])
  expect(physicalLayoutViewDefaults({ elements: [{ kind: 'pipe' }] }, undefined)).toEqual({ visibleLayerIds: [] })
})
