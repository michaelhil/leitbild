import { describe, expect, test } from 'bun:test'
import { closeEmbeddedViewOnEscape } from '../src/ui/embedded-view-keyboard.ts'

const key = (value = 'Escape', composing = false) => Object.assign(new Event('keydown', { cancelable: true }), { key: value, isComposing: composing })
// Native EventTarget has no document tree. Keep real cancellation/abort behavior
// while giving an owner handler the DOM's interval between capture and bubble.
class ChildWindow extends EventTarget {
  private readonly capture = new EventTarget()
  beforeBubble: () => void = () => {}
  override addEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: AddEventListenerOptions | boolean): void {
    const capture = typeof options === 'boolean' ? options : options?.capture
    if (capture) this.capture.addEventListener(type, listener, options)
    else super.addEventListener(type, listener, options)
  }
  override dispatchEvent(event: Event): boolean {
    this.capture.dispatchEvent(event)
    this.beforeBubble()
    return super.dispatchEvent(event)
  }
}
const owner = () => {
  const window = new ChildWindow()
  let modal = false
  const document = { querySelector: (selector: string) => selector === 'dialog:modal' && modal ? {} : null }
  return { window, document, showModal: (shown: boolean) => { modal = shown } }
}
class Frame extends EventTarget {
  contentWindow: EventTarget | null = null
  contentDocument: ReturnType<typeof owner>['document'] | null = null
  navigate(next: ReturnType<typeof owner> | null, load = true) {
    this.contentWindow = next?.window ?? null
    this.contentDocument = next?.document ?? null
    if (load) this.dispatchEvent(new Event('load'))
  }
}
const attach = (frame: Frame, close: () => void) => closeEmbeddedViewOnEscape(frame as unknown as HTMLIFrameElement, close)

describe('owner iframe Escape', () => {
  test('unhandled Escape closes its Host display and consumes the key, without consuming ordinary or composing keys', () => {
    const frame = new Frame(), child = owner()
    frame.navigate(child)
    let closes = 0
    const bridge = attach(frame, () => { closes += 1 })
    const ordinary = key('Enter'), composing = key('Escape', true)
    child.window.dispatchEvent(ordinary)
    child.window.dispatchEvent(composing)
    expect(closes).toBe(0)
    expect(ordinary.defaultPrevented).toBe(false)
    expect(composing.defaultPrevented).toBe(false)
    const escape = key()
    child.window.dispatchEvent(escape)
    expect(closes).toBe(1)
    expect(escape.defaultPrevented).toBe(true)
    bridge.destroy()
  })

  test('the owner keeps an already-handled Escape and the Escape of its own native modal', () => {
    const frame = new Frame(), child = owner()
    frame.navigate(child)
    let closes = 0
    const bridge = attach(frame, () => { closes += 1 })
    const handled = key()
    handled.preventDefault()
    child.window.dispatchEvent(handled)
    child.showModal(true)
    const nestedModal = key()
    child.window.dispatchEvent(nestedModal)
    expect(closes).toBe(0)
    expect(nestedModal.defaultPrevented).toBe(false)
    child.showModal(false)
    child.window.dispatchEvent(key())
    expect(closes).toBe(1)
    bridge.destroy()
  })

  test('an owner dialog that closes during its Escape does not also close the Host display', () => {
    const frame = new Frame(), child = owner()
    frame.navigate(child)
    let closes = 0
    const bridge = attach(frame, () => { closes += 1 })
    child.showModal(true)
    child.window.beforeBubble = () => { child.showModal(false) }
    const escape = key()
    child.window.dispatchEvent(escape)
    expect(closes).toBe(0)
    expect(escape.defaultPrevented).toBe(false)
    child.window.dispatchEvent(key())
    expect(closes).toBe(1)
    bridge.destroy()
  })

  test('navigation removes the old listener, ignores a document replaced before load, and listens once to the new document', () => {
    const frame = new Frame(), first = owner(), second = owner()
    frame.navigate(first)
    let closes = 0
    const bridge = attach(frame, () => { closes += 1 })
    frame.navigate(second, false)
    first.window.dispatchEvent(key())
    expect(closes).toBe(0)
    frame.dispatchEvent(new Event('load'))
    frame.dispatchEvent(new Event('load'))
    first.window.dispatchEvent(key())
    second.window.dispatchEvent(key())
    expect(closes).toBe(1)
    frame.navigate(null)
    second.window.dispatchEvent(key())
    expect(closes).toBe(1)
    bridge.destroy()
  })

  test('removing an old iframe stops its keys and loads from closing a replacement display', () => {
    const oldFrame = new Frame(), oldOwner = owner()
    oldFrame.navigate(oldOwner)
    let closes = 0
    const oldBridge = attach(oldFrame, () => { closes += 1 })
    oldBridge.destroy()
    const replacement = new Frame(), nextOwner = owner()
    replacement.navigate(nextOwner)
    const nextBridge = attach(replacement, () => { closes += 1 })
    oldOwner.window.dispatchEvent(key())
    oldFrame.dispatchEvent(new Event('load'))
    oldOwner.window.dispatchEvent(key())
    expect(closes).toBe(0)
    nextOwner.window.dispatchEvent(key())
    expect(closes).toBe(1)
    nextBridge.destroy()
    nextOwner.window.dispatchEvent(key())
    expect(closes).toBe(1)
  })
})
