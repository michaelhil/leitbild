import { expect, test } from 'bun:test'
import type { Map as MapLibreMap } from 'maplibre-gl'
import { createMapPhysicalViewport } from '../src/ui/map/physical-scene/map-viewport.ts'

/** Public camera/event double; no renderer, private transform or GL substitute. */
const harness = () => {
  const canvas = Object.assign(new EventTarget(), { hasPointerCapture: () => false })
  let min = 5, max = 70, pitch = 20
  const map = {
    getCanvas: () => canvas, on() {}, off() {}, stop() {}, getPitch: () => pitch,
    getMinPitch: () => min, getMaxPitch: () => max,
    setMinPitch(value: number) { if (value > max) throw Error('Invalid camera interval'); min = value; pitch = Math.max(min, Math.min(pitch, max)); return this },
    setMaxPitch(value: number) { if (value < min) throw Error('Invalid camera interval'); max = value; pitch = Math.max(min, Math.min(pitch, max)); return this },
    jumpTo(value: { pitch?: number }) { if (value.pitch !== undefined) pitch = Math.max(min, Math.min(value.pitch, max)); return this },
  }
  const port = createMapPhysicalViewport(map as unknown as MapLibreMap, () => undefined)
  return { map, port, interval: () => [min, max, pitch] }
}

test('an actual Plan leases a flat native interval and restores bounds on representation change, suspension and disposal', () => {
  const h = harness(); expect(h.interval()).toEqual([5, 70, 20])
  h.port.setPlanarInspection!(true); expect(h.interval()).toEqual([0, 0, 0])
  h.map.jumpTo({ pitch: 40 }); expect(h.interval()).toEqual([0, 0, 0])
  h.port.setActive!(false); expect(h.interval()).toEqual([5, 70, 5])
  h.port.setActive!(true); expect(h.interval()).toEqual([0, 0, 0])
  h.port.setPlanarInspection!(false); expect(h.interval()).toEqual([5, 70, 5])
  h.port.setPlanarInspection!(true); h.port.destroy(); expect(h.interval()).toEqual([5, 70, 5])
})

test('an operational camera that replaces a pitch bound keeps its newer valid bound', () => {
  const h = harness(); h.port.setPlanarInspection!(true)
  h.map.setMaxPitch(40); h.port.setPlanarInspection!(false)
  expect(h.interval()).toEqual([5, 40, 5]); h.port.destroy()
})
