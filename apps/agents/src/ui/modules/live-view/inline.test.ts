import { afterEach, describe, expect, test } from 'bun:test'
import type { EmbeddedViewEnvelope } from '@leitbild/contracts'
import { fitInline, hideInline, showInline } from './inline.ts'

// The inline frame fits what its display shows (W7.3): a drawing too wide for a 480 px chat gave way to "View
// drawing ›", the display says its content takes 384 px of the 624 it was published with, and the frame and its slot
// take 384, with no empty band under it. A page with only the parts inline.ts touches.

const envelope = {
  moduleId: 'world', viewType: 'display.vignette', title: 'Unit 1 · AFW valve A', height: 624, state: '{"views":[]}',
  subject: { workspaceId: '61ae04b5-ce61-40d6-b7d3-44c0bdf30753', moduleId: 'world', type: 'world.simulation-run', id: 'run-1' },
} as unknown as EmbeddedViewEnvelope

type Style = { cssText: string; height: string }
const frames: Array<{ readonly style: Style; readonly contentWindow: object }> = []
const visibility: Array<(entries: ReadonlyArray<{ readonly isIntersecting: boolean }>) => void> = []
const saved = { document: globalThis.document, IntersectionObserver: globalThis.IntersectionObserver }

const page = (): void => {
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      createElement: () => {
        const frame = { style: { cssText: '', height: '' } as Style, contentWindow: { frame: frames.length }, title: '', src: '', setAttribute: () => {}, addEventListener: () => {}, remove: () => {} }
        frames.push(frame)
        return frame
      },
    },
  })
  Object.defineProperty(globalThis, 'IntersectionObserver', {
    configurable: true,
    value: class { constructor(report: (entries: ReadonlyArray<{ readonly isIntersecting: boolean }>) => void) { visibility.push(report) } observe(): void {} disconnect(): void {} },
  })
}

afterEach(() => {
  Object.defineProperty(globalThis, 'document', { configurable: true, value: saved.document })
  Object.defineProperty(globalThis, 'IntersectionObserver', { configurable: true, value: saved.IntersectionObserver })
  frames.length = 0
  visibility.length = 0
})

describe('an inline display in an answer', () => {
  test('its frame and slot fit what it shows once it says so: no empty band under a drawing that gave way to a link', () => {
    page()
    const slot = { style: { height: '' }, isConnected: true, replaceChildren: () => {} } as unknown as HTMLElement
    showInline(slot, envelope)
    expect(slot.style.height).toBe('624px')
    visibility[0]!([{ isIntersecting: true }])
    const frame = frames[0]!
    expect(frame.style.cssText).toContain('height:624px')

    fitInline(frame.contentWindow, 384)
    expect(slot.style.height).toBe('384px')
    expect(frame.style.height).toBe('384px')
    // A message from a frame this page did not make changes nothing.
    fitInline({ frame: 'another' }, 120)
    expect(slot.style.height).toBe('384px')

    hideInline(slot)
    expect(slot.style.height).toBe('')
  })
})
