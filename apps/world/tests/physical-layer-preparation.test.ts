import { expect, test } from 'bun:test'
import { physicalLayerPreparationText } from '../src/ui/physical-layout/layer-preparation.ts'
test('additional-layer readiness names exact requested layers without replacing usable geometry/live truth', () => {
  const descriptor = { layers: [{ id: 'utilities', label: 'Utilities' }, { id: 'roof', label: 'Roof structure' }] }
  expect(physicalLayerPreparationText({ descriptor })).toBeNull()
  expect(physicalLayerPreparationText({ descriptor, layerPreparation: { status: 'loading', layerIds: ['utilities', 'roof'] } })).toBe('Preparing additional layers: Utilities, Roof structure')
  expect(physicalLayerPreparationText({ descriptor, layerPreparation: { status: 'unavailable', layerIds: ['roof'], reason: 'Worker refused invalid geometry' } })).toBe('Additional layers unavailable: Roof structure · Worker refused invalid geometry')
})
