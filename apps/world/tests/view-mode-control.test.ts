import { expect, test } from 'bun:test'
import { viewModeControlState } from '../src/ui/map/view-mode-control.ts'
import { physicalExplorerModeRestore, physicalExplorerViewModeInput } from '../src/ui/physical-layout/explorer-interaction.ts'
import { physicalExplorerFitRect, type ExplorerViewportPadding, type ExplorerViewportRect } from '../src/ui/physical-layout/explorer-viewport.ts'

test('the 3D switch shows the representation and asks for the other one', () => {
  expect(viewModeControlState({ mode: '2d', disabledReason: null })).toEqual({ pressed: false, disabled: false, title: 'Show in 3D', next: '3d' })
  expect(viewModeControlState({ mode: '3d', disabledReason: null })).toEqual({ pressed: true, disabled: false, title: 'Return to the plan view', next: '2d' })
})

test('a disabled 3D switch keeps its representation, carries its reason and asks for nothing', () => {
  expect(viewModeControlState({ mode: '3d', disabledReason: 'Not now' })).toEqual({ pressed: true, disabled: true, title: 'Not now', next: null })
  expect(viewModeControlState({ mode: '2d', disabledReason: 'Not now' })).toEqual({ pressed: false, disabled: true, title: 'Not now', next: null })
})

test('the explorer enables the switch for its layouts and says why it waits while suspended or without a layout', () => {
  expect(physicalExplorerViewModeInput({ mode: '2d', suspended: false })).toEqual({ mode: '2d', disabledReason: null })
  expect(physicalExplorerViewModeInput({ mode: '3d', suspended: false })).toEqual({ mode: '3d', disabledReason: null })
  const suspended = physicalExplorerViewModeInput({ mode: '3d', suspended: true })
  expect(suspended).toEqual({ mode: '3d', disabledReason: 'Plan and 3D wait while an object is being placed or directed on the map' })
  expect(viewModeControlState(suspended).next).toBeNull()
  // No layout on the map: nothing is in 3D, and a suspended map changes nothing about that.
  for (const state of [false, true]) {
    const none = physicalExplorerViewModeInput({ mode: null, suspended: state })
    expect(none).toEqual({ mode: '2d', disabledReason: 'No physical layout is shown on this map' })
    expect(viewModeControlState(none)).toMatchObject({ pressed: false, disabled: true, next: null })
  }
})

test('a remembered 3D waits until a press could act and be seen, then comes back once; layouts already in 3D need nothing', () => {
  const ready = { mode: '2d' as const, active: true, documentVisible: true, suspended: false }
  expect(physicalExplorerModeRestore(ready)).toBe('restore')
  // No layout is on the map yet, an order is being placed or directed, the explorer is inactive, or the page is hidden.
  expect(physicalExplorerModeRestore({ ...ready, mode: null })).toBe('wait')
  expect(physicalExplorerModeRestore({ ...ready, suspended: true })).toBe('wait')
  expect(physicalExplorerModeRestore({ ...ready, active: false })).toBe('wait')
  expect(physicalExplorerModeRestore({ ...ready, documentVisible: false })).toBe('wait')
  // Whatever else holds, 3D that is already shown is not framed again.
  for (const state of [ready, { ...ready, suspended: true }, { ...ready, documentVisible: false }]) expect(physicalExplorerModeRestore({ ...state, mode: '3d' })).toBe('drop')
})

