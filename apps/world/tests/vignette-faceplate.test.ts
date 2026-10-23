import { describe, expect, test } from 'bun:test'
import { embeddedViewOpenMessageSchema, newWorkspaceId, type EmbeddedViewOpenMessage } from '@leitbild/contracts'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SimulationRunId } from '../src/core/model/index.ts'
import type { AlertRow } from '../src/features/displays/alerts/rows.ts'
import type { VignetteSample, VignetteValue, VignetteView } from '../src/features/displays/compose/model.ts'
import { defaultDisplayEnvelope } from '../src/ui/process-display/default-display.ts'
import type { DisplayFrameMessage } from '../src/ui/embed/display-frame-protocol.ts'
import { createViewHost, type ReceivedMessage } from '../src/ui/embed/view-host.ts'
import { FACEPLATE_HEIGHT_AT_REST, FACEPLATE_LEAD_ROWS, faceplateStates, FACEPLATES_PER_STATE, hostFirst, ownAlerts, readingLabel, readingsOf, shortOfRoom, shownReadings } from '../src/ui/embed/vignette/faceplate.ts'
import {
  elementOffer, FACEPLATE_CLOSED, FACEPLATE_MARGIN, FACEPLATE_ROW, FACEPLATE_WIDTH, faceplateHeight, faceplatePlacement, keptInRoom, movedOverlay, nextFaceplate,
  openElementDefault, OVERLAY_WIDTH, raisedOverlay, readPins, replacedOverlays, resizedOverlay, togglePinned, writePins, type PinnedOverlay,
} from '../src/ui/embed/vignette/popover.ts'

// An element's faceplate (L2, plan v5 §3, W3.2–W3.4): operated only where a display window presents its display; in a
// chat answer or a procedure tag's dialog it offers the way there. It stands beside its item inside the part of the
// frame a person sees, pins, moves and resizes as OLD's item popover did (724ae2ac8 tests/mimic-popover.test.ts
// 'the item popover', ported below: verbatim where the behaviour is OLD's, re-expressed where R2 changed it).

const origin = 'https://leitbild.test'
const workspaceId = newWorkspaceId()
const runId = 'run-1' as SimulationRunId

const framed = () => {
  const posted: Array<DisplayFrameMessage | EmbeddedViewOpenMessage> = []
  const parent = { postMessage: (message: DisplayFrameMessage | EmbeddedViewOpenMessage) => { posted.push(message) } }
  let receive: ((message: ReceivedMessage) => void) | null = null
  const host = createViewHost({ parent, origin, listen: next => { receive = next; return () => { receive = null } }, refused: () => {} })
  let opening: Parameters<typeof elementOffer>[0] = null
  host.subscribeOpening(where => { opening = where })
  host.listen()
  posted.length = 0
  return { host, posted, offer: () => elementOffer(opening), fromParent: (data: unknown) => receive!({ origin, source: parent, data }) }
}

const valve = defaultDisplayEnvelope({ workspaceId, simulationRunId: runId, view: { viewType: 'display.vignette', title: 'PORV 1', height: 420, state: '{"subjects":["plant:a#porv1"]}' } })
const from = { key: '{"subjects":["plant:a"]}', title: 'Pressurizer' }

