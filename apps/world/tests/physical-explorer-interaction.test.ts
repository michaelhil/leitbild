import { expect, test } from 'bun:test'
import { physicalExplorerKeyboardRoute, physicalExplorerNeedsLive, physicalExplorerOperationalCapture, physicalExplorerStatusLine } from '../src/ui/physical-layout/explorer-interaction.ts'

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

const demand = { active: true, documentVisible: true, suspended: false, sourceLoaded: true, locationValid: true, representation: 'ready' as const, statusLayer: false, sceneId: 'unit-1', inspectedSceneId: null }
test('a Quick look owns current acquisition with the visual status layer off and releases it when closed', () => {
  expect(physicalExplorerNeedsLive(demand)).toBe(false)
  expect(physicalExplorerNeedsLive({ ...demand, inspectedSceneId: 'unit-1' })).toBe(true)
  expect(physicalExplorerNeedsLive({ ...demand, inspectedSceneId: 'unit-2' })).toBe(false)
  expect(physicalExplorerNeedsLive({ ...demand, inspectedSceneId: 'unit-1', active: false })).toBe(false)
  expect(physicalExplorerNeedsLive({ ...demand, inspectedSceneId: 'unit-1', suspended: true })).toBe(false)
  expect(physicalExplorerNeedsLive({ ...demand, inspectedSceneId: 'unit-1', documentVisible: false })).toBe(false)
  expect(physicalExplorerNeedsLive({ ...demand, inspectedSceneId: 'unit-1', sourceLoaded: false })).toBe(false)
  expect(physicalExplorerNeedsLive({ ...demand, statusLayer: true })).toBe(true)
  expect(demand.statusLayer).toBe(false)
})

test('preparing another floor retains owner demand only for the same loaded and valid source', () => {
  const visible = { ...demand, statusLayer: true }
  expect(physicalExplorerNeedsLive(visible)).toBe(true)
  expect(physicalExplorerNeedsLive({ ...visible, representation: 'loading' })).toBe(true)
  expect(physicalExplorerNeedsLive(visible)).toBe(true)
  // Initial/replaced source loading has not passed the controller's retained
  // source/descriptor validation and cannot acquire from a guessed owner.
  expect(physicalExplorerNeedsLive({ ...visible, sourceLoaded: false, representation: 'loading' })).toBe(false)
  expect(physicalExplorerNeedsLive({ ...visible, locationValid: false, representation: 'loading' })).toBe(false)
  for (const representation of ['distant', 'hidden', 'unavailable'] as const) expect(physicalExplorerNeedsLive({ ...visible, representation })).toBe(false)
  for (const boundary of [{ active: false }, { documentVisible: false }, { suspended: true }]) expect(physicalExplorerNeedsLive({ ...visible, ...boundary, representation: 'loading' })).toBe(false)
})

test('every operational capture including an armed controller and panel target picking preempts both physical hosts', () => {
  const ordinary = { placement: false, targetPicking: false, controllerSelected: false }
  expect(physicalExplorerOperationalCapture(ordinary)).toBe(false)
  for (const capture of ['placement', 'targetPicking', 'controllerSelected'] as const) {
    const state = { ...ordinary, [capture]: true }
    expect(physicalExplorerOperationalCapture(state)).toBe(true)
    expect(physicalExplorerNeedsLive({ ...demand, inspectedSceneId: 'unit-1', suspended: physicalExplorerOperationalCapture(state) })).toBe(false)
  }
})

const view = { mode: '2d' as const, levelId: 'operating', cutaway: false, separation: 0, detail: 'auto' as const, live: true }
const fresh = { phase: 'live' as const, failure: null, stamp: { receivedWallMs: 10_000 }, latest: { sample: { at: { paused: false } }, subjects: [{}, {}, {}] } }
const paused = { ...fresh, latest: { ...fresh.latest, sample: { at: { paused: true } } } }
const collectionLine = { collection: ['ready', 'ready'] as const, focused: { status: 'ready' as const, view }, live: null, frozen: true, wallNowMs: 12_000, ownerAlerts: 0, layerPreparation: '', floors: 0, suspended: false, retry: false }
const focusedLine = { ...collectionLine, collection: null, live: fresh, frozen: false, ownerAlerts: 2, floors: 3 }

