import { describe, expect, test } from 'bun:test'
import { geoPointFromLonLat, type IsoTimestamp, type ObjectId, type OperationalObject, type PackId } from '../src/core/model/index.ts'
import type { PackMapFeature, PackObjectPresentation } from '../src/core/packs/protocol.ts'
import { createCatalogueSymbolAtlas, emptyCatalogueSymbolAtlas, type CatalogueAtlasCell, type CatalogueSymbolAtlasPorts, type CatalogueSymbolAtlasState } from '../src/ui/map-runtime/catalogue-symbol-atlas.ts'
import { createMapFeatureStore } from '../src/ui/map-runtime/map-feature-store.ts'
import { createOperationalDeckLayers } from '../src/ui/map-runtime/operational-deck-layers.ts'
import { catalogueSymbolIds } from '../src/ui/map-runtime/operational-render-controller.ts'
import { leitbildSymbolIds, operationalIconPx, symbolAtlasFor } from '../src/ui/map-runtime/symbol-kit.ts'
import { disksPickFor, pickingRadiusFor } from '../src/ui/map/map-pointer.ts'
import type { MapTargetingRender, OperationalRenderSnapshot } from '../src/ui/map-runtime/types.ts'

const at = '2026-10-12T08:00:00.000Z' as IsoTimestamp

const objectOf = (id: string, lon: number): OperationalObject => ({
  id: id as ObjectId,
  kind: 'mobile_entity',
  packId: 'fixture' as PackId,
  label: id,
  lifecycle: 'active',
  revision: 1,
  spatial: { frame: { kind: 'wgs84' }, position: { point: geoPointFromLonLat(lon, 59.12), observedAt: at } },
  operational: { status: 'normal', mode: 'simulated' },
  alerts: [],
  provenance: { source: 'simulator' },
  timestamps: { createdAt: at, updatedAt: at },
})

const presentationWith = (icons: Readonly<Record<string, string>>, labels: Readonly<Record<string, string>> = {}) =>
  (object: OperationalObject): PackObjectPresentation => ({
    categoryId: 'fixture',
    icon: icons[object.id] ?? 'square',
    color: '#334155',
    summary: object.label,
    fields: [],
    ...(labels[object.id] ? { mapLabel: labels[object.id] } : {}),
  })

const snapshotOf = (
  objects: ReadonlyArray<OperationalObject>,
  presentationFor: (object: OperationalObject) => PackObjectPresentation,
  packFeatures: ReadonlyArray<PackMapFeature> = [],
): OperationalRenderSnapshot => createMapFeatureStore().update({
  objects,
  selectedControllerId: null,
  highlightedObjectIds: [],
  hiddenObjectCategoryIds: [], alertPalette: 'day' as const,
  placementPoints: [],
  packFeatures,
  hasNewInfo: () => false,
  presentationFor,
})

const layersOf = (snapshot: OperationalRenderSnapshot, catalogueAtlas: CatalogueSymbolAtlasState) => createOperationalDeckLayers({
  snapshot,
  visibleFamilies: new Set(['objects', 'routes']),
  catalogueAtlas,
  disksPick: false,
  diskClicks: null,
  zoom: 10,
  onObjectSelected: () => undefined,
  onObjectSeen: () => undefined,
  onObjectHover: () => undefined,
})

const todaysLayerIds = [
  'leitbild-assignment-preview-line',
  'leitbild-assignment-crosshair',
  'leitbild-assignment-handles',
  'leitbild-operational-path-casing',
  'leitbild-operational-paths',
  'leitbild-object-halos',
  'leitbild-object-status-disks',
  'leitbild-object-symbols',
  'leitbild-object-new-info',
  'leitbild-area-symbols',
  'leitbild-placement-preview',
]

const flush = async (): Promise<void> => { for (let index = 0; index < 5; index += 1) await Promise.resolve() }

