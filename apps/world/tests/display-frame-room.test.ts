import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseDisplayFrameMessage, parseDisplayFramePresentation, type DisplayFrameMessage } from '../src/ui/embed/display-frame-protocol.ts'
import { createViewHost, visibleRoom, type ReceivedMessage } from '../src/ui/embed/view-host.ts'
import { fillsWindow } from '../src/ui/embed/vignette/grid.ts'
import { displayFrameGeometry } from '../src/ui/process-display/display-zoom.ts'

// The room a display's faceplate has (plan v5 W3.3, W3.4; the R1 spike's must-fix 1 and 2): the window tells each
// frame which part of it a person sees, clear of its own resize handles, and gives it the body's whole height while a
// faceplate stands on it.

const origin = 'https://leitbild.test'
const framed = () => {
  const posted: DisplayFrameMessage[] = []
  const parent = { postMessage: (message: unknown) => { posted.push(message as DisplayFrameMessage) } }
  let receive: ((message: ReceivedMessage) => void) | null = null
  const host = createViewHost({ parent, origin, listen: next => { receive = next; return () => {} }, refused: () => {} })
  host.listen()
  posted.length = 0
  return { host, posted, fromParent: (data: unknown) => receive!({ origin, source: parent, data }) }
}

describe('the part of a display a person sees', () => {
  test('the window says what a person sees, clear of its resize handles; without a window it is the page', () => {
    expect(parseDisplayFramePresentation({ type: 'world:display-frame', shown: true, zoom: 1, visible: { x: 18, y: 0, width: 1010, height: 864 } })?.visible).toEqual({ x: 18, y: 0, width: 1010, height: 864 })
    expect(parseDisplayFramePresentation({ type: 'world:display-frame', shown: true, zoom: 1, visible: { x: 0, y: 0, width: -1, height: 2 } })).toBeNull()
    expect(parseDisplayFramePresentation({ type: 'world:display-frame', shown: true, zoom: 1, back: 'Halden Unit 1', visible: { x: 0, y: 0, width: 1, height: 2 }, extra: 1 })).toBeNull()
    expect(visibleRoom({ shown: true, zoom: 1 }, { width: 1046, height: 900 })).toEqual({ x: 0, y: 0, width: 1046, height: 900 })
  })

  test('while the display asks for it (a faceplate stands, W3.4; alerts only, W2.5), the window gives the frame its body\'s whole height', () => {
    const short = { kind: 'advice' as const, zoom: 1, body: { width: 1200, height: 900 }, extent: { kind: 'advice' as const, minWidth: 360, width: 1200, height: 560 }, envelopeHeight: 560 }
    expect(displayFrameGeometry(short).frameHeight).toBe(560)
    expect(displayFrameGeometry({ ...short, fill: true }).frameHeight).toBe(900)
    expect(displayFrameGeometry({ ...short, fill: true, extent: { ...short.extent, height: 1400 } }).frameHeight).toBe(1400)
    expect(parseDisplayFrameMessage({ type: 'world:display-fill', fill: true })).toEqual({ type: 'world:display-fill', fill: true })
    expect(parseDisplayFrameMessage({ type: 'world:display-fill', fill: 'yes' })).toBeNull()
  })

  test('the frame asks while any part of it does, and tells the window once each time that changes', () => {
    const page = framed()
    page.fromParent({ type: 'world:display-frame', shown: true, zoom: 1 })
    page.posted.length = 0
    page.host.reportFill('faceplates:a', true)
    page.host.reportFill('alerts', true)
    page.host.reportFill('faceplates:a', false)
    page.host.reportFill('alerts', false)
    expect(page.posted).toEqual([{ type: 'world:display-fill', fill: true }, { type: 'world:display-fill', fill: false }])
  })

  test('an alerts-only display asks before its window presents it: it is told once the window does', () => {
    const page = framed()
    page.host.reportFill('alerts', true)
    expect(page.posted).toEqual([])
    page.fromParent({ type: 'world:display-frame', shown: true, zoom: 1 })
    expect(page.posted).toEqual([{ type: 'world:display-fill', fill: true }])
  })

  test('alerts only fill a display window; in chat or a dialog they keep their composed rows (W2.5)', () => {
    expect(fillsWindow({ sections: [{ kind: 'alerts' }] })).toBe(true)
    expect(fillsWindow({ sections: [{ kind: 'alerts' }, { kind: 'alerts' }] })).toBe(true)
    expect(fillsWindow({ sections: [{ kind: 'alerts' }, { kind: 'values' }] })).toBe(false)
    expect(fillsWindow({ sections: [] })).toBe(false)
    const vignette = readFileSync(join(import.meta.dir, '../src/ui/embed/vignette/Vignette.svelte'), 'utf8')
    // On a dashboard (R4 B4) a section neither fills nor asks: its dashboard hosts the page.
    expect(vignette).toContain("const fills = $derived(board === undefined && opening.where === 'window' && view !== undefined && fillsWindow(view))")
    expect(vignette).toContain("embeddedDisplayFrame().reportFill('alerts', fillsWindow(next.view))")
    expect(vignette).toContain('<Sections {view} {snapshot} {palette} {frozen} {runId} {from} {fills} frame={board?.frame === true} />')
    // It fills the part of the frame a person sees, which follows the window's body: never its own height, which the
    // window's frame height (at least the content's) would feed back so the frame could never shrink. It is that tall,
    // no taller, so the full alerts view's list scrolls in it and the window does not zoom it out.
    expect(vignette).toContain('room = next.visible?.height ?? null; zoom = next.zoom')
    expect(vignette).toContain('style:height={fills && room !== null ? `${room}px` : undefined}')
    expect(vignette).toContain('.vignette.fill > :global(.sections) { grid-row: 4; min-height: 0; }')
    const fillRules = [...vignette.matchAll(/\.vignette\.fill[^{}]*\{([^}]*)\}/g)].map(match => match[1]!)
    expect(fillRules.length).toBeGreaterThan(0)
    // The alert article must follow the host-supplied visible room, not the
    // iframe's own viewport or percentage height. A separate chat preview
    // wrapper may use the viewport to provide its single native scroller.
    expect(fillRules.join('\n')).not.toMatch(/(?:min-|max-)?height\s*:\s*[^;}]*(?:\d+(?:d|s|l)?vh\b|100%)/)
    const sections = readFileSync(join(import.meta.dir, '../src/ui/embed/vignette/Sections.svelte'), 'utf8')
    expect(sections).toContain("style:min-height={rows !== null && fills ? `${rows * VIGNETTE_ROW_PX}px` : undefined}")
    expect(sections).toContain("section.family === 'flow' && opening?.where === 'window'")
  })

  test('an optional inline preview owns one keyboard-reachable scroller outside the intrinsic article', () => {
    const vignette = readFileSync(join(import.meta.dir, '../src/ui/embed/vignette/Vignette.svelte'), 'utf8')
    expect(vignette).toContain("const preview = $derived(board === undefined && opening.where !== 'window')")
    expect(vignette).toContain("<div class:preview tabindex={preview ? 0 : undefined} role={preview ? 'region' : undefined} aria-label={preview ? 'Scrollable live display preview' : undefined}>")
    const previewRule = vignette.match(/\.preview\s*\{([^}]*)\}/)?.[1]
    expect(previewRule).toContain('max-height: 100vh')
    expect(previewRule).toContain('overflow-y: auto')
    const articleRule = vignette.match(/\.vignette\s*\{([^}]*)\}/)?.[1]
    expect(articleRule).toBeDefined()
    expect(articleRule).not.toContain('overflow-y: auto')
    expect(articleRule).not.toMatch(/(?:min-|max-)?height\s*:/)
  })

  test('a frame hears what a person sees with its presentation, and only a change of it is news', () => {
    const page = framed()
    const seen: Array<unknown> = []
    page.host.subscribe(presentation => { seen.push(presentation.visible) })
    page.fromParent({ type: 'world:display-frame', shown: true, zoom: 1, visible: { x: 0, y: 120, width: 1010, height: 700 } })
    page.fromParent({ type: 'world:display-frame', shown: true, zoom: 1, visible: { x: 0, y: 120, width: 1010, height: 700 } })
    page.fromParent({ type: 'world:display-frame', shown: true, zoom: 1, visible: { x: 0, y: 240, width: 1010, height: 700 } })
    expect(seen).toEqual([undefined, { x: 0, y: 120, width: 1010, height: 700 }, { x: 0, y: 240, width: 1010, height: 700 }])
  })
})
