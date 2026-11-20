import { describe, expect, test } from 'bun:test'
import type { Layer } from '@deck.gl/core'
import { geoPointFromLonLat, type IsoTimestamp, type ObjectId, type OperationalObject, type PackId } from '../src/core/model/index.ts'
import type { PackObjectPresentation } from '../src/core/packs/protocol.ts'
import { emptyCatalogueSymbolAtlas } from '../src/ui/map-runtime/catalogue-symbol-atlas.ts'
import { createMapFeatureStore } from '../src/ui/map-runtime/map-feature-store.ts'
import { createOperationalDeckLayers } from '../src/ui/map-runtime/operational-deck-layers.ts'
import { operationalIconPx, statusDiskRadiusPx } from '../src/ui/map-runtime/symbol-kit.ts'
import type { MapTargetingRender, OperationalPathFeature, OperationalPointFeature, OperationalRenderSnapshot } from '../src/ui/map-runtime/types.ts'
import { disksPickFor, pickingRadiusFor } from '../src/ui/map/map-pointer.ts'

/**
 * A tap or click on a drawn icon reaches its object, even where a route line
 * or another object's tag or label lies over it (walk 2, N2 and finding 4).
 */

const at = '2026-11-19T08:00:00.000Z' as IsoTimestamp
/** One canvas px is 0.00001° here, east right and north up, from the origin. */
const origin = [11.4, 59.12] as const
const lonLat = (eastPx: number, northPx: number): readonly [number, number] => [origin[0] + eastPx * 1e-5, origin[1] + northPx * 1e-5]
const disk = statusDiskRadiusPx(operationalIconPx)

const objectOf = (id: string, eastPx: number, northPx: number, routePx?: ReadonlyArray<readonly [number, number]>): OperationalObject => ({
  id: id as ObjectId,
  kind: 'mobile_entity',
  packId: 'fixture' as PackId,
  label: id,
  lifecycle: 'active',
  revision: 1,
  spatial: {
    frame: { kind: 'wgs84' },
    position: { point: geoPointFromLonLat(...lonLat(eastPx, northPx)), observedAt: at },
    ...(routePx === undefined ? {} : { route: { source: 'simulator' as const, planned: { type: 'LineString' as const, coordinates: routePx.map(([east, north]) => geoPointFromLonLat(...lonLat(east, north)).coordinates) } } }),
  },
  operational: { status: 'normal', mode: 'simulated' },
  alerts: [],
  provenance: { source: 'simulator' },
  timestamps: { createdAt: at, updatedAt: at },
})

const presentationFor = (object: OperationalObject): PackObjectPresentation => ({
  categoryId: 'fixture',
  icon: 'square',
  color: '#334155',
  summary: object.label,
  fields: [],
  mapLabel: object.label,
})

const snapshotOf = (objects: ReadonlyArray<OperationalObject>, targeting: MapTargetingRender): OperationalRenderSnapshot => createMapFeatureStore().update({
  objects,
  selectedControllerId: targeting.fromId,
  highlightedObjectIds: [],
  targeting,
  hiddenObjectCategoryIds: [],
  alertPalette: 'day',
  placementPoints: [],
  packFeatures: [],
  hasNewInfo: () => false,
  presentationFor,
})

type Pointer = 'touch' | 'mouse'
interface Taps {
  readonly layers: ReadonlyArray<Layer>
  readonly selected: string[]
  readonly seen: string[]
  readonly hovered: Array<string | null>
}

/** The map's layers on a surface whose open panel takes map targets, as a finger or a mouse picks them. */
const tapsOn = (snapshot: OperationalRenderSnapshot, pointer: Pointer): Taps => {
  const selected: string[] = []
  const seen: string[] = []
  const hovered: Array<string | null> = []
  const radius = pickingRadiusFor(pointer, operationalIconPx)
  const layers = createOperationalDeckLayers({
    snapshot,
    visibleFamilies: new Set(['objects', 'routes']),
    catalogueAtlas: emptyCatalogueSymbolAtlas,
    disksPick: disksPickFor(true, radius),
    diskClicks: radius === 0 ? () => false : null,
    // Zoomed in so far that no icon is fanned out: each is drawn at its true position.
    zoom: 22,
    onObjectSelected: point => { selected.push(point.id) },
    onObjectSeen: point => { seen.push(point.id) },
    onObjectHover: point => { hovered.push(point?.id ?? null) },
  })
  expect(layers.some(entry => entry.id === 'leitbild-object-leaders')).toBe(false)
  return { layers, selected, seen, hovered }
}