describe('an element\'s faceplate by where its display is shown', () => {
  test('in the display window it offers the element\'s Pack actions', () => {
    const page = framed()
    page.fromParent({ type: 'world:display-frame', shown: true, zoom: 1 })
    expect(page.offer()).toBe('actions')
  })

  test('in a chat answer it offers no actions: its header opens the element\'s default in the display window, captioned with the display it came from', () => {
    const page = framed()
    page.fromParent({ type: 'leitbild:view-host' })
    expect(page.offer()).toBe('open-in-window')
    expect(openElementDefault(page.host, from, valve)).toBe(true)
    const message = embeddedViewOpenMessageSchema.parse(page.posted[0])
    expect(message.view.envelope).toEqual(valve)
    expect(message.view.caption).toBe('From Pressurizer')
    // The same element opened again from the same display is the same listing; from another display, another.
    openElementDefault(page.host, from, valve)
    openElementDefault(page.host, { ...from, key: '{"subjects":["plant:b"]}' }, valve)
    const keys = page.posted.map(posted => embeddedViewOpenMessageSchema.parse(posted).view.key)
    expect(keys[1]).toBe(keys[0]!)
    expect(keys[2]).not.toBe(keys[0]!)
  })

  test('in a frame no page hosts, it offers nothing to act on and opens nothing', () => {
    const page = framed()
    expect(page.offer()).toBe('nothing')
    expect(openElementDefault(page.host, from, valve)).toBe(false)
    expect(page.posted).toEqual([])
  })

  test('it loads its Pack\'s actions only under the display window\'s offer, and hands them the FROZEN state, its pin and whether it is short of room', () => {
    const source = readFileSync(join(import.meta.dir, '../src/ui/embed/vignette/Faceplate.svelte'), 'utf8')
    expect(source.match(/loadEmbedPack\(/g)).toHaveLength(1)
    const guard = source.indexOf("if (offer === 'actions' && !group) {")
    expect(guard).toBeGreaterThan(0)
    expect(source.indexOf('loadEmbedPack(packId)')).toBeGreaterThan(guard)
    expect(source).toContain('<Actions {runId} objectId={objectIdSchema.parse(objectId)} {elementId} {frozen} pinned={pinned !== null} {short} />')
  })
})

describe('the item popover (OLD mimic-popover.test.ts, ported)', () => {
  // Re-expressed: OLD's hover quick look is gone (plan v5 W3.2 deletes the dead quick-look state); a press opens.
  test('a press opens an item\'s faceplate; a second press on the same item closes it, on another moves it there', () => {
    expect(nextFaceplate(FACEPLATE_CLOSED, { kind: 'pressed', item: 'a' })).toEqual({ kind: 'open', item: 'a' })
    expect(nextFaceplate({ kind: 'open', item: 'a' }, { kind: 'pressed', item: 'a' })).toEqual(FACEPLATE_CLOSED)
    expect(nextFaceplate({ kind: 'open', item: 'a' }, { kind: 'pressed', item: 'b' })).toEqual({ kind: 'open', item: 'b' })
    expect(nextFaceplate({ kind: 'open', item: 'a' }, { kind: 'dismissed' })).toEqual(FACEPLATE_CLOSED)
  })

  test('the pin keeps a popover on the surface until it is pressed again; several stand at once, the one touched last on top', () => {
    const a: PinnedOverlay = { item: 'a', x: 100, y: 50, width: FACEPLATE_WIDTH, rows: null }
    const b: PinnedOverlay = { item: 'b', x: 500, y: 50, width: FACEPLATE_WIDTH, rows: null }
    const both = togglePinned(togglePinned([], a), b)
    expect(both.map(overlay => overlay.item)).toEqual(['a', 'b'])
    expect(raisedOverlay(both, 'a').map(overlay => overlay.item)).toEqual(['b', 'a'])
    expect(togglePinned(both, a)).toEqual([b])
  })

  test('an overlay is dragged and kept inside the window, at the window\'s zoom', () => {
    const page = { x: 0, y: 0, width: 1600, height: 900 }
    const a: PinnedOverlay = { item: 'a', x: 100, y: 50, width: 340, rows: null }
    expect(movedOverlay(a, { dx: 40, dy: 10 }, 200, page, 1)).toEqual({ ...a, x: 140, y: 60 })
    // Never past the window's edges: 340 wide, 200 tall.
    expect(movedOverlay(a, { dx: 5000, dy: 5000 }, 200, page, 1)).toEqual({ ...a, x: 1260, y: 700 })
    expect(movedOverlay(a, { dx: -500, dy: -500 }, 200, page, 1)).toEqual({ ...a, x: 0, y: 0 })
    // Drawn at 1/2 when the window shows the display at 200 %: it takes half the page's px.
    expect(movedOverlay(a, { dx: 5000, dy: 0 }, 200, page, 2)).toEqual({ ...a, x: 1430, y: 50 })
    // A smaller window moves it back inside.
    expect(keptInRoom({ ...a, x: 1400 }, 200, { x: 0, y: 0, width: 1200, height: 900 }, 1)).toEqual({ ...a, x: 860 })
  })

  // Re-expressed: the card's rows are its 24 px readings (OLD resized 28 px quick-look rows).
  test('resizing widens only the readings, between 280 and 520 px, and shows whole rows, dropping the rest from the bottom', () => {
    const page = { x: 0, y: 0, width: 1600, height: 900 }
    const a: PinnedOverlay = { item: 'a', x: 100, y: 50, width: 340, rows: null }
    const start = { width: 340, rows: 6 }
    // 6 rows drawn in 260 px: chrome 116 px.
    expect(resizedOverlay(a, start, { dx: 100, dy: 0 }, 6, 260, page, 1)).toEqual({ ...a, width: 440, rows: null })
    expect(resizedOverlay(a, start, { dx: 1000, dy: 0 }, 6, 260, page, 1).width).toBe(OVERLAY_WIDTH.max)
    expect(resizedOverlay(a, start, { dx: -1000, dy: 0 }, 6, 260, page, 1).width).toBe(OVERLAY_WIDTH.min)
    // Two rows up: 4 rows; a short drag snaps to whole rows; never fewer than one, never more than it has.
    expect(resizedOverlay(a, start, { dx: 0, dy: -2 * FACEPLATE_ROW }, 6, 260, page, 1).rows).toBe(4)
    expect(resizedOverlay(a, start, { dx: 0, dy: -10 }, 6, 260, page, 1).rows).toBeNull()
    expect(resizedOverlay(a, start, { dx: 0, dy: -1000 }, 6, 260, page, 1).rows).toBe(1)
    expect(resizedOverlay(a, { width: 340, rows: 2 }, { dx: 0, dy: 1000 }, 6, 148, page, 1).rows).toBeNull()
    // Near the window's bottom edge it shows only the rows that fit above it: 200 px less 100 px of chrome hold 4.
    expect(resizedOverlay({ ...a, y: 700 }, { width: 340, rows: 2 }, { dx: 0, dy: 1000 }, 6, 148, page, 1).rows).toBe(4)
  })

  // Re-expressed: it keeps an 8 px margin inside the room (OLD placed it flush with the page's edges).
  test('it stands beside its item, never over it, and reads at 100 % at the window\'s zoom', () => {
    const page = { x: 0, y: 0, width: 1600, height: 900 }
    const card = { width: 360, height: 400 }
    // Right of the item where it fits, its top level with the item's.
    expect(faceplatePlacement({ x: 100, y: 200, width: 120, height: 60 }, card, page, 1)).toEqual({ x: 228, y: 200 })
    // At the page's right edge it goes left of the item; near the bottom it is lifted to fit, inside the margin.
    expect(faceplatePlacement({ x: 1500, y: 700, width: 80, height: 100 }, card, page, 1)).toEqual({ x: 1132, y: 900 - FACEPLATE_MARGIN - 400 })
    // At half zoom it is drawn twice as large in the page's px, so it reads at 100 %: it needs twice the room.
    expect(faceplatePlacement({ x: 100, y: 0, width: 120, height: 60 }, card, page, 0.5)).toEqual({ x: 236, y: 2 * FACEPLATE_MARGIN })
    expect(faceplatePlacement({ x: 1000, y: 0, width: 120, height: 60 }, card, page, 0.5)).toEqual({ x: 264, y: 2 * FACEPLATE_MARGIN })
  })
})

describe('the room a faceplate stands in (spike must-fix 1–3)', () => {
  test('it is the part of a tall display the window shows, not the frame\'s whole height', () => {
    // 1440 x 900: the window body shows 792 px of a 960 px vignette, scrolled 100 px down.
    const room = { x: 18, y: 100, width: 1386, height: 674 }
    const place = faceplatePlacement({ x: 600, y: 700, width: 72, height: 48 }, { width: FACEPLATE_WIDTH, height: 280 }, room, 1)
    expect(place.y + 280).toBeLessThanOrEqual(room.y + room.height - FACEPLATE_MARGIN)
    expect(place.y).toBeGreaterThanOrEqual(room.y + FACEPLATE_MARGIN)
    expect(faceplateHeight(room, 1)).toBe(674 - 2 * FACEPLATE_MARGIN)
  })

  test('after the window narrows, an overlay that no longer fits goes beside its item again, never over it', () => {
    const wide = { x: 0, y: 0, width: 1888, height: 1000 }
    const narrow = { x: 0, y: 0, width: 1010, height: 1000 }
    const sgA: PinnedOverlay = { item: 'sgA', x: 1200, y: 400, width: 380, rows: null }
    const kept: PinnedOverlay = { item: 'rcpA', x: 100, y: 100, width: 380, rows: null }
    const item = { x: 500, y: 560, width: 120, height: 48 }
    const next = replacedOverlays([sgA, kept], overlay => ({ item: overlay.item === 'sgA' ? item : null, height: 280 }), narrow, 1)
    expect(next[1]).toBe(kept)
    const moved = next[0]!
    expect(moved.x + 380).toBeLessThanOrEqual(narrow.width)
    const covers = moved.x < item.x + item.width && moved.x + 380 > item.x && moved.y < item.y + item.height && moved.y + 280 > item.y
    expect(covers).toBe(false)
    expect(replacedOverlays([kept], () => ({ item: null, height: 280 }), wide, 1)).toEqual([kept])
    // An item the narrowed room no longer shows (scrolled out to the right) has no room beside it: the card stays inside.
    const gone = replacedOverlays([{ ...sgA, item: 'sgD', x: 1316 }], () => ({ item: { x: 1222, y: 468, width: 86, height: 47 }, height: 280 }), narrow, 1)[0]!
    expect(gone.x).toBeGreaterThanOrEqual(narrow.x)
    expect(gone.x + 380).toBeLessThanOrEqual(narrow.x + narrow.width)
  })

})

describe('pins kept for the browser session', () => {
  const memory = () => {
    const store = new Map<string, string>()
    return { store, getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value) }, removeItem: (key: string) => { store.delete(key) } }
  }

  test('by display and item, cleared when none stand; a stored value that is no list of pins is refused aloud', () => {
    const storage = memory()
    const a: PinnedOverlay = { item: 'sgA', x: 10, y: 20, width: 380, rows: null }
    writePins(storage, 'overview', [a])
    expect(readPins(storage, 'overview')).toEqual([a])
    expect(readPins(storage, 'other')).toEqual([])
    writePins(storage, 'overview', [])
    expect(storage.store.size).toBe(0)
    writePins(storage, 'overview', [a])
    storage.store.set([...storage.store.keys()][0]!, '[{"item":"sgA"}]')
    expect(() => readPins(storage, 'overview')).toThrow('cannot be read')
  })
})

