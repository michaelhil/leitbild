import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DisplayFrameMessage } from '../src/ui/embed/display-frame-protocol.ts'
import { createViewHost, escapeGoesBack, type ReceivedMessage } from '../src/ui/embed/view-host.ts'
import { MAGNIFIER, magnifierAt } from '../src/ui/embed/vignette/magnifier.ts'
import { onElementRequest, requestElement } from '../src/ui/embed/vignette/selection.ts'

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
    expect(source).toContain("if (opening !== 'window') { openFaceplate(item ?? `#${element}`); return }")
    expect(source).toContain('openElementDetail(embeddedDisplayFrame(), runId, from, section.objectId, element)')
  })

  test('a faceplate\'s own way to the window opens it from a chat answer or a tag\'s dialog too (relay), never a faceplate again', () => {
    // Its header link, "+N more in its detail" and its devices' links call ondetail: the element's default through
    // whatever opens displays here (openElementDetail: the window's own, or the relay), with no gate on the window.
    expect(source).toContain('ondetail={target => { if (overlay === null) closeFaceplate(false); void openDefault(target, null) }}')
    const openDefault = source.slice(source.indexOf('const openDefault = async'), source.indexOf('const openDetail = '))
    expect(openDefault).toContain('openElementDetail(embeddedDisplayFrame(), runId, from, section.objectId, element)')
    expect(openDefault).not.toContain('opening')
    // Where nothing opens it, the faceplate shows no such button: its header link is absent, "+N more" plain text.
    const faceplate = readFileSync(join(import.meta.dir, '../src/ui/embed/vignette/Faceplate.svelte'), 'utf8')
    expect(faceplate).toContain("{#if offer !== 'nothing'}")
    expect(faceplate).toContain("{#if offer === 'nothing'}<p class=\"more\">+{fit.more} more in its detail</p>")
  })

  test('Shift+Enter on an item opens its faceplate; Enter and Space its detail', () => {
    expect(source).toContain("if (event.key === 'Enter' && event.shiftKey) { event.preventDefault(); if (texts.get(id)?.kind !== 'stop') openFaceplate(id); return }")
  })

  test('with a mouse the magnifier shows on hover and keyboard focus; at rest only on touch and where a proposal waits', () => {
    expect(source).toContain('const shown = (id: string): boolean => hovered === id || focused === id || faceplated(id) || pendingOf(id) !== undefined')
    expect(source).toContain("onfocus: (event: FocusEvent) => { if ((event.currentTarget as Element).matches(':focus-visible')) focused = id }")
    expect(source).toContain('@media (pointer: coarse) { .magnifier { opacity: 1; } }')
    expect(source).not.toContain('operated')
  })

  test('each magnifier is rendered straight after its item, the items in reading order, so Tab walks the drawing as it reads (W8.3)', () => {
    expect(source.match(/\{@render magnifier\([a-z.]+\)\}/g)).toEqual(['{@render magnifier(entry.id)}'])
    expect(source).toContain('{#each ordered as entry (entry.id)}')
    expect(source).toContain('].sort((left, right) => Math.round(left.y / VIGNETTE_ROW_PX) - Math.round(right.y / VIGNETTE_ROW_PX) || left.x - right.x))')
  })

  test('on a touch screen an area\'s and a magnifier\'s press targets reach 40 px on screen, whatever the drawing\'s scale (W8.3)', () => {
    expect(source).toContain('style:--unscale={1 / scale}')
    expect(source).toContain(".area::before, .magnifier::before { content: ''; position: absolute; left: 50%; top: 50%; width: max(100%, calc(40px * var(--unscale))); height: max(100%, calc(40px * var(--unscale)));")
  })

  test('every named item that opens something is a button, its text part of it; a refused default stays plain (W6.1)', () => {
    // What a press opens is the drawing's (contract 3, flow-symbols FlowItem.targets); none, and the item is no button.
    expect(source).toContain("const body = (id: string, title: string): Record<string, unknown> => !opens(id) ? {} : {")
    expect(source).toContain("onclick={opens(text.id) ? () => bodyPress(text.id) : undefined}")
    // A line's, a bar's or a stop's box is its button; a stop has no magnifier; several targets open a chooser.
    expect(source).toContain('...drawing.texts.filter(text => opens(text.id) && !symbols.has(text.id)).map(item => ({ kind: \'area\' as const')
    expect(source).toContain("!opens(text.id) || text.kind === 'stop' ? []")
    expect(source).toContain('else if (targets.length > 1) openChooser(id)')
  })
})