const layer = (taps: Taps, id: string): Layer => {
  const found = taps.layers.find(entry => entry.id === id)
  if (found === undefined) throw new Error(`No layer ${id}`)
  return found
}

type Pick = (info: unknown) => void
/** A deck.gl pick at a canvas point, as it hands one to a layer's handler. */
const pickAt = (object: unknown, x: number, y: number) => ({
  object,
  x,
  y,
  viewport: { x: 0, y: 0, project: ([lon, lat]: ReadonlyArray<number>) => [(lon! - origin[0]) / 1e-5, -(lat! - origin[1]) / 1e-5, 0] },
})
const click = (taps: Taps, id: string, object: unknown, x: number, y: number): void => {
  (layer(taps, id).props.onClick as unknown as Pick)(pickAt(object, x, y))
}
const hover = (taps: Taps, id: string, object: unknown, x: number, y: number): void => {
  (layer(taps, id).props.onHover as unknown as Pick)(pickAt(object, x, y))
}
const pointOf = (snapshot: OperationalRenderSnapshot, id: string): OperationalPointFeature => {
  const point = snapshot.points.find(entry => entry.id === id)
  if (point === undefined) throw new Error(`No point ${id}`)
  return point
}

/** Every layer drawing this line: none of them may take a pick, which a finger's radius would let it win over the icon it crosses. */
const expectLineTakesNoPick = (taps: Taps, line: OperationalPathFeature): void => {
  const drawing = taps.layers.filter(entry => Array.isArray(entry.props.data) && (entry.props.data as ReadonlyArray<unknown>).includes(line))
  expect(drawing.map(entry => entry.id).sort()).toEqual(['leitbild-operational-path-casing', 'leitbild-operational-paths'])
  for (const entry of drawing) {
    expect(entry.props.pickable).toBe(false)
    expect(entry.props.onClick ?? null).toBeNull()
    expect(entry.props.onHover ?? null).toBeNull()
  }
}

/** A unit en route to the call: its route line ends at the call, entering its icon from the lower right. */
const routeToCall: ReadonlyArray<readonly [number, number]> = [[300, -200], [0, 0]]

