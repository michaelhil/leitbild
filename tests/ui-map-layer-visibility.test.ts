import { describe, expect, test } from 'bun:test'
import { createOperationalDeckLayers } from '../src/ui/map-runtime/operational-deck-layers.ts'
import type { OperationalRenderSnapshot } from '../src/ui/map-runtime/types.ts'

const emptySnapshot = (): OperationalRenderSnapshot => ({
  points: [],
  paths: [
    {
      id: 'route:a',
      kind: 'route',
      path: [[10, 59], [11, 60]],
      color: [1, 2, 3, 255],
      casingColor: [255, 255, 255, 255],
      widthPx: 3,
      selected: false,
      priority: 1,
      signature: 'route',
    },
    {
      id: 'traffic:a',
      kind: 'traffic',
      path: [[10, 59], [11, 60]],
      color: [1, 2, 3, 255],
      casingColor: [255, 255, 255, 255],
      widthPx: 3,
      selected: false,
      priority: 1,
      signature: 'traffic',
    },
  ],
  areas: [],
  areaSymbols: [],
  placementPoints: [],
  revisions: {
    points: 1,
    paths: 1,
    areas: 1,
    areaSymbols: 1,
    placement: 1,
  },
})

describe('operational deck layer visibility', () => {
  test('filters paths by scenario layer families before they reach deck', () => {
    const layers = createOperationalDeckLayers({
      snapshot: emptySnapshot(),
      visibleFamilies: new Set(['objects', 'routes']),
      onObjectSelected: () => undefined,
      onObjectSeen: () => undefined,
      onObjectHover: () => undefined,
    })
    const pathLayer = layers.find(layer => layer.id === 'leitbild-operational-paths')
    const data = pathLayer?.props.data as ReadonlyArray<{ readonly kind: string }> | undefined

    expect(data?.map(path => path.kind)).toEqual(['route'])
  })
})