describe('a request to show an element (selection.ts, contract 1)', () => {
  test('a drawing that draws the element answers, and shows it; none answers for one no drawing draws', () => {
    const shown: string[] = []
    const stop = onElementRequest(request => {
      if (request.objectId !== 'plant:a' || request.elementId !== 'sgA') return false
      shown.push(request.how)
      return true
    })
    expect(requestElement({ objectId: 'plant:a', elementId: 'sgA', how: 'select' })).toBe(true)
    expect(requestElement({ objectId: 'plant:a', elementId: 'sgA', how: 'detail' })).toBe(true)
    expect(requestElement({ objectId: 'plant:a', elementId: 'rcpA', how: 'select' })).toBe(false)
    stop()
    expect(requestElement({ objectId: 'plant:a', elementId: 'sgA', how: 'select' })).toBe(false)
    expect(shown).toEqual(['select', 'detail'])
  })

  test('the flow drawing listens while mounted: a select opens the item\'s faceplate, a detail its default', () => {
    const source = readFileSync(join(import.meta.dir, '../src/ui/embed/vignette/FlowTopology.svelte'), 'utf8')
    expect(source).toContain('const stopRequests = onElementRequest(request => {')
    expect(source).toContain("if (request.how === 'detail') openDetail(request.elementId, id)")
    expect(source).toContain('stopRequests()')
  })
})


describe('the network drawing\'s grammar (W9.1: grid elements open content, T6, T10)', () => {
  const source = readFileSync(join(import.meta.dir, '../src/ui/embed/vignette/NetworkTopology.svelte'), 'utf8')

  test('an item bound to what it measures is a button opening its element\'s default; a stop its far ends, several a chooser', () => {
    // Its default leads with what the item is bound to (defaults.ts elementPlan): unbound, it would open an empty one.
    expect(source).toContain('return node?.element === undefined || node.bindings.length === 0 ? [] : [{ element: node.element, name: node.label }]')
    expect(source).toContain('if (node?.stop !== undefined) return node.stop.far.flatMap(end => end.element === undefined ? [] : [{ element: end.element, name: end.label }])')
    expect(source).toContain("void opening?.element(section.objectId, element, 'detail')")
    expect(source).toContain('if (targets.length === 1) open(targets[0]!.element, targets[0]!.name)')
    expect(source).toContain('<Chooser name={named.get(id) ?? id} entries={targetsOf(id)}')
    expect(source).toContain('role="group" aria-label="Network topology"')
  })

  test('nothing is a button where no page can open a display', () => {
    expect(source).toContain('const items = $derived(opening === undefined || opening.where === null ? [] :')
  })

  test('the symbols\' own OpenBridge buttons are no tab stops in either drawing: their wrappers are inert (W8.3)', () => {
    const flow = readFileSync(join(import.meta.dir, '../src/ui/embed/vignette/FlowTopology.svelte'), 'utf8')
    expect(flow).toContain('<div class="point" inert><obc-automation-button')
    expect(source).toContain('<div class="placed" inert style:left={`${device.x}px`}')
    // Its items in reading order too.
    expect(source).toContain('}).sort((left, right) => Math.round(left.y / VIGNETTE_ROW_PX) - Math.round(right.y / VIGNETTE_ROW_PX) || left.x - right.x))')
  })
})
