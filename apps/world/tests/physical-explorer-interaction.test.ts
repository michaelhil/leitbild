import { expect, test } from 'bun:test'
import { physicalExplorerKeyboardRoute, physicalExplorerNeedsLive, physicalExplorerOperationalCapture } from '../src/ui/physical-layout/explorer-interaction.ts'

test('Escape from a front process window header or Close button belongs to that window, not the underlying browser', () => {
  const canvas = {}, overlay = {}, processWindow = {}, header = {}, close = {}, document = {}, window = {}
  const route = (path: ReadonlyArray<unknown>, defaultPrevented = false) => physicalExplorerKeyboardRoute({ path, surface: canvas, overlay, defaultPrevented, composing: false, descendantOwnsKeys: false })
  // The process window deliberately leaves Escape unprevented when no popover is open.
  expect(route([header, processWindow, document, window])).toBeNull()
  expect(route([close, processWindow, document, window])).toBeNull()
  expect(route([close, processWindow, document, window], true)).toBeNull()
  expect(route([canvas, document, window])).toBe('surface')
  expect(route([{}, overlay, document, window])).toBe('overlay')
})

test('fields, dialogs, compositions and prevented keys retain ownership even inside the explorer overlay', () => {
  const canvas = {}, overlay = {}, input = {}, dialog = {}, document = {}
  const inputEvent = { path: [input, overlay, document], surface: canvas, overlay, defaultPrevented: false, composing: false, descendantOwnsKeys: true }
  expect(physicalExplorerKeyboardRoute(inputEvent)).toBeNull()
  expect(physicalExplorerKeyboardRoute({ ...inputEvent, path: [dialog, overlay, document] })).toBeNull()
  expect(physicalExplorerKeyboardRoute({ ...inputEvent, path: [canvas, document], descendantOwnsKeys: false, composing: true })).toBeNull()
  expect(physicalExplorerKeyboardRoute({ ...inputEvent, descendantOwnsKeys: false, defaultPrevented: true })).toBeNull()
  // A shadow control's composed path contains its host and the actual owning overlay.
  expect(physicalExplorerKeyboardRoute({ ...inputEvent, path: [{}, {}, overlay, document], descendantOwnsKeys: false })).toBe('overlay')
  expect(physicalExplorerKeyboardRoute({ ...inputEvent, path: [], descendantOwnsKeys: false })).toBeNull()
})

const demand = { active: true, documentVisible: true, suspended: false, ready: true, statusLayer: false, sceneId: 'unit-1', inspectedSceneId: null }
test('a Quick look owns current acquisition with the visual status layer off and releases it when closed', () => {
  expect(physicalExplorerNeedsLive(demand)).toBe(false)
  expect(physicalExplorerNeedsLive({ ...demand, inspectedSceneId: 'unit-1' })).toBe(true)
  expect(physicalExplorerNeedsLive({ ...demand, inspectedSceneId: 'unit-2' })).toBe(false)
  expect(physicalExplorerNeedsLive({ ...demand, inspectedSceneId: 'unit-1', active: false })).toBe(false)
  expect(physicalExplorerNeedsLive({ ...demand, inspectedSceneId: 'unit-1', suspended: true })).toBe(false)
  expect(physicalExplorerNeedsLive({ ...demand, inspectedSceneId: 'unit-1', documentVisible: false })).toBe(false)
  expect(physicalExplorerNeedsLive({ ...demand, inspectedSceneId: 'unit-1', ready: false })).toBe(false)
  expect(physicalExplorerNeedsLive({ ...demand, statusLayer: true })).toBe(true)
  expect(demand.statusLayer).toBe(false)
})

test('every operational capture including an armed controller and panel target picking preempts both physical hosts', () => {
  const ordinary = { placement: false, assignment: false, targetPicking: false, controllerSelected: false }
  expect(physicalExplorerOperationalCapture(ordinary)).toBe(false)
  for (const capture of ['placement', 'assignment', 'targetPicking', 'controllerSelected'] as const) {
    const state = { ...ordinary, [capture]: true }
    expect(physicalExplorerOperationalCapture(state)).toBe(true)
    expect(physicalExplorerNeedsLive({ ...demand, inspectedSceneId: 'unit-1', suspended: physicalExplorerOperationalCapture(state) })).toBe(false)
  }
})
