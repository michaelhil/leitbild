import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DisplayFrameMessage } from '../src/ui/embed/display-frame-protocol.ts'
import { createViewHost, escapeGoesBack, type ReceivedMessage } from '../src/ui/embed/view-host.ts'
import { MAGNIFIER, magnifierAt } from '../src/ui/embed/vignette/magnifier.ts'

// Option A (plan v5 §3, owner ruling D-A): a press on an item's body opens its detail (L3) as the next display, Back
// and Esc return; OpenBridge's 16 px magnifier after the item's name opens its faceplate (L2), with a 40 px hit area
// under the body's ink, never a reserved cell.

describe('the magnifier stands after the item\'s name, in its first line', () => {
  const drawing = { width: 1488, height: 864 }

  test('4 px after the name, centred on the line, its 40 px square round the glyph', () => {
    const place = magnifierAt({ x: 100, y: 200, width: 96 }, 16, 40, drawing)
    expect(place.glyph).toEqual({ x: 100 + 40 + MAGNIFIER.gap, y: 200 })
    expect(place.hit).toEqual({ x: 144 + 8 - 20, y: 208 - 20 })
    expect(place.fits).toBe(true)
  })

  test('a name that leaves no room for it still gets it, said so (no cell is reserved)', () => {
    expect(magnifierAt({ x: 100, y: 200, width: 50 }, 16, 40, drawing).fits).toBe(false)
  })

  test('never closer than 4 px to the drawing\'s right edge, and its hit area never widens the drawing', () => {
    const place = magnifierAt({ x: 1400, y: 0, width: 96 }, 16, 90, drawing)
    expect(place.glyph.x + MAGNIFIER.glyph).toBe(drawing.width - MAGNIFIER.edge)
    expect(place.hit.x + MAGNIFIER.hit).toBeLessThanOrEqual(drawing.width)
    expect(place.hit.y).toBe(0)
  })
})

describe('Esc is the display\'s Back', () => {
  const origin = 'https://leitbild.test'
  const presented = (back?: string) => {
    const posted: DisplayFrameMessage[] = []
    const parent = { postMessage: (message: unknown) => { posted.push(message as DisplayFrameMessage) } }
    let receive: ((message: ReceivedMessage) => void) | null = null
    const host = createViewHost({ parent, origin, listen: next => { receive = next; return () => {} }, refused: () => {} })
    host.listen()
    receive!({ origin, source: parent, data: { type: 'world:display-frame', shown: true, zoom: 1, ...(back === undefined ? {} : { back }) } })
    posted.length = 0
    return { host, posted }
  }
  const target = () => {
    const listeners = new Set<(event: Event) => void>()
    return {
      addEventListener: (_type: string, listener: (event: Event) => void) => { listeners.add(listener) },
      removeEventListener: (_type: string, listener: (event: Event) => void) => { listeners.delete(listener) },
      press: (key: string, defaultPrevented = false) => { for (const listener of listeners) listener({ key, defaultPrevented } as unknown as Event) },
      listening: () => listeners.size,
    }
  }

  test('once nothing inside the display claimed it, Esc returns to the display it was opened from', () => {
    const { host, posted } = presented('Halden Unit 1')
    const keys = target()
    const stop = escapeGoesBack(host, keys as unknown as Window)
    keys.press('Escape')
    expect(posted).toEqual([{ type: 'world:display-back' }])
    // A faceplate, a selected command or a menu took it first (and cancelled it): no Back.
    keys.press('Escape', true)
    keys.press('Enter')
    expect(posted).toHaveLength(1)
    stop()
    expect(keys.listening()).toBe(0)
  })

  test('a display opened from none has no Back to step to', () => {
    const { host, posted } = presented()
    const keys = target()
    escapeGoesBack(host, keys as unknown as Window)
    keys.press('Escape')
    expect(posted).toEqual([])
  })
})

describe('the drawing\'s grammar', () => {
  const source = readFileSync(join(import.meta.dir, '../src/ui/embed/vignette/FlowTopology.svelte'), 'utf8')

  test('a body press opens the detail, in the window only; elsewhere the faceplate', () => {
    expect(source).toContain("if (opening !== 'window') { openFaceplate(id); return }")
    expect(source).toContain('openElementDetail(embeddedDisplayFrame(), runId, from, section.objectId')
  })

  test('Shift+Enter on an item opens its faceplate; Enter and Space its detail', () => {
    expect(source).toContain("if (event.key === 'Enter' && event.shiftKey) { event.preventDefault(); openFaceplate(id); return }")
  })

  test('each magnifier is rendered straight after its item, so it follows the item in tab order', () => {
    expect(source.match(/\{@render magnifier\((item|device)\.id\)\}/g)).toHaveLength(2)
  })
})