describe('a tap on a drawn icon reaches its object', () => {
  test('a dimmed call under a route line: the line takes no tap, so a tap where it crosses the call\'s icon reaches the call, with a finger and with a mouse', () => {
    // unit-b is selected; the call needs nothing it provides, so it is dimmed. unit-a's route line ends at the call.
    const objects = [objectOf('call', 0, 0), objectOf('unit-a', 300, -200, routeToCall), objectOf('unit-b', -400, 100), objectOf('clinic', 200, 300)]
    const snapshot = snapshotOf(objects, { fromId: 'unit-b', complete: true, targets: new Map([['clinic', { tag: '2 min', anchor: 'middle', tone: 'valid' }]]) })
    const call = pointOf(snapshot, 'call')
    expect(call).toMatchObject({ dimmed: true, targetTone: null })
    const line = snapshot.paths.find(path => path.id === 'route:unit-a')!
    expect(line.path.at(-1)).toEqual(lonLat(0, 0))
    for (const pointer of ['touch', 'mouse'] as const) {
      const taps = tapsOn(snapshot, pointer)
      expectLineTakesNoPick(taps, line)
      // The tap lands on the call's icon 6 px down and right of its centre, on the line: deck can only pick the call's icon.
      click(taps, 'leitbild-object-symbols', call, 6, 6)
      expect(taps.selected).toEqual(['call'])
      expect(taps.seen).toEqual(['call'])
    }
  })

  test('a valid target under a route line: the tap on its icon reaches it, as does a tap on its own tag', () => {
    // unit-b is selected and may take the call; unit-a's route line ends at it too.
    const objects = [objectOf('call', 0, 0), objectOf('unit-a', 300, -200, routeToCall), objectOf('unit-b', -400, 100)]
    const snapshot = snapshotOf(objects, { fromId: 'unit-b', complete: true, targets: new Map([['call', { tag: '1 min', anchor: 'middle', tone: 'valid' }]]) })
    const call = pointOf(snapshot, 'call')
    expect(call).toMatchObject({ dimmed: false, targetTone: 'valid', targetTag: '1 min' })
    const line = snapshot.paths.find(path => path.id === 'route:unit-a')!
    for (const pointer of ['touch', 'mouse'] as const) {
      const taps = tapsOn(snapshot, pointer)
      expectLineTakesNoPick(taps, line)
      click(taps, 'leitbild-object-symbols', call, 6, 6)
      // Its tag stands 24 px above its centre, over no icon but its halo's edge.
      click(taps, 'leitbild-target-tags', call, 0, -30)
      expect(taps.selected).toEqual(['call', 'call'])
    }
  })

  test('an icon under another object\'s plan tag: a tap where the tag lies over the icon reaches the icon, and the tag takes a tap only on its own text', () => {
    // unit-a is selected; call-2 is stop 1 of its plan, and its red tag lies over call-1, 40 px north of it, as
    // near as the map draws two icons (their disks 34 px wide with 4 px between).
    const objects = [objectOf('call-2', 0, 0), objectOf('call-1', 0, 40), objectOf('unit-a', -400, 100)]
    const snapshot = snapshotOf(objects, {
      fromId: 'unit-a',
      complete: true,
      targets: new Map([
        ['call-2', { tag: 'Plan 1', anchor: 'middle', tone: 'assigned' }],
        ['call-1', { tag: null, anchor: 'middle', tone: 'valid' }],
      ]),
    })
    const planned = pointOf(snapshot, 'call-2')
    expect(planned).toMatchObject({ targetTone: 'assigned', targetTag: 'Plan 1' })
    for (const pointer of ['touch', 'mouse'] as const) {
      const taps = tapsOn(snapshot, pointer)
      const tags = layer(taps, 'leitbild-target-tags').props as unknown as { readonly getPixelOffset: (point: OperationalPointFeature) => ReadonlyArray<number> }
      // The tag's text runs up from 24 px above call-2's centre, across call-1's disk.
      const [, tagBottom] = tags.getPixelOffset(planned)
      expect(tagBottom).toBeGreaterThan(-40 - disk)
      expect(tagBottom).toBeLessThan(-40 + disk)
      // deck hands the tag a tap on call-1's icon where the tag covers it, and with a finger also one between its strokes nearest the tag.
      for (const [x, y] of [[0, -36], [4, -30], [-10, -42]] as const) click(taps, 'leitbild-target-tags', planned, x, y)
      expect(taps.selected).toEqual(['call-1', 'call-1', 'call-1'])
      expect(taps.seen).toEqual(['call-1', 'call-1', 'call-1'])
      hover(taps, 'leitbild-target-tags', planned, 0, -36)
      // On its own text beside call-1's disk, the tag picks its own target.
      click(taps, 'leitbild-target-tags', planned, disk + 4, -34)
      hover(taps, 'leitbild-target-tags', planned, disk + 4, -34)
      hover(taps, 'leitbild-target-tags', undefined, disk + 4, -34)
      expect(taps.selected).toEqual(['call-1', 'call-1', 'call-1', 'call-2'])
      expect(taps.hovered).toEqual(['call-1', 'call-2', null])
    }
  })

  test('another object\'s label lying over an icon gives the icon the tap there, and its own object a tap on the rest of it', () => {
    // call-2's label runs right towards call-1, 40 px east: it keeps clear of call-1's glyph, not of its whole disk.
    const objects = [objectOf('call-2', 0, 0), objectOf('call-1', 40, 0), objectOf('unit-a', -400, 100)]
    const snapshot = snapshotOf(objects, { fromId: 'unit-a', complete: true, targets: new Map([['call-1', { tag: null, anchor: 'middle', tone: 'valid' }], ['call-2', { tag: null, anchor: 'middle', tone: 'valid' }]]) })
    const labelled = pointOf(snapshot, 'call-2')
    const taps = tapsOn(snapshot, 'touch')
    click(taps, 'leitbild-object-labels', labelled, 40 - disk + 2, 0)
    click(taps, 'leitbild-object-labels', labelled, disk + 2, 0)
    expect(taps.selected).toEqual(['call-1', 'call-2'])
  })
})