describe('operational map icons', () => {
  test('compiled atlas ids draw from the compiled atlas, any other catalogue id from loaded artwork', () => {
    for (const id of leitbildSymbolIds) expect(symbolAtlasFor(id)).toBe('compiled')
    expect(symbolAtlasFor('anchor')).toBe('catalogue')
    expect(() => symbolAtlasFor('')).toThrow('Operational map icon is empty')
  })

  test('atlas-only objects render exactly the layers and data they always did', () => {
    const snapshot = snapshotOf([objectOf('a', 11.3), objectOf('b', 11.4)], presentationWith({}))
    expect(catalogueSymbolIds(snapshot).size).toBe(0)
    const layers = layersOf(snapshot, emptyCatalogueSymbolAtlas)
    expect(layers.map(layer => layer.id)).toEqual(todaysLayerIds)
    expect(layers.find(layer => layer.id === 'leitbild-object-symbols')?.props.data).toBe(snapshot.points)
  })

  test('an object with a catalogue icon no longer fails the map, and draws no icon until its artwork arrives', () => {
    const snapshot = snapshotOf([objectOf('a', 11.3), objectOf('t', 11.4)], presentationWith({ t: 'anchor' }))
    expect(snapshot.points.find(point => point.id === 't')).toMatchObject({ symbolId: 'anchor', symbolAtlas: 'catalogue' })
    expect([...catalogueSymbolIds(snapshot)]).toEqual(['anchor'])
    const waiting = layersOf(snapshot, emptyCatalogueSymbolAtlas)
    expect(waiting.map(layer => layer.id)).toEqual(todaysLayerIds)
    expect((waiting.find(layer => layer.id === 'leitbild-object-symbols')?.props.data as ReadonlyArray<{ readonly id: string }>).map(point => point.id)).toEqual(['a'])
    const loaded = layersOf(snapshot, { revision: 1, url: 'data:image/png;base64,', mapping: { anchor: { x: 0, y: 0, width: 64, height: 64, anchorX: 32, anchorY: 32, mask: true } } })
    const catalogue = loaded.find(layer => layer.id === 'leitbild-object-catalogue-symbols')
    expect((catalogue?.props.data as ReadonlyArray<{ readonly id: string }>).map(point => point.id)).toEqual(['t'])
    expect(catalogue?.props.pickable).toBe(true)
  })

  test('Pack area symbols with a catalogue icon draw from the catalogue atlas too', () => {
    const feature: PackMapFeature = { id: 'area', categoryId: 'fixture', geometry: geoPointFromLonLat(11.3, 59.1), anchorPoint: geoPointFromLonLat(11.3, 59.1), symbol: { icon: 'package' }, color: '#334155', summary: 'Depot' }
    const snapshot = snapshotOf([], presentationWith({}), [feature])
    expect([...catalogueSymbolIds(snapshot)]).toEqual(['package'])
    const layers = layersOf(snapshot, { revision: 1, url: 'data:image/png;base64,', mapping: { package: { x: 0, y: 0, width: 64, height: 64, anchorX: 32, anchorY: 32, mask: true } } })
    expect(layers.find(layer => layer.id === 'leitbild-area-symbols')?.props.data).toEqual([])
    expect((layers.find(layer => layer.id === 'leitbild-area-catalogue-symbols')?.props.data as ReadonlyArray<{ readonly id: string }>).map(symbol => symbol.id)).toEqual(['area-symbol:area'])
  })

  test('an object arriving mid-Run gives the disk and halo layers new data, so deck sizes their buffers for it; a move alone updates them in place', () => {
    const store = createMapFeatureStore()
    const input = (objects: ReadonlyArray<OperationalObject>) => ({
      objects,
      selectedControllerId: null,
      highlightedObjectIds: [],
      hiddenObjectCategoryIds: [], alertPalette: 'day' as const,
      placementPoints: [],
      packFeatures: [],
      hasNewInfo: () => false,
      presentationFor: presentationWith({}),
    })
    const dataOf = (snapshot: OperationalRenderSnapshot, id: string) => layersOf(snapshot, emptyCatalogueSymbolAtlas).find(layer => layer.id === id)?.props.data as ReadonlyArray<{ readonly id: string }>
    const before = store.update(input([objectOf('a', 11.3), objectOf('b', 11.4)]))
    const disks = dataOf(before, 'leitbild-object-status-disks')
    const halos = dataOf(before, 'leitbild-object-halos')
    const grown = store.update(input([objectOf('a', 11.3), objectOf('b', 11.4), objectOf('c', 11.5)]))
    for (const [id, earlier] of [['leitbild-object-status-disks', disks], ['leitbild-object-halos', halos]] as const) {
      const data = dataOf(grown, id)
      expect(data).not.toBe(earlier)
      expect(data.map(point => point.id)).toEqual(['a', 'b', 'c'])
    }
    expect(disks.map(point => point.id)).toEqual(['a', 'b'])
    const moved = store.update(input([objectOf('a', 11.3), objectOf('b', 11.45), objectOf('c', 11.5)]))
    expect(dataOf(moved, 'leitbild-object-status-disks')).toBe(dataOf(grown, 'leitbild-object-status-disks'))
    expect(moved.revisions.points).toBe(grown.revisions.points + 1)
  })

  test('an object the screen may not order is drawn muted, its presentation aside', () => {
    const store = createMapFeatureStore()
    const snapshot = store.update({
      objects: [objectOf('a', 11.3), objectOf('b', 11.4)],
      selectedControllerId: null,
      highlightedObjectIds: [],
      mutedObjectIds: ['b'],
      hiddenObjectCategoryIds: [], alertPalette: 'day' as const,
      placementPoints: [],
      packFeatures: [],
      hasNewInfo: () => false,
      presentationFor: presentationWith({}),
    })
    expect(snapshot.points.map(point => [point.id, point.muted])).toEqual([['a', false], ['b', true]])
  })

  test('an armed order rings and tags its targets and dims every other object but its own, and nothing changes once it clears', () => {
    const store = createMapFeatureStore()
    const objects = [objectOf('a', 11.3), objectOf('b', 11.4), objectOf('c', 11.5), objectOf('d', 11.6)]
    const input = (targeting: MapTargetingRender | null) => ({
      objects,
      selectedControllerId: 'a',
      highlightedObjectIds: [],
      targeting,
      hiddenObjectCategoryIds: [], alertPalette: 'day' as const,
      placementPoints: [],
      packFeatures: [],
      hasNewInfo: () => false,
      presentationFor: presentationWith({}),
    })
    const plain = store.update(input(null))
    expect(plain.points.map(point => [point.id, point.targetTag, point.dimmed])).toEqual([['a', null, false], ['b', null, false], ['c', null, false], ['d', null, false]])
    const valid = (tag: string) => ({ tag, refused: false })
    const armed = store.update(input({ fromId: 'a', targets: new Map([['b', valid('4 min')], ['c', valid('Move · 9 min')]]) }))
    expect(armed.revisions.points).toBe(plain.revisions.points + 1)
    expect(armed.points.map(point => [point.id, point.targetTag, point.dimmed, point.color[3]])).toEqual([['a', null, false, 255], ['b', '4 min', false, 255], ['c', 'Move · 9 min', false, 255], ['d', null, true, 72]])
    const layers = layersOf(armed, emptyCatalogueSymbolAtlas)
    const tags = layers.find(layer => layer.id === 'leitbild-target-tags')
    expect((tags?.props.data as ReadonlyArray<{ readonly id: string }>).map(point => point.id)).toEqual(['b', 'c'])
    const halos = layers.find(layer => layer.id === 'leitbild-object-halos')?.props as unknown as { readonly getRadius: (point: unknown) => number }
    expect(armed.points.map(point => halos.getRadius(point))).toEqual([18, 18, 18, 0])
    const cleared = store.update(input(null))
    expect(cleared.points.map(point => [point.id, point.targetTag, point.dimmed])).toEqual(plain.points.map(point => [point.id, point.targetTag, point.dimmed]))
    expect(layersOf(cleared, emptyCatalogueSymbolAtlas).map(layer => layer.id)).toEqual(todaysLayerIds)
  })

  test('a target a click was just refused for is ringed and tagged apart, with the refusal as its tag, and never dimmed', () => {
    const store = createMapFeatureStore()
    const objects = [objectOf('a', 11.3), objectOf('b', 11.4), objectOf('c', 11.5), objectOf('d', 11.6)]
    const armed = store.update({
      objects,
      selectedControllerId: 'a',
      highlightedObjectIds: [],
      targeting: { fromId: 'a', targets: new Map([['b', { tag: 'Needs fire suppression', refused: true }], ['c', { tag: '4 min', refused: false }]]) },
      hiddenObjectCategoryIds: [], alertPalette: 'day' as const,
      placementPoints: [],
      packFeatures: [],
      hasNewInfo: () => false,
      presentationFor: presentationWith({}),
    })
    expect(armed.points.map(point => [point.id, point.targetTag, point.targetRefused, point.dimmed])).toEqual([['a', null, false, false], ['b', 'Needs fire suppression', true, false], ['c', '4 min', false, false], ['d', null, false, true]])
    const layers = layersOf(armed, emptyCatalogueSymbolAtlas)
    const [refused, valid] = ['b', 'c'].map(id => armed.points.find(point => point.id === id)!)
    const halos = layers.find(layer => layer.id === 'leitbild-object-halos')?.props as unknown as { readonly getRadius: (point: unknown) => number; readonly getLineColor: (point: unknown) => ReadonlyArray<number> }
    expect([halos.getRadius(refused), halos.getRadius(valid)]).toEqual([18, 18])
    expect(halos.getLineColor(refused)).not.toEqual(halos.getLineColor(valid))
    const tags = layers.find(layer => layer.id === 'leitbild-target-tags')?.props as unknown as { readonly data: ReadonlyArray<{ readonly id: string }>; readonly getBackgroundColor: (point: unknown) => ReadonlyArray<number>; readonly maxWidth: number }
    expect(tags.data.map(point => point.id)).toEqual(['b', 'c'])
    expect(tags.getBackgroundColor(refused)).toEqual(halos.getLineColor(refused))
    expect(tags.getBackgroundColor(valid)).toEqual(halos.getLineColor(valid))
    // A refusal wraps instead of running across the map.
    expect(tags.maxWidth).toBeGreaterThan(0)
  })

  test('a tap or hover on a target\'s tag acts on that target, never on the ground or an icon beneath it', () => {
    const store = createMapFeatureStore()
    const objects = [objectOf('a', 11.3), objectOf('b', 11.4), objectOf('c', 11.5)]
    const armed = store.update({
      objects,
      selectedControllerId: 'a',
      highlightedObjectIds: [],
      targeting: { fromId: 'a', targets: new Map([['b', { tag: '4 min', refused: false }], ['c', { tag: '9 min', refused: false }]]) },
      hiddenObjectCategoryIds: [], alertPalette: 'day' as const,
      placementPoints: [],
      packFeatures: [],
      hasNewInfo: () => false,
      presentationFor: presentationWith({}),
    })
    const selected: string[] = []
    const seen: string[] = []
    const hovered: Array<string | null> = []
    const tags = createOperationalDeckLayers({
      snapshot: armed,
      visibleFamilies: new Set(['objects', 'routes']),
      catalogueAtlas: emptyCatalogueSymbolAtlas,
      disksPick: true,
      diskClicks: null,
      zoom: 10,
      onObjectSelected: point => { selected.push(point.id) },
      onObjectSeen: point => { seen.push(point.id) },
      onObjectHover: point => { hovered.push(point?.id ?? null) },
    }).find(layer => layer.id === 'leitbild-target-tags')
    expect(tags?.props.pickable).toBe(true)
    // deck.gl hands a click on a tag, its text or its pill, the tag's own data row: the target's point.
    const tagged = (tags?.props.data as ReadonlyArray<{ readonly id: string }>).find(point => point.id === 'c')
    type Pick = (info: { readonly object: unknown }) => void
    ;(tags?.props.onClick as unknown as Pick)({ object: tagged })
    ;(tags?.props.onHover as unknown as Pick)({ object: tagged })
    ;(tags?.props.onHover as unknown as Pick)({ object: undefined })
    expect(selected).toEqual(['c'])
    expect(seen).toEqual(['c'])
    expect(hovered).toEqual(['c', null])
  })

  test('labels are drawn natively only for objects whose Pack presents one', () => {
    const snapshot = snapshotOf([objectOf('a', 11.3), objectOf('b', 11.4)], presentationWith({}, { b: 'B2 · ENR' }))
    expect(snapshot.points.find(point => point.id === 'a')?.label).toBeNull()
    const labels = layersOf(snapshot, emptyCatalogueSymbolAtlas).find(layer => layer.id === 'leitbild-object-labels')
    expect((labels?.props.data as ReadonlyArray<{ readonly label: string }>).map(point => point.label)).toEqual(['B2 · ENR'])
  })

  test('a click or hover on a label acts on its object, so it never counts as open ground', () => {
    const snapshot = snapshotOf([objectOf('a', 11.3), objectOf('b', 11.4)], presentationWith({}, { b: 'B2 · ENR' }))
    const selected: string[] = []
    const seen: string[] = []
    const hovered: Array<string | null> = []
    const labels = createOperationalDeckLayers({
      snapshot,
      visibleFamilies: new Set(['objects', 'routes']),
      catalogueAtlas: emptyCatalogueSymbolAtlas,
      disksPick: false,
      diskClicks: null,
      zoom: 10,
      onObjectSelected: point => { selected.push(point.id) },
      onObjectSeen: point => { seen.push(point.id) },
      onObjectHover: point => { hovered.push(point?.id ?? null) },
    }).find(layer => layer.id === 'leitbild-object-labels')
    expect(labels?.props.pickable).toBe(true)
    const labelled = snapshot.points.find(point => point.id === 'b')
    type Pick = (info: { readonly object: unknown }) => void
    ;(labels?.props.onClick as unknown as Pick)({ object: labelled })
    ;(labels?.props.onHover as unknown as Pick)({ object: labelled })
    ;(labels?.props.onHover as unknown as Pick)({ object: undefined })
    expect(selected).toEqual(['b'])
    expect(seen).toEqual(['b'])
    expect(hovered).toEqual(['b', null])
  })
})

