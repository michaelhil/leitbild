import { describe, expect, test } from 'bun:test'
import { parseDisplayFrameMessage, parseDisplayFramePresentation, type DisplayFrameMessage } from '../src/ui/embed/display-frame-protocol.ts'
import { createViewHost, visibleRoom, type ReceivedMessage } from '../src/ui/embed/view-host.ts'
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

  test('while a faceplate stands, the window gives the frame its body\'s whole height (W3.4)', () => {
    const short = { kind: 'advice' as const, zoom: 1, body: { width: 1200, height: 900 }, extent: { kind: 'advice' as const, minWidth: 360, width: 1200, height: 560 }, envelopeHeight: 560 }
    expect(displayFrameGeometry(short).frameHeight).toBe(560)
    expect(displayFrameGeometry({ ...short, fill: true }).frameHeight).toBe(900)
    expect(displayFrameGeometry({ ...short, fill: true, extent: { ...short.extent, height: 1400 } }).frameHeight).toBe(1400)
    expect(parseDisplayFrameMessage({ type: 'world:display-faceplate', open: true })).toEqual({ type: 'world:display-faceplate', open: true })
    expect(parseDisplayFrameMessage({ type: 'world:display-faceplate', open: 'yes' })).toBeNull()
  })

  test('the frame tells the window once each time a faceplate comes or goes', () => {
    const page = framed()
    page.fromParent({ type: 'world:display-frame', shown: true, zoom: 1 })
    page.posted.length = 0
    page.host.reportFaceplate(true)
    page.host.reportFaceplate(true)
    page.host.reportFaceplate(false)
    expect(page.posted).toEqual([{ type: 'world:display-faceplate', open: true }, { type: 'world:display-faceplate', open: false }])
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
