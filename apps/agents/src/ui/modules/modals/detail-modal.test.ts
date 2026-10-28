import { expect, test } from 'bun:test'
import { createModal } from './detail-modal.ts'

// Lifecycle-only DOM double: layout, focus traversal and rendering are checked
// in the actual browser. This isolates external listeners/observers on close.
const fixture = () => {
  const original = { document: globalThis.document, HTMLElement: globalThis.HTMLElement, ResizeObserver: globalThis.ResizeObserver, MutationObserver: globalThis.MutationObserver }
  const listeners = new Set<(event: KeyboardEvent) => void>(), nodes: Array<{ dataset: Record<string, string>; isConnected: boolean }> = [], observers: Array<{ disconnected: number }> = []
  let focused = 0
  const Element = function () {}
  const element = () => {
    const children: Array<{ isConnected: boolean }> = []
    const node = Object.assign(Object.create(Element.prototype), {
      dataset: {} as Record<string, string>, style: {}, childNodes: children, isConnected: false,
      classList: { toggle: () => {} }, addEventListener: () => {}, setAttribute: () => {},
      appendChild: (child: { isConnected: boolean }) => { children.push(child); child.isConnected = true; return child },
      remove: () => { node.isConnected = false }, focus: () => { focused++ },
    })
    nodes.push(node)
    return node
  }
  const previous = element(); previous.isConnected = true
  const Observer = function () { const value = { disconnected: 0 }; observers.push(value); return { observe: () => {}, disconnect: () => { value.disconnected++ } } }
  const doc = {
    activeElement: previous, body: element(), createElement: element,
    addEventListener: (_name: string, listener: (event: KeyboardEvent) => void) => listeners.add(listener),
    removeEventListener: (_name: string, listener: (event: KeyboardEvent) => void) => listeners.delete(listener),
    querySelectorAll: () => nodes.filter(node => node.dataset.modalOverlay !== undefined && node.isConnected),
  }
  Object.assign(globalThis, { document: doc, HTMLElement: Element, ResizeObserver: Observer, MutationObserver: Observer })
  const open = () => { const modal = createModal({ title: 'Recorded evidence' }); doc.body.appendChild(modal.overlay); return modal }
  const escape = () => {
    const event = { key: 'Escape', defaultPrevented: false, preventDefault() { this.defaultPrevented = true } } as KeyboardEvent
    for (const listener of [...listeners]) listener(event)
  }
  return { open, escape, listeners, observers, focused: () => focused, restore: () => Object.assign(globalThis, original) }
}

test('outside click and explicit close release all observers and Escape listeners exactly once', () => {
  const dom = fixture()
  try {
    const modal = dom.open()
    expect(dom.listeners.size).toBe(1)
    expect(dom.observers).toHaveLength(3)
    modal.overlay.onclick!({ target: modal.overlay } as unknown as MouseEvent)
    modal.close()
    expect(dom.listeners.size).toBe(0)
    expect(dom.observers.map(observer => observer.disconnected)).toEqual([1, 1, 1])
    expect(dom.focused()).toBe(1)
  } finally { dom.restore() }
})

test('Escape closes only the top modal, leaving the earlier modal and its observers live', () => {
  const dom = fixture()
  try {
    const first = dom.open(), second = dom.open()
    dom.escape()
    expect(first.overlay.isConnected).toBe(true)
    expect(second.overlay.isConnected).toBe(false)
    expect(dom.listeners.size).toBe(1)
    expect(dom.observers.map(observer => observer.disconnected)).toEqual([0, 0, 0, 1, 1, 1])
    dom.escape()
    expect(first.overlay.isConnected).toBe(false)
    expect(dom.listeners.size).toBe(0)
    expect(dom.observers.every(observer => observer.disconnected === 1)).toBe(true)
  } finally { dom.restore() }
})