test('the status line is quiet only for the all-ready collection and the focused steady text', () => {
  expect(physicalExplorerStatusLine(collectionLine)).toEqual({ text: '2 layouts ready · 0 loading · 0 unavailable · owner-qualified alarms remain in Run', quiet: true })
  expect(physicalExplorerStatusLine(focusedLine)).toEqual({ text: 'Live · 3 modelled subjects · 2 owner alerts', quiet: true })
  expect(physicalExplorerStatusLine({ ...focusedLine, live: paused })).toEqual({ text: 'Paused · fresh · 3 modelled subjects · 2 owner alerts', quiet: true })
  // A steady 3D floor is as quiet as a Plan floor; only the whole stack carries a hint.
  expect(physicalExplorerStatusLine({ ...focusedLine, focused: { status: 'ready', view: { ...view, mode: '3d' } } }).quiet).toBe(true)
  expect(physicalExplorerStatusLine({ ...collectionLine, focused: { status: 'ready', view: { ...view, mode: '3d', levelId: 'all' } } }).quiet).toBe(true)
})

test('every other status text is shown', () => {
  const shown = (input: Parameters<typeof physicalExplorerStatusLine>[0], text: string): void => expect(physicalExplorerStatusLine(input)).toEqual({ text, quiet: false })
  for (const other of ['loading', 'unavailable', 'distant', 'hidden'] as const) expect(physicalExplorerStatusLine({ ...collectionLine, collection: ['ready', other] }).quiet).toBe(false)
  shown({ ...collectionLine, collection: ['ready', 'loading', 'unavailable', 'distant'] }, '1 layouts ready · 1 loading · 1 unavailable · owner-qualified alarms remain in Run')
  shown({ ...collectionLine, collection: [] }, '0 layouts ready · 0 loading · 0 unavailable · owner-qualified alarms remain in Run')
  shown({ ...focusedLine, focused: { status: 'loading', view } }, 'Loading this physical layout…')
  shown({ ...focusedLine, focused: { status: 'distant', view } }, 'Explore on map to load this physical layout')
  shown({ ...focusedLine, focused: { status: 'hidden', view } }, 'Physical detail hidden by view settings')
  shown({ ...focusedLine, focused: { status: 'unavailable', view } }, 'Layout unavailable')
  shown({ ...focusedLine, focused: { status: 'unavailable', reason: 'The source failed validation', view } }, 'The source failed validation')
  shown({ ...focusedLine, live: { ...fresh, phase: 'failed', failure: 'Layout live read failed' }, frozen: true }, 'Layout live read failed')
  shown({ ...focusedLine, live: { ...fresh, phase: 'connecting', failure: 'Run changed; confirming a fresh sample' }, frozen: true }, 'Run changed; confirming a fresh sample')
  shown({ ...focusedLine, live: { ...fresh, phase: 'inactive' }, frozen: true }, 'Run not loaded; layout is not live')
  shown({ ...focusedLine, live: { ...fresh, phase: 'missing' }, frozen: true }, 'Run missing')
  shown({ ...focusedLine, live: null, frozen: true }, 'Waiting for live owner status')
  shown({ ...focusedLine, live: { phase: 'connecting', failure: null, stamp: null, latest: null }, frozen: true }, 'Waiting for live owner status')
  shown({ ...focusedLine, frozen: true, wallNowMs: 19_900 }, 'Not live · live · last acquired 9 s ago')
  shown({ ...focusedLine, live: { ...fresh, phase: 'suspended' }, frozen: true, wallNowMs: 14_000 }, 'Not live · updates suspended · last acquired 4 s ago')
  shown({ ...focusedLine, live: { ...paused, phase: 'connecting' }, frozen: true }, 'Not live · connecting · last acquired 2 s ago')
})

test('a hint, a suspension or an offered Retry shows an otherwise quiet status line', () => {
  for (const steady of [collectionLine, focusedLine]) {
    const text = physicalExplorerStatusLine(steady).text
    expect(physicalExplorerStatusLine({ ...steady, layerPreparation: 'Preparing additional layers: Utility routes' })).toEqual({ text: `${text} · Preparing additional layers: Utility routes`, quiet: false })
    expect(physicalExplorerStatusLine({ ...steady, focused: { status: 'ready', view: { ...view, live: false } } })).toEqual({ text: `${text} · Status layer off`, quiet: false })
    expect(physicalExplorerStatusLine({ ...steady, suspended: true })).toEqual({ text: 'Inspection suspended while choosing an operational target.', quiet: false })
    expect(physicalExplorerStatusLine({ ...steady, retry: true })).toEqual({ text, quiet: false })
  }
  expect(physicalExplorerStatusLine({ ...focusedLine, focused: { status: 'ready', view: { ...view, mode: '3d', levelId: 'all' } } })).toEqual({ text: 'Live · 3 modelled subjects · 2 owner alerts · Choose a floor to inspect the interior.', quiet: false })
  expect(physicalExplorerStatusLine({ ...focusedLine, suspended: true, focused: { status: 'ready', view: { ...view, mode: '3d', levelId: 'all', live: false } } }).text).toBe('Inspection suspended while choosing an operational target. · Status layer off · Choose a floor to inspect the interior.')
})
