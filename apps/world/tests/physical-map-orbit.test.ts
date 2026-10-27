import { expect, test } from 'bun:test'
import type { Map as MapLibreMap, MapMouseEvent } from 'maplibre-gl'
import { createMapPhysicalViewport } from '../src/ui/map/physical-scene/map-viewport.ts'
import { createMapPickingDemand } from '../src/ui/map-runtime/picking-demand.ts'

/** Explicit DOM/map doubles: exercise gesture ownership before map-click activation. */
const harness = () => {
  const listeners = new Map<string, Set<(event: any) => void>>(), captures = new Set<number>()
  const canvas = Object.assign(new EventTarget(), { getBoundingClientRect: () => ({ width: 800, height: 600 }), setPointerCapture: (id: number) => captures.add(id), hasPointerCapture: (id: number) => captures.has(id), releasePointerCapture: (id: number) => captures.delete(id) })
  let jumps = 0, bearing = 0, pitch = 50, nativeHandlerChanges = 0, picking = true, acquisitions = 0, releases = 0
  const demand = createMapPickingDemand(true, value => { picking = value }), jumpedPicking: boolean[] = []
  const map = { getCanvas: () => canvas, on(type: string, listener: (event: any) => void) { const set = listeners.get(type) ?? new Set(); set.add(listener); listeners.set(type, set) }, off(type: string, listener: (event: any) => void) { listeners.get(type)?.delete(listener) }, getBearing: () => bearing, getPitch: () => pitch, getMaxPitch: () => 85,
    jumpTo(options: { bearing: number; pitch: number }) { jumps++; bearing = options.bearing; pitch = options.pitch; jumpedPicking.push(picking) }, stop() {}, dragPan: { enable() { nativeHandlerChanges++ }, disable() { nativeHandlerChanges++ } } }
  const port = createMapPhysicalViewport(map as unknown as MapLibreMap, () => undefined, () => { acquisitions++; const release = demand.suspend(); return () => { releases++; release() } })
  let clicks = 0; canvas.addEventListener('click', () => { clicks++ })
  const pointer = (type: string, x: number, y = 100, button = 0) => { const event = Object.assign(new Event(type, { cancelable: true }), { clientX: x, clientY: y, button, pointerId: 1, pointerType: 'mouse' }); canvas.dispatchEvent(event); return event }
  const mouseDown = (button = 0) => { let prevented = false; const event = { originalEvent: { button }, get defaultPrevented() { return prevented }, preventDefault() { prevented = true } } as MapMouseEvent; for (const listener of listeners.get('mousedown') ?? []) listener(event); return prevented }
  const click = () => { const event = Object.assign(new Event('click', { cancelable: true }), { detail: 1, pointerId: 1 }); canvas.dispatchEvent(event); return event.defaultPrevented }
  return { port, pointer, mouseDown, click, clicks: () => clicks, jumps: () => jumps, nativeHandlerChanges: () => nativeHandlerChanges, captures,
    picking: () => picking, acquisitions: () => acquisitions, releases: () => releases, jumpedPicking, emit: (type: string) => { for (const listener of listeners.get(type) ?? []) listener({}) } }
}

test('closed-loop Orbit consumes its resulting click, while a true Orbit click remains an activation', () => {
  const h = harness(); h.port.setNavigationTool('orbit')
  expect(h.pointer('pointerdown', 100).defaultPrevented).toBe(false); expect(h.mouseDown()).toBe(true)
  expect(h.picking()).toBe(true); expect(h.acquisitions()).toBe(0)
  h.pointer('pointermove', 160); h.pointer('pointermove', 100); h.pointer('pointerup', 100)
  expect(h.jumps()).toBe(2); expect(h.click()).toBe(true); expect(h.clicks()).toBe(0)
  expect(h.jumpedPicking).toEqual([false, false]); expect(h.picking()).toBe(true); expect(h.acquisitions()).toBe(1); expect(h.releases()).toBe(1)
  h.pointer('pointerdown', 200); expect(h.mouseDown()).toBe(true); h.pointer('pointermove', 201); h.pointer('pointerup', 200)
  expect(h.click()).toBe(false); expect(h.clicks()).toBe(1); expect(h.jumps()).toBe(2); expect(h.nativeHandlerChanges()).toBe(0)
  expect(h.acquisitions()).toBe(1)
  h.port.destroy(); expect(h.captures.size).toBe(0)
})

test('Pan and secondary-button gestures remain native; cancellation cannot turn an old Orbit release into a capture click', () => {
  const h = harness(); h.port.setNavigationTool('pan'); h.pointer('pointerdown', 100); expect(h.mouseDown()).toBe(false); h.pointer('pointerup', 100); expect(h.click()).toBe(false)
  h.port.setNavigationTool('orbit'); h.pointer('pointerdown', 100, 100, 2); expect(h.mouseDown(2)).toBe(false); h.pointer('pointerup', 100, 100, 2)
  h.pointer('pointerdown', 100); h.mouseDown(); h.pointer('pointermove', 120); const before = h.jumps(); h.port.cancelCamera(); h.port.setNavigationTool('pan')
  h.pointer('pointermove', 150); expect(h.jumps()).toBe(before); h.pointer('pointerup', 100); expect(h.click()).toBe(true)
  h.pointer('pointerdown', 300); expect(h.mouseDown()).toBe(false); h.pointer('pointerup', 300); expect(h.click()).toBe(false); expect(h.clicks()).toBe(2)
  h.port.destroy(); expect(h.nativeHandlerChanges()).toBe(0)
})

test('every navigation terminal releases picking before further activation', () => {
  for (const terminal of ['pointerup', 'pointercancel', 'lostpointercapture', 'blur', 'cancel', 'tool', 'inactive', 'style', 'context', 'destroy']) {
    const h = harness(); h.port.setNavigationTool('orbit'); h.pointer('pointerdown', 100); h.mouseDown(); h.pointer('pointermove', 140)
    expect(h.picking(), terminal).toBe(false); expect(h.acquisitions(), terminal).toBe(1)
    if (terminal === 'cancel') h.port.cancelCamera()
    else if (terminal === 'tool') h.port.setNavigationTool('pan')
    else if (terminal === 'inactive') h.port.setActive?.(false)
    else if (terminal === 'style') h.emit('style.load')
    else if (terminal === 'context') h.pointer('webglcontextlost', 140)
    else if (terminal === 'destroy') h.port.destroy()
    else { if (terminal === 'lostpointercapture') h.captures.delete(1); h.pointer(terminal, 140) }
    expect(h.picking(), terminal).toBe(true); expect(h.releases(), terminal).toBe(1)
    h.port.cancelCamera(); h.port.destroy(); expect(h.releases(), terminal).toBe(1)
  }
})

test('inactive/capture surfaces cannot acquire a new navigation picking lease', () => {
  const h = harness(); h.port.setNavigationTool('orbit'); h.port.setActive?.(false)
  h.pointer('pointerdown', 100); expect(h.mouseDown()).toBe(false); h.pointer('pointermove', 140); h.pointer('pointerup', 140)
  expect(h.acquisitions()).toBe(0); expect(h.picking()).toBe(true); expect(h.jumps()).toBe(0)
  h.port.destroy()
})