test('the remembered mode is written where the switch changes it and restored once, by a press that leaves the toolbar alone', async () => {
  const source = (path: string): Promise<string> => Bun.file(new URL(`../src/ui/${path}`, import.meta.url)).text()
  const [explorer, controller, route, map] = await Promise.all([source('physical-layout/PhysicalExplorer.svelte'), source('map/physical-scene/scene-controller.ts'), source('routes/ControlSurfaceRoute.svelte'), source('OperationalMap.svelte')])
  const change = explorer.slice(explorer.indexOf('const changeMapViewMode = '), explorer.indexOf('const changeCollectionFloor = '))
  // One callback, from the one place the switch changes the mode, after the guard that refuses a press.
  expect(explorer.match(/\bonmode\(/g)).toHaveLength(1)
  expect(change).toMatch(/if \(suspended \|\| !scene\) return\s[\s\S]*restorePending = false\s[\s\S]*if \(mode === '3d' && !restored\) controlsOpen = true\s[\s\S]*changeView\(\{ \.\.\.scene\.view, mode \}, \{ mode \}\)\s*onmode\(mode\)/)
  // The restore: decided by the tested rule, cleared before it acts, and the same press with the toolbar left as it was.
  expect(change).toMatch(/let restorePending = untrack\(\(\) => rememberedMode === '3d'\)\s*\$effect\(\(\) => \{\s*if \(!restorePending\) return\s*const decision = physicalExplorerModeRestore\(\{ mode: focused\?\.view\.mode \?\? null, active, documentVisible, suspended \}\)\s*if \(decision === 'wait'\) return\s*restorePending = false\s*if \(decision === 'restore'\) untrack\(\(\) => changeMapViewMode\('3d', true\)\)/)
  expect(explorer.match(/restorePending = /g)).toHaveLength(3)
  // The scene controller knows nothing of a remembered mode.
  expect(controller).not.toMatch(/initialMode|rememberedMode/)
  // The route keeps what the callback reported; it mirrors no explorer state.
  expect(route).toContain('onPhysicalLayoutMode={mode => { layoutMode = mode }}')
  expect(route.match(/layoutMode = /g)).toHaveLength(3)
  // A mode change frames the layouts, so the map stops returning to the Starting View when a panel opens.
  expect(map).toMatch(/const changedPhysicalLayoutMode = \(mode: ViewMode\): void => \{\s*startingCamera = false\s*onPhysicalLayoutMode\(mode\)\s*\}/)
})

// The map's bottom-right stack as MapLibre lays it out: the compact credit
// (24 x 24, 10 px margins), the navigation group above it (29 x 87: zoom in,
// zoom out, compass) and, new, the 3D switch above that (one 29 px button
// after a 10 px margin, so the stack grows by 39 px). The camera group tops
// the stack on every map: one row of two or three 29 px buttons (Home, Fit all
// visible and, with a selection on the map, Fit selection) after another 10 px
// margin, so it is up to 58 px wider than the groups below it.
const stack = (size: { readonly width: number; readonly height: number }, withSwitch: boolean, cameraButtons: 0 | 2 | 3 = 0): ReadonlyArray<ExplorerViewportRect> => {
  const credit = { x: size.width - 34, y: size.height - 34, width: 24, height: 24 }
  const navigation = { x: size.width - 39, y: size.height - 44 - 87, width: 29, height: 87 }
  const viewMode = { x: navigation.x, y: navigation.y - 10 - 29, width: 29, height: 29 }
  const below = withSwitch ? [credit, navigation, viewMode] : [credit, navigation]
  if (cameraButtons === 0) return below
  const top = below.at(-1)!
  return [...below, { x: size.width - 10 - 29 * cameraButtons, y: top.y - 10 - 29, width: 29 * cameraButtons, height: 29 }]
}
const noPadding: ExplorerViewportPadding = { top: 0, right: 0, bottom: 0, left: 0 }

test('the taller bottom-right stack never squeezes a fitted layout into a strip', () => {
  for (const size of [{ width: 350, height: 600 }, { width: 760, height: 600 }, { width: 1400, height: 800 }]) {
    for (const [name, target] of Object.entries({ wide: { width: 3, height: 1 }, square: { width: 1, height: 1 }, tall: { width: 1, height: 3 } })) {
      // The camera's measure: the scale at which the target fits the offered rectangle.
      const scale = (padding: ExplorerViewportPadding): number => Math.min((size.width - padding.left - padding.right) / target.width, (size.height - padding.top - padding.bottom) / target.height)
      const fit = (withSwitch: boolean): ExplorerViewportRect => {
        const rect = physicalExplorerFitRect(size, noPadding, stack(size, withSwitch), 12, scale)
        if (rect === null) throw new Error(`no clear rectangle at ${size.width}x${size.height}`)
        return rect
      }
      const drawn = (rect: ExplorerViewportRect): number => Math.min(rect.width / target.width, rect.height / target.height)
      const before = fit(false), after = fit(true), label = `${size.width}x${size.height} ${name}`
      // Bound 1: the layout is drawn exactly as large as without the switch.
      expect(drawn(after), label).toBe(drawn(before))
      // Bound 2: the rectangle is the slab beside the stack (the viewport less
      // 12 px clearance on the left and 51 px for the stack and its clearance)
      // or the band above it (the viewport less 12 px clearance at the top and
      // 182 px for the stack, its margins and clearance): never a narrower strip.
      expect(after.width, label).toBeGreaterThanOrEqual(size.width - 63)
      expect(after.height, label).toBeGreaterThanOrEqual(size.height - 194)
      // Bound 3: the switch moves nothing sideways and costs at most its own 39 px of height.
      expect({ x: after.x, y: after.y, width: after.width }, label).toEqual({ x: before.x, y: before.y, width: before.width })
      expect(before.height - after.height, label).toBeGreaterThanOrEqual(0)
      expect(before.height - after.height, label).toBeLessThanOrEqual(39)
    }
  }
})

test('the camera row above the switch costs a fitted layout at most its own width or height, never a strip', () => {
  const targets = { wide: { width: 3, height: 1 }, square: { width: 1, height: 1 }, tall: { width: 1, height: 3 } }
  // The last three are a short split pane, about 280 to 340 px high.
  for (const size of [{ width: 350, height: 600 }, { width: 760, height: 600 }, { width: 1400, height: 800 }, { width: 350, height: 300 }, { width: 760, height: 280 }, { width: 1400, height: 340 }]) {
    for (const [name, target] of Object.entries(targets)) for (const withSwitch of [false, true]) for (const buttons of [2, 3] as const) {
      const scale = (padding: ExplorerViewportPadding): number => Math.min((size.width - padding.left - padding.right) / target.width, (size.height - padding.top - padding.bottom) / target.height)
      const fit = (cameraButtons: 0 | 2 | 3): ExplorerViewportRect => {
        const rect = physicalExplorerFitRect(size, noPadding, stack(size, withSwitch, cameraButtons), 12, scale)
        if (rect === null) throw new Error(`no clear rectangle at ${size.width}x${size.height}`)
        return rect
      }
      const drawn = (rect: ExplorerViewportRect): number => Math.min(rect.width / target.width, rect.height / target.height)
      const before = fit(0), after = fit(buttons), label = `${size.width}x${size.height} ${name} ${withSwitch ? 'with' : 'without'} 3D, ${buttons} buttons`
      const extraWidth = 29 * (buttons - 1)
      // Bound 1: the layout is drawn smaller by at most what the row takes, its extra width or its 39 px of height, and no smaller at all in a pane of ordinary height.
      expect(drawn(before) - drawn(after), label).toBeLessThanOrEqual(Math.max(extraWidth / target.width, 39 / target.height) + 1e-9)
      if (size.height >= 600) expect(drawn(after), label).toBe(drawn(before))
      // Bound 2: the rectangle is never narrower than the slab beside the whole stack, row included.
      expect(after.width, label).toBeGreaterThanOrEqual(size.width - 63 - extraWidth)
      // Bound 3: where the layout keeps its place beside or above the stack, the row costs at most its extra width or its own 39 px of height.
      if (after.y === before.y) {
        expect(before.width - after.width, label).toBeLessThanOrEqual(extraWidth)
        expect(before.height - after.height, label).toBeLessThanOrEqual(39)
      }
    }
  }
})

test('the camera group tops the lower-right stack on every map and keeps itself above the 3D switch', async () => {
  const [map, control] = await Promise.all(['OperationalMap.svelte', 'map/camera-control.ts'].map(path => Bun.file(new URL(`../src/ui/${path}`, import.meta.url)).text()))
  expect(map).toContain("nextRuntime.map.addControl(cameraControl, 'bottom-right')")
  // The explorer adds the switch later and MapLibre would stack it above: the row moves itself back to the top of its corner.
  expect(control).toContain("corner = map.getContainer().querySelector('.maplibregl-ctrl-bottom-right')")
  expect(control).toContain('if (corner !== null && container.parentElement === corner && corner.firstElementChild !== container) corner.prepend(container)')
})

test('the map switch is the one place that changes the representation, added and removed by the explorer', async () => {
  const [explorer, toolbar, control] = await Promise.all(['physical-layout/PhysicalExplorer.svelte', 'physical-layout/Controls.svelte', 'map/view-mode-control.ts']
    .map(path => Bun.file(new URL(`../src/ui/${path}`, import.meta.url)).text()))
  expect(explorer).toContain("map.addControl(viewMode, 'bottom-right')")
  expect(explorer).toContain('map.removeControl(viewMode)')
  expect(toolbar).not.toContain("mode: '3d'")
  expect(toolbar).not.toContain("mode: '2d'")
  // map.remove() and the explorer's cleanup both call onRemove: detaching a node twice is harmless.
  expect(control).toContain('onRemove: () => container.remove()')
})
