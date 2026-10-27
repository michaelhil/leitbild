import { expect, test } from 'bun:test'
import { explorerGroupKey, explorerLayoutKey, explorerScopeAncestors, explorerScopeBranches, explorerScopeChoices, type ExplorerScopeBranch, type ExplorerScopeChoice } from '../src/ui/physical-layout/explorer-model.ts'
import { physicalExplorerFitPadding, physicalExplorerFitRect } from '../src/ui/physical-layout/explorer-viewport.ts'
import type { PhysicalSceneDescriptor } from '../src/ui/map/physical-scene/types.ts'
import { Map as MapLibreMap } from 'maplibre-gl'
import { createMapPhysicalViewport } from '../src/ui/map/physical-scene/map-viewport.ts'
import { createFakeMapStyle } from './helpers/fake-map-style.ts'

const all = (branches: ReadonlyArray<ExplorerScopeBranch>): string[] => branches.flatMap(branch => [branch.choice.key, ...all(branch.children)])
const choices = (): ExplorerScopeChoice[] => [
  { key: 'site', sceneId: null, groupId: 'site', label: 'Plant site', path: 'Plant site', kind: 'site group', depth: 0 },
  ...Array.from({ length: 4 }, (_, unit) => {
    const key = `unit-${unit}`, label = `Unit ${unit + 1}`
    return [
      { key, parentKey: 'site', sceneId: key, label, path: label, kind: 'unit', depth: 1 },
      { key: `${key}/hall`, parentKey: key, sceneId: key, label: 'Turbine building', path: `${label} / Turbine building`, kind: 'building', depth: 2 },
      ...Array.from({ length: 100 }, (_, room) => ({ key: `${key}/room-${room}`, parentKey: `${key}/hall`, sceneId: key, label: 'Equipment room', path: `${label} / Turbine building / Equipment room`, levelContext: `Deck ${room} · +${room} m`, kind: 'space', depth: 3 })),
    ]
  }).flat(),
]

test('a large admitted area hierarchy exposes only explicit expanded descendants', () => {
  const source = choices()
  expect(source.length).toBe(409)
  expect(all(explorerScopeBranches(source, new Set()))).toEqual(['site'])
  expect(all(explorerScopeBranches(source, new Set(['site'])))).toEqual(['site', 'unit-0', 'unit-1', 'unit-2', 'unit-3'])
  expect(all(explorerScopeBranches(source, new Set(['site', 'unit-2'])))).toEqual(['site', 'unit-0', 'unit-1', 'unit-2', 'unit-2/hall', 'unit-3'])
  const expanded = explorerScopeBranches(source, new Set(['site', 'unit-2', 'unit-2/hall']))
  expect(all(expanded).filter(key => key.includes('/room-')).length).toBe(100)
  expect(explorerScopeAncestors(source, 'unit-2/room-99')).toEqual(['unit-2/room-99', 'unit-2/hall', 'unit-2', 'site'])
})

test('area search reveals matching room level context with its actual ancestry, without expanding unrelated units', () => {
  const result = explorerScopeBranches(choices(), new Set(), 'Unit 3 Deck 99')
  expect(all(result)).toEqual(['site', 'unit-2', 'unit-2/hall', 'unit-2/room-99'])
  expect(result[0]!.children[0]!.children[0]!.children[0]!.choice.levelContext).toBe('Deck 99 · +99 m')
  expect(explorerScopeBranches(choices(), new Set(), 'unavailable annex')).toEqual([])
})

test('room choices derive floor labels and preserve explicit source and authored root parentage', () => {
  const bounds = { min: [0, 0, 0], max: [10, 10, 20] }
  const descriptor = { id: 'unit', targetObjectId: 'plant', group: { id: 'campus', label: 'Campus' }, bounds,
    levels: [{ id: 'lower', label: 'Condenser floor', elevation: 0, cutHeight: 1.2 }, { id: 'upper', label: 'Operating floor', elevation: 15, cutHeight: 16.2 }],
    scopes: [
      { id: 'root', label: 'PWR unit', kind: 'unit', bounds, levelIds: ['lower', 'upper'] },
      { id: 'hall', parentId: 'root', label: 'Turbine hall', kind: 'building', bounds, levelIds: ['lower', 'upper'] },
      { id: 'upper-room', parentId: 'hall', label: 'Equipment room', kind: 'space', bounds, levelIds: ['upper'] },
      { id: 'lower-room', parentId: 'hall', label: 'Equipment room', kind: 'space', bounds, levelIds: ['lower'] },
    ],
  } as PhysicalSceneDescriptor
  const result = explorerScopeChoices(descriptor, 'Unit 1')
  expect(result.map(choice => JSON.parse(choice.key))).toEqual([['layout', 'unit'], ['scope', 'unit', 'root'], ['scope', 'unit', 'hall'], ['scope', 'unit', 'upper-room'], ['scope', 'unit', 'lower-room']])
  expect(JSON.parse(result[0]!.parentKey!)).toEqual(['group', 'campus'])
  expect(JSON.parse(result[1]!.parentKey!)).toEqual(['layout', 'unit'])
  expect(JSON.parse(result[2]!.parentKey!)).toEqual(['scope', 'unit', 'root'])
  expect(result[3]!.levelContext).toBe('Operating floor · +15 m')
  expect(result[4]!.levelContext).toBe('Condenser floor · 0 m')
  expect(result[3]!.path).toBe('Unit 1 / PWR unit / Turbine hall / Equipment room')
  expect(result[3]!.groupId).toBe('campus')
})