describe('what a faceplate reads', () => {
  test('every open or pinned faceplate shares one sample, four elements to a state of lead requests', () => {
    const states = faceplateStates('plant:a', ['sgA', 'rcpA', 'sgA', 'core', 'pressurizer', 'turbine'], '2026-10-23T04:05:00.000Z')
    expect(states.map(state => state.elements)).toEqual([['sgA', 'rcpA', 'core', 'pressurizer'], ['turbine']])
    expect(states[0]!.elements).toHaveLength(FACEPLATES_PER_STATE)
    expect(JSON.parse(states[1]!.state)).toEqual({ title: 'Faceplates', at: { at: '2026-10-23T04:05:00.000Z', clock: 'wall' }, views: [{ kind: 'values', lead: { objectId: 'plant:a', element: 'turbine' }, rows: FACEPLATE_LEAD_ROWS }] })
  })

  test('each element\'s readings come from its view and the latest sample, with the devices it bundles', () => {
    const value = { ref: 'plant:a#pressurizer.p', label: 'Unit · Pressure', quantity: 'pressure', unit: 'MPa', valueType: 'number', thresholds: [], series: null } as VignetteValue
    const view = { title: 'Faceplates', sections: [{ kind: 'values', rows: 6, values: [value], lead: 0, devices: [{ id: 'pressurizer.reliefValve', class: 'porv', label: 'PORV', parent: 'pressurizer' }] }] } as unknown as VignetteView
    const sample = { observations: [{ ref: value.ref, value: 15.2 }] } as unknown as VignetteSample
    const read = readingsOf(['pressurizer'], view, sample).get('pressurizer')!
    expect(read.values).toEqual([value])
    expect(read.devices.map(device => device.label)).toEqual(['PORV'])
    expect(readingsOf(['pressurizer'], undefined, sample).size).toBe(0)
  })

  test('a reading is labelled without its display\'s object and its own element\'s name', () => {
    const element = { id: 'sgA', class: 'steamGenerator', label: 'Steam Generator A', shortLabel: 'SG A' }
    expect(readingLabel({ label: 'Halden Unit 1 · Steam generator narrow-range level · SG A', element }, 'Halden Unit 1', 'sgA')).toBe('Steam generator narrow-range level')
    // Another element's reading keeps its name.
    expect(readingLabel({ label: 'Halden Unit 1 · Feedwater to steam generator A flow · FCV A → SG A', element: { ...element, id: 'fcvA' } }, 'Halden Unit 1', 'sgA')).toBe('Feedwater to steam generator A flow · FCV A → SG A')
  })

  test('its own alerts are those on its element, never the unit\'s first-outs', () => {
    const row = (element: string | null, key: string) => ({ key, objectId: 'plant:a', alert: { ...(element === null ? {} : { subject: { element } }) } }) as unknown as AlertRow
    expect(ownAlerts([row('sgA', '1'), row('core', '2'), row(null, '3'), row('sgA', '4')], 'plant:a', ['sgA']).map(entry => entry.key)).toEqual(['1', '4'])
  })
  test('at rest its readings give way, whole rows from the bottom and counted, so it stands no taller than 300 px', () => {
    const row = 24
    // The core: header, folded controls and two alerts take 156 px; six readings fit.
    expect(shownReadings(6, { rest: 156, row, pending: false, rows: null })).toEqual({ shown: 6, more: 0 })
    // RCP A with its START/STOP: 200 px beside its readings hold four rows: three readings and the row that counts the other three.
    expect(shownReadings(6, { rest: 200, row, pending: false, rows: null })).toEqual({ shown: 3, more: 3 })
    expect(200 + (3 + 1) * row).toBeLessThanOrEqual(FACEPLATE_HEIGHT_AT_REST)
    // A proposal pending, or the rows a person resized it to, decide instead.
    expect(shownReadings(6, { rest: 200, row, pending: true, rows: null })).toEqual({ shown: 6, more: 0 })
    expect(shownReadings(6, { rest: 200, row, pending: false, rows: 2 })).toEqual({ shown: 2, more: 4 })
    expect(shownReadings(3, { rest: 600, row, pending: false, rows: null })).toEqual({ shown: 1, more: 2 })
  })

  test('a host\'s own readings and its lines\' lead before those of the devices it bundles, which it lists as links', () => {
    const value = (ref: string, element: { id: string; parent?: string }) => ({ ref, label: ref, quantity: 'pressure', unit: 'MPa', valueType: 'number', thresholds: [], series: null, element: { class: 'x', label: element.id, ...element } }) as VignetteValue
    // The pressurizer's lead as its Pack ranks it: pressure, then readings on the PORV and the safety valves among its own.
    const lead = [
      value('pressure', { id: 'pressurizer' }), value('porv acoustic', { id: 'pressurizer.reliefValve', parent: 'pressurizer' }),
      value('tailpipe', { id: 'pressurizer-relief-to-tank' }), value('safety valves open', { id: 'pressurizer.safetyValves', parent: 'pressurizer' }),
      value('level deviation', { id: 'pressurizer' }), value('level', { id: 'pressurizer' }), value('level program', { id: 'pressurizer' }), value('heaters', { id: 'pressurizer' }),
    ]
    expect(hostFirst(lead, 'pressurizer').map(entry => entry.ref)).toEqual(['pressure', 'tailpipe', 'level deviation', 'level', 'level program', 'heaters', 'porv acoustic', 'safety valves open'])
    // A device's own faceplate keeps its lead as it is.
    expect(hostFirst(lead, 'pressurizer.reliefValve')).toEqual(lead)
    const view = { title: 'Faceplates', sections: [{ kind: 'values', rows: FACEPLATE_LEAD_ROWS, values: lead, lead: 0 }] } as unknown as VignetteView
    expect(readingsOf(['pressurizer'], view, { observations: [] } as unknown as VignetteSample).get('pressurizer')!.values.map(entry => entry.ref))
      .toEqual(['pressure', 'tailpipe', 'level deviation', 'level', 'level program', 'heaters'])
  })

  test('at rest, a faceplate whose controls would leave it fewer than three readings is short of room: its controls fold', () => {
    const row = 24
    // The pressurizer beside its heater control, its devices and an alert: 227 px leave three rows, two readings and the count.
    expect(shortOfRoom(6, { rest: 227, row, pending: false, rows: null })).toBe(true)
    // Folded, 178 px leave five rows: four readings, level among them.
    expect(shownReadings(6, { rest: 178, row, pending: false, rows: null })).toEqual({ shown: 4, more: 2 })
    expect(shortOfRoom(6, { rest: 178, row, pending: false, rows: null })).toBe(false)
    // RCP A beside its START/STOP keeps four: its control stays.
    expect(shortOfRoom(6, { rest: 165, row, pending: false, rows: null })).toBe(false)
    // A proposal pending, or a resized overlay, never folds for room.
    expect(shortOfRoom(6, { rest: 227, row, pending: true, rows: null })).toBe(false)
    expect(shortOfRoom(6, { rest: 227, row, pending: false, rows: 2 })).toBe(false)
  })

  test('a frozen display\'s faceplate keeps its last readings, in the low-integrity style, never "?"', () => {
    const source = readFileSync(join(import.meta.dir, '../src/ui/embed/vignette/Faceplate.svelte'), 'utf8')
    expect(source).toContain('const observations = $derived(readings === null ? [] : readings.observations)')
    expect(source).toContain('const shown = (look: ReadingLook): ReadingLook => (frozen ? { ...look, doubtful: true } : look)')
    expect(source).toContain('{@const look = shown(valueLook(value, observations, value.ref))}')
    // Its header says no state word while frozen: the drawing's word is then "?" ("RCP A ?").
    expect(source).toContain('const stateWord = $derived(frozen ? null : word)')
    expect(source).toContain('{#if stateWord !== null}<span class="word">{stateWord}</span>{/if}')
  })
})