describe('catalogue symbol atlas', () => {
  interface FakeImage { readonly svg: string }

  const harness = (
    artwork: (ids: ReadonlyArray<string>) => Promise<ReadonlyMap<string, string>>,
    overrides: Partial<Pick<CatalogueSymbolAtlasPorts<FakeImage>, 'compose' | 'onChange'>> = {},
  ) => {
    const loads: Array<ReadonlyArray<string>> = []
    const composed: Array<{ readonly cells: ReadonlyArray<CatalogueAtlasCell<FakeImage>>; readonly size: { readonly width: number; readonly height: number } }> = []
    const changes: CatalogueSymbolAtlasState[] = []
    const errors: string[] = []
    const atlas = createCatalogueSymbolAtlas<FakeImage>({
      loadArtwork: async ids => { loads.push(ids); return await artwork(ids) },
      rasterize: async svg => ({ svg }),
      compose: (cells, size) => { composed.push({ cells, size }); return `atlas:${cells.map(cell => cell.id).join(',')}` },
      onChange: state => { changes.push(state) },
      onError: message => { errors.push(message) },
      ...overrides,
    })
    return { atlas, loads, composed, changes, errors }
  }

  const known = async (ids: ReadonlyArray<string>) => new Map(ids.filter(id => id !== 'nonsense').map(id => [id, `<svg>${id}</svg>`]))

  test('loads artwork once per icon and packs it into 64 px cells, eight to a row', async () => {
    const run = harness(known)
    run.atlas.request(['anchor', 'package', 'anchor'])
    run.atlas.request(['anchor'])
    await flush()
    expect(run.loads).toEqual([['anchor', 'package']])
    const state = run.atlas.current()
    expect(state.url).toBe('atlas:anchor,package')
    expect(state.mapping.package).toEqual({ x: 64, y: 0, width: 64, height: 64, anchorX: 32, anchorY: 32, mask: true })
    expect(run.composed[0]?.size).toEqual({ width: 512, height: 64 })
    expect(run.composed[0]?.cells.map(cell => [cell.id, cell.x, cell.y, cell.image.svg])).toEqual([['anchor', 8, 8, '<svg>anchor</svg>'], ['package', 72, 8, '<svg>package</svg>']])
    expect(run.changes.map(change => change.revision)).toEqual([1])
    run.atlas.request(['package', 'ship'])
    await flush()
    expect(run.loads).toEqual([['anchor', 'package'], ['ship']])
    expect(run.atlas.current()).toMatchObject({ revision: 2, url: 'atlas:anchor,package,ship' })
  })

  test('reports an icon without artwork once and never asks for it again', async () => {
    const run = harness(known)
    run.atlas.request(['nonsense', 'anchor'])
    await flush()
    run.atlas.request(['nonsense'])
    await flush()
    expect(run.errors).toEqual(['No map artwork for icon: nonsense'])
    expect(run.loads).toEqual([['nonsense', 'anchor']])
    expect(Object.keys(run.atlas.current().mapping)).toEqual(['anchor'])
  })

  test('reports a failed load with the icons it was for', async () => {
    const run = harness(async () => { throw new Error('Unknown icon name; discover available names with world.map.symbols') })
    run.atlas.request(['anchor', 'package'])
    await flush()
    expect(run.errors).toEqual(['No map artwork for icon: anchor, package (Unknown icon name; discover available names with world.map.symbols)'])
    expect(run.atlas.current()).toBe(emptyCatalogueSymbolAtlas)
  })

  test('an atlas that fails to compose or publish is reported on the error path, never left unhandled', async () => {
    let composeFails = true
    const composing = harness(known, {
      compose: cells => {
        if (composeFails) throw new Error('canvas 2D context unavailable')
        return `atlas:${cells.map(cell => cell.id).join(',')}`
      },
    })
    composing.atlas.request(['anchor'])
    await flush()
    expect(composing.errors).toEqual(['Map icon atlas: canvas 2D context unavailable'])
    expect(composing.atlas.current()).toBe(emptyCatalogueSymbolAtlas)
    composeFails = false
    composing.atlas.request(['package'])
    await flush()
    expect(composing.atlas.current()).toMatchObject({ revision: 1, url: 'atlas:anchor,package' })

    const publishing = harness(known, { onChange: () => { throw new Error('deck layer update failed') } })
    publishing.atlas.request(['anchor'])
    await flush()
    expect(publishing.errors).toEqual(['Map icon atlas: deck layer update failed'])
  })

  test('a load from before a reset never lands', async () => {
    let release: (value: ReadonlyMap<string, string>) => void = () => undefined
    const run = harness(() => new Promise(resolve => { release = resolve }))
    run.atlas.request(['anchor'])
    run.atlas.reset()
    release(new Map([['anchor', '<svg/>']]))
    await flush()
    expect(run.changes).toEqual([])
    expect(run.atlas.current().url).toBeNull()
  })

  test('while the surface picks targets, a mouse click on an icon\'s coloured disk between the glyph\'s strokes picks its object; otherwise the disks never pick, so every other Pack and a finger or pen pick as before', () => {
    const snapshot = snapshotOf([objectOf('a', 11.3), objectOf('b', 11.4)], presentationWith({}, { b: 'B2 · ENR' }))
    type Pick = (info: { readonly object: unknown }) => void
    const layersFor = (disksPick: boolean, selected: string[], hovered: Array<string | null>) => createOperationalDeckLayers({
      snapshot,
      visibleFamilies: new Set(['objects', 'routes']),
      catalogueAtlas: emptyCatalogueSymbolAtlas,
      disksPick,
      diskClicks: null,
      zoom: 10,
      onObjectSelected: point => { selected.push(point.id) },
      onObjectSeen: () => undefined,
      onObjectHover: point => { hovered.push(point?.id ?? null) },
    })
    const selected: string[] = []
    const hovered: Array<string | null> = []
    // A mouse on a surface whose open panel takes map targets.
    const targets = layersFor(disksPickFor(true, pickingRadiusFor('mouse', operationalIconPx)), selected, hovered)
    const disks = targets.find(layer => layer.id === 'leitbild-object-status-disks')
    expect(disks?.props.pickable).toBe(true)
    ;(disks?.props.onClick as unknown as Pick)({ object: snapshot.points[0] })
    ;(disks?.props.onHover as unknown as Pick)({ object: snapshot.points[0] })
    expect(selected).toEqual([snapshot.points[0]!.id])
    expect(hovered).toEqual([snapshot.points[0]!.id])
    // A Pack whose surface takes no map targets, with any pointer, and a finger or pen on one that does.
    const plain = [
      ...[null, 'mouse', 'touch', 'pen'].map(type => layersFor(disksPickFor(false, pickingRadiusFor(type, operationalIconPx)), [], [])),
      ...['touch', 'pen'].map(type => layersFor(disksPickFor(true, pickingRadiusFor(type, operationalIconPx)), [], [])),
    ]
    for (const layers of plain) {
      const plainDisks = layers.find(layer => layer.id === 'leitbild-object-status-disks')
      expect(plainDisks?.props.pickable).toBe(false)
      expect(plainDisks?.props.onClick ?? null).toBeNull()
      expect(plainDisks?.props.onHover ?? null).toBeNull()
    }
    // The glyphs and labels pick the same either way.
    for (const id of ['leitbild-object-symbols', 'leitbild-object-labels']) {
      expect(targets.find(layer => layer.id === id)?.props.pickable).toBe(true)
      for (const layers of plain) expect(layers.find(layer => layer.id === id)?.props.pickable).toBe(true)
    }
    // Halos and new-info rings never pick.
    for (const id of ['leitbild-object-halos', 'leitbild-object-new-info']) {
      expect(targets.find(layer => layer.id === id)?.props.pickable).toBe(false)
    }
  })

  test('the whole disk of an object a click opens a card for takes a mouse click and hover on every surface, through a transparent layer of those disks alone; a finger, a pen and every other object pick as before', () => {
    const snapshot = snapshotOf([objectOf('a', 11.3), objectOf('b', 11.4)], presentationWith({}, {}))
    const cardObjectId = snapshot.points[1]!.object.id
    type Pick = (info: { readonly object: unknown }) => void
    const layersFor = (disksPick: boolean, pointerType: string | null, selected: string[], hovered: Array<string | null>) => createOperationalDeckLayers({
      snapshot,
      visibleFamilies: new Set(['objects', 'routes']),
      catalogueAtlas: emptyCatalogueSymbolAtlas,
      disksPick,
      diskClicks: pickingRadiusFor(pointerType, operationalIconPx) === 0 ? object => object.id === cardObjectId : null,
      zoom: 10,
      onObjectSelected: point => { selected.push(point.id) },
      onObjectSeen: () => undefined,
      onObjectHover: point => { hovered.push(point?.id ?? null) },
    })
    const selected: string[] = []
    const hovered: Array<string | null> = []
    const mouse = layersFor(false, 'mouse', selected, hovered)
    const hits = mouse.find(layer => layer.id === 'leitbild-object-disk-clicks')
    expect(hits?.props.pickable).toBe(true)
    expect((hits?.props.data as ReadonlyArray<{ readonly id: string }>).map(point => point.id)).toEqual([snapshot.points[1]!.id])
    expect((hits?.props as unknown as { readonly getFillColor: unknown }).getFillColor).toEqual([0, 0, 0, 0])
    ;(hits?.props.onClick as unknown as Pick)({ object: snapshot.points[1] })
    ;(hits?.props.onHover as unknown as Pick)({ object: snapshot.points[1] })
    expect(selected).toEqual([snapshot.points[1]!.id])
    expect(hovered).toEqual([snapshot.points[1]!.id])
    // The drawn disks still pick only while the surface picks targets.
    expect(mouse.find(layer => layer.id === 'leitbild-object-status-disks')?.props.pickable).toBe(false)
    // Below the glyphs, which keep their own picking.
    const ids = mouse.map(layer => layer.id)
    expect(ids.indexOf('leitbild-object-disk-clicks')).toBeLessThan(ids.indexOf('leitbild-object-symbols'))
    // A finger or a pen, and a surface whose every disk already picks, draw no such layer.
    for (const layers of [layersFor(false, 'touch', [], []), layersFor(false, 'pen', [], []), layersFor(true, 'mouse', [], [])]) {
      expect(layers.some(layer => layer.id === 'leitbild-object-disk-clicks')).toBe(false)
    }
  })
})