test('product physical inspection has one native map controller and no alternate viewport launch or canvas', async () => {
  const [route, map, explorer, controls] = await Promise.all([
    '../src/ui/routes/ControlSurfaceRoute.svelte', '../src/ui/OperationalMap.svelte',
    '../src/ui/physical-layout/PhysicalExplorer.svelte', '../src/ui/physical-layout/Controls.svelte',
  ].map(path => Bun.file(new URL(path, import.meta.url)).text()))
  expect(map).toContain("import('./physical-layout/PhysicalExplorer.svelte')")
  expect(explorer).toContain('createPhysicalSceneController({ ...options, map,')
  for (const source of [route!, map!, explorer!, controls!]) {
    for (const retired of ['LayoutBrowser', 'onbrowser', 'onback', 'Open layout browser', 'Back to map', 'createPhysicalCanvasController', 'class="layout-canvas"']) expect(source).not.toContain(retired)
  }
  expect(route).not.toContain('layoutBrowser')
  expect(route).not.toContain('<PhysicalExplorer')
})

test('source, group and scope navigation identities cannot collide through separators', () => {
  expect(new Set([explorerGroupKey('foo'), explorerLayoutKey('group:foo'), explorerLayoutKey('a/b', 'c'), explorerLayoutKey('a', 'b/c')]).size).toBe(4)
})

const zero = { top: 0, right: 0, bottom: 0, left: 0 }
test('floating corner controls retain full usable height and improve actual common-camera fit scale', () => {
  const viewport = { width: 1280, height: 720 }
  const covers = [{ x: 888, y: 12, width: 380, height: 208 }, { x: 944, y: 574, width: 324, height: 100 }]
  const rect = physicalExplorerFitRect(viewport, zero, covers)!
  expect(rect.height).toBe(696)
  expect(rect.width).toBe(864)
  expect(Math.min(rect.width, rect.height)).toBe(696)
  for (const cover of covers) expect(rect.x + rect.width <= cover.x || rect.x >= cover.x + cover.width || rect.y + rect.height <= cover.y || rect.y >= cover.y + cover.height).toBe(true)
  expect(physicalExplorerFitPadding(viewport, zero, covers)).toEqual({ top: 12, left: 12, bottom: 12, right: 404 })
})

test('actual narrow full-width controls yield clear strips without a device breakpoint or source-count limit', () => {
  const viewport = { width: 319, height: 827 }
  const covers = [{ x: 8, y: 8, width: 303, height: 218 }, { x: 8, y: 677, width: 303, height: 104 }]
  const rect = physicalExplorerFitRect(viewport, zero, covers)!
  expect(rect).toEqual({ x: 12, y: 238, width: 295, height: 427 })
  expect(physicalExplorerFitPadding(viewport, zero, covers)).toEqual({ left: 12, right: 12, top: 238, bottom: 162 })
  expect(physicalExplorerFitRect(viewport, zero, [{ x: 0, y: 0, ...viewport }])).toBeNull()
})

test('external operational padding and occluding inspectors are preserved by physical focus', () => {
  const viewport = { width: 1280, height: 720 }, padding = { top: 80, left: 0, right: 100, bottom: 0 }
  const rect = physicalExplorerFitRect(viewport, padding, [{ x: 12, y: 100, width: 360, height: 420 }])!
  expect(rect.y).toBeGreaterThanOrEqual(92)
  expect(rect.x).toBeGreaterThanOrEqual(384)
  expect(rect.x + rect.width).toBeLessThanOrEqual(1168)
})

test('the real Plan adapter and pinned MapLibre fit do not retain camera-fit padding as a UI cover', () => {
  const fake = createFakeMapStyle(), reserved = { top: 80, right: 100, bottom: 0, left: 0 }
  const canvas = Object.assign(new EventTarget(), { getBoundingClientRect: () => ({ width: 1280, height: 720 }) })
  const moves: Array<Record<string, unknown>> = []
  // Use the installed library's actual fitBounds/_fitInternal implementation.
  // Only geographic camera calculation and final animation are test doubles.
  Object.setPrototypeOf(fake.map, MapLibreMap.prototype)
  Object.assign(fake.map, {
    getCanvas: () => canvas, getBearing: () => 0, getPadding: () => reserved, getCenterElevation: () => 0,
    cameraForBounds: () => ({ center: [11.47, 59.087], zoom: 18, bearing: 0 }),
    flyTo: (options: Record<string, unknown>) => { moves.push(options); return fake.map },
  })
  const viewport = createMapPhysicalViewport(fake.map, () => undefined)
  const fit = physicalExplorerFitPadding({ width: 1280, height: 720 }, reserved, [{ x: 12, y: 100, width: 360, height: 420 }])
  expect(fit.left).toBeGreaterThan(reserved.left)
  for (let repeat = 0; repeat < 3; repeat++) viewport.fitWorld({ min: [.53, .29, 0], max: [.531, .291, 0] }, { padding: fit, preservePose: false, mode: '2d', bearing: 0 })
  expect(moves).toHaveLength(3)
  for (const move of moves) expect(move).not.toHaveProperty('padding')
  expect(viewport.surface.getPadding()).toEqual(reserved)
  viewport.destroy()
})
