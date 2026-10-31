import { describe, expect, test } from 'bun:test'
import type { DisplayFrameMessage } from '../src/ui/embed/display-frame-protocol.ts'
import { createViewHost, escapeGoesBack, type ReceivedMessage } from '../src/ui/embed/view-host.ts'
import { componentActivation, componentActivationKey, componentValueOwner } from '../src/ui/embed/vignette/component-activation.ts'
import { onElementRequest, requestElement } from '../src/ui/embed/vignette/selection.ts'

describe('component inspection before explicit detail navigation', () => {
  const own = [{ element: 'tg-hp', label: 'HP turbine' }]
  const far = [{ element: 'sg-a-steam', label: 'SG A steam' }, { element: 'sg-b-steam', label: 'SG B steam' }]
  test('equipment, electrical items and connection text inspect their exact drawn item', () => {
    for (const id of ['tg-hp', 'breaker-a', 'main-steam-header', 'sg-a-steam']) expect(componentActivation({ id, kind: 'item', targets: own })).toEqual({ kind: 'faceplate', key: id })
  })
  test('a group opens its existing group faceplate without choosing a representative component', () => {
    expect(componentActivation({ id: 'sg-group', kind: 'group', targets: far })).toEqual({ kind: 'faceplate', key: 'sg-group' })
  })
  test('a continuation inspects its exact far target or asks when several are named', () => {
    expect(componentActivation({ id: 'stop-a', kind: 'stop', targets: [far[0]!] })).toEqual({ kind: 'target', element: 'sg-a-steam', name: 'SG A steam' })
    expect(componentActivation({ id: 'stop-both', kind: 'stop', targets: far })).toEqual({ kind: 'chooser' })
  })
  test('a refused target remains noninteractive', () => {
    for (const kind of ['item', 'group', 'stop'] as const) expect(componentActivation({ id: 'unavailable', kind, targets: [] })).toEqual({ kind: 'none' })
  })
  test('Enter and Space share pointer intent without repeated-key toggling or stolen keys', () => {
    for (const key of ['Enter', ' ']) expect(componentActivationKey({ key, repeat: false, defaultPrevented: false })).toBe(true)
    for (const key of ['Escape', 'ArrowDown', 'Tab']) expect(componentActivationKey({ key, repeat: false, defaultPrevented: false })).toBe(false)
    expect(componentActivationKey({ key: 'Enter', repeat: true, defaultPrevented: false })).toBe(false)
    expect(componentActivationKey({ key: ' ', repeat: false, defaultPrevented: true })).toBe(false)
  })
  test('a values heading never borrows an owner from a different component group', () => {
    expect(componentValueOwner([{ ref: 'plant:a#pressure' }, null, { ref: 'plant:a#temperature' }])).toBe('plant:a')
    expect(componentValueOwner([{ ref: 'plant:a#pressure' }, { ref: 'plant:b#pressure' }])).toBeNull()
    expect(componentValueOwner([null])).toBeNull()
  })
})

test('selection and explicit detail are distinct and an exact owner must answer', () => {
  const shown: string[] = []
  const stop = onElementRequest(request => {
    if (request.objectId !== 'plant:a' || request.elementId !== 'sgA') return false
    shown.push(request.how)
    return true
  })
  expect(requestElement({ objectId: 'plant:a', elementId: 'sgA', how: 'select' })).toBe(true)
  expect(requestElement({ objectId: 'plant:a', elementId: 'sgA', how: 'detail' })).toBe(true)
  expect(requestElement({ objectId: 'plant:b', elementId: 'sgA', how: 'select' })).toBe(false)
  expect(requestElement({ objectId: 'plant:a', elementId: 'rcpA', how: 'select' })).toBe(false)
  stop()
  expect(requestElement({ objectId: 'plant:a', elementId: 'sgA', how: 'select' })).toBe(false)
  expect(shown).toEqual(['select', 'detail'])
})

describe('Esc respects the innermost card before display Back', () => {
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
  test('a card or real command may claim Esc; otherwise the display returns to its previous entry', () => {
    const { host, posted } = presented('Halden Unit 1'), keys = target()
    const stop = escapeGoesBack(host, keys as unknown as Window)
    keys.press('Escape', true)
    expect(posted).toEqual([])
    keys.press('Escape')
    expect(posted).toEqual([{ type: 'world:display-back' }])
    stop()
    expect(keys.listening()).toBe(0)
  })
  test('a display opened from none has no Back', () => {
    const { host, posted } = presented(), keys = target()
    escapeGoesBack(host, keys as unknown as Window)
    keys.press('Escape')
    expect(posted).toEqual([])
  })
})
