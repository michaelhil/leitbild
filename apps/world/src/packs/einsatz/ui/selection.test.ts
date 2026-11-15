import { describe, expect, test } from 'bun:test'
import { geoPointFromLonLat, type GeoJsonPoint } from '../../../core/model/index.ts'
import { einsatzPackId } from '../ids.ts'
import {
  dispatchKindOf,
  doubleClickMs,
  initialSelection,
  reduceSelection,
  refusalShownMs,
  selectedObjectOf,
  selectionChangeEvent,
  type Clicked,
  type Selection,
  type SelectionEffect,
  type SelectionEvent,
  type SelectionState,
} from './selection.ts'

/**
 * Every cell of the plan's selection table (B.3): the five states S0, SU,
 * SA, SC and SS against a click on a unit (another, or the same one), a call
 * or site, open ground, a row of the panel, Esc / × and a double-click; and
 * what an armed unit's submit comes back with.
 */

const point: GeoJsonPoint = geoPointFromLonLat(11.4, 59.1)
const unitA = { id: 'u-a', kind: 'unit' } as const
const unitB = { id: 'u-b', kind: 'unit' } as const
const call = { id: 't-1', kind: 'call' } as const
const call2 = { id: 't-2', kind: 'call' } as const
const site = { id: 's-1', kind: 'site' } as const
const track = { id: 'k-1', kind: 'track' } as const
const ground: Clicked = { kind: 'ground', point }

const s0: Selection = { kind: 'none', marked: null }
const su: Selection = { kind: 'unit', unitId: unitA.id }
const sa: Selection = { kind: 'armed', unitId: unitA.id, when: null, prompt: null, refusal: null }
const sc: Selection = { kind: 'call', callId: call.id }
const ss: Selection = { kind: 'site', siteId: site.id }
const states = { S0: s0, SU: su, SA: sa, SC: sc, SS: ss } as const

const start = (selection: Selection): SelectionState => ({ selection, lastClick: null })
let clock = 10_000
const click = (on: Clicked, atMs = (clock += 2_000)): SelectionEvent => ({ kind: 'click', on, atMs })
const step = (selection: Selection, event: SelectionEvent) => reduceSelection(start(selection), event)
const kinds = (effects: ReadonlyArray<SelectionEffect>) => effects.map(effect => effect.kind)

describe('B.3: a click on a unit', () => {
  for (const [name, selection] of Object.entries(states)) {
    test(`${name}: another unit opens its card`, () => {
      const result = step(selection, click(unitB))
      expect(result.state.selection).toEqual({ kind: 'unit', unitId: unitB.id })
      expect(result.effects).toEqual([{ kind: 'select', objectId: unitB.id }])
    })
  }
  test('S0, SC, SS: unit A opens its card', () => {
    for (const selection of [s0, sc, ss]) expect(step(selection, click(unitA)).state.selection).toEqual(su)
  })
  test('SU: the same unit is a no-op', () => {
    const result = step(su, click(unitA))
    expect(result.state.selection).toEqual(su)
    expect(result.effects).toEqual([])
  })
  test('SA: the same unit is a no-op and stays armed; another unit disarms', () => {
    const same = step(sa, click(unitA))
    expect(same.state.selection).toEqual(sa)
    expect(same.effects).toEqual([])
    expect(step(sa, click(unitB)).state.selection).toEqual({ kind: 'unit', unitId: unitB.id })
  })
})

describe('B.3: a click on a call or a site', () => {
  for (const name of ['S0', 'SU', 'SC', 'SS'] as const) {
    test(`${name}: a call opens its card and pins its proposal; it never sends`, () => {
      const target = name === 'SC' ? call2 : call
      const result = step(states[name], click(target))
      expect(result.state.selection).toEqual({ kind: 'call', callId: target.id })
      expect(result.effects).toEqual([{ kind: 'select', objectId: target.id }, { kind: 'recommend', callId: target.id }])
      expect(kinds(result.effects)).not.toContain('submit')
    })
    test(`${name}: a site opens its card`, () => {
      const result = step(states[name], click(name === 'SS' ? { id: 's-2', kind: 'site' } : site))
      expect(result.state.selection.kind).toBe('site')
      expect(kinds(result.effects)).toEqual(['select'])
    })
  }
  test('SC: the same call again is a no-op: the pinned proposal is not asked for again', () => {
    expect(step(sc, click(call))).toEqual({ state: { selection: sc, lastClick: expect.anything() }, effects: [] })
  })
  test('SA: a call submits unit.order for the armed unit, a site likewise, a track as an engage stop', () => {
    expect(step(sa, click(call)).effects).toEqual([{ kind: 'submit', unitId: unitA.id, target: { taskId: call.id }, when: null }])
    expect(step(sa, click(site)).effects).toEqual([{ kind: 'submit', unitId: unitA.id, target: { siteId: site.id }, when: null }])
    expect(step(sa, click(track)).effects).toEqual([{ kind: 'submit', unitId: unitA.id, target: { trackId: track.id }, when: null }])
    expect(step(sa, click(call)).state.selection).toEqual(sa)
  })
  test('SA: a target the options list as refused (a dimmed target) submits all the same: the server decides', () => {
    // The reducer never reads the options: the glow is only a hint.
    expect(kinds(step(sa, click(call2)).effects)).toEqual(['submit'])
  })
  test('SA armed by "+ Add stop" submits with when "after"', () => {
    const armed = reduceSelection(start(su), { kind: 'arm', unitId: unitA.id, when: 'after' }).state
    expect(reduceSelection(armed, click(call)).effects).toEqual([{ kind: 'submit', unitId: unitA.id, target: { taskId: call.id }, when: 'after' }])
  })
  test('a track outside SA is marked on the map, with no card', () => {
    const result = step(su, click(track))
    expect(result.state.selection).toEqual({ kind: 'none', marked: track.id })
    expect(result.effects).toEqual([{ kind: 'select', objectId: track.id }])
  })
})

describe('B.3: a click on open ground', () => {
  for (const name of ['S0', 'SU', 'SC', 'SS'] as const) {
    test(`${name}: goes to S0`, () => {
      const result = step(states[name], click(ground))
      expect(result.state.selection).toEqual(s0)
      expect(result.effects).toEqual(name === 'S0' ? [] : [{ kind: 'select', objectId: null }])
    })
  }
  test('SA: shows the "Move here" prompt and moves nothing until it is confirmed', () => {
    const shown = step(sa, click(ground))
    expect(shown.state.selection).toEqual({ ...sa, prompt: { kind: 'move', point } })
    expect(shown.effects).toEqual([])
    const confirmed = reduceSelection(shown.state, { kind: 'prompt', choice: 'move' })
    expect(confirmed.effects).toEqual([{ kind: 'submit', unitId: unitA.id, target: { point }, when: null }])
    expect(confirmed.state.selection).toEqual(sa)
  })
  test('SA: another tap on the ground moves the prompt there; a target click answers it by submitting', () => {
    const shown = step(sa, click(ground)).state
    const elsewhere = geoPointFromLonLat(11.5, 59.2)
    expect(reduceSelection(shown, click({ kind: 'ground', point: elsewhere })).state.selection).toEqual({ ...sa, prompt: { kind: 'move', point: elsewhere } })
    const sent = reduceSelection(shown, click(call))
    expect([sent.state.selection, kinds(sent.effects)]).toEqual([sa, ['submit']])
  })
})

describe('B.3: a row in the panel', () => {
  test('S0, SU, SC, SS: a row opens that object\'s card, as the same object on the map does', () => {
    for (const selection of [s0, su, sc, ss]) {
      expect(step(selection, click(call2)).state.selection).toEqual({ kind: 'call', callId: call2.id })
      expect(step(selection, click(unitB)).state.selection).toEqual({ kind: 'unit', unitId: unitB.id })
    }
  })
  test('SA: a row of the armed target list submits like the map target', () => {
    const result = step(sa, { kind: 'target-row', target: { siteId: site.id }, atMs: 1 })
    expect(result.effects).toEqual([{ kind: 'submit', unitId: unitA.id, target: { siteId: site.id }, when: null }])
  })
  test('a target row outside SA is a programming error, never a silent order', () => {
    expect(() => step(su, { kind: 'target-row', target: { taskId: call.id }, atMs: 1 })).toThrow('no unit is armed')
  })
})

describe('B.3: Esc, the banner × and the card ×', () => {
  test('S0: nothing', () => expect(step(s0, { kind: 'back' }).effects).toEqual([]))
  test('SU, SC, SS: back to S0', () => {
    for (const selection of [su, sc, ss]) expect(step(selection, { kind: 'back' })).toEqual({ state: start(s0), effects: [{ kind: 'select', objectId: null }] })
  })
  test('SA: one level back to the unit\'s card, prompt and all', () => {
    const prompted: Selection = { ...sa, prompt: { kind: 'move', point } }
    expect(step(prompted, { kind: 'back' })).toEqual({ state: start(su), effects: [] })
  })
  test('a marked track clears', () => expect(step({ kind: 'none', marked: track.id }, { kind: 'back' }).effects).toEqual([{ kind: 'select', objectId: null }]))
})

describe('B.3: a double-click acts as one click', () => {
  const twice = (selection: Selection, on: Clicked) => {
    const first = reduceSelection(start(selection), click(on, 50_000))
    const second = reduceSelection(first.state, click(on, 50_000 + doubleClickMs - 1))
    return { first, second }
  }
  for (const [name, selection] of Object.entries(states)) {
    test(`${name}: the second click on a unit, a call or the ground is a no-op`, () => {
      for (const on of [unitB, call2, ground]) {
        const { first, second } = twice(selection, on)
        expect(second.state.selection).toEqual(first.state.selection)
        expect(second.effects).toEqual([])
      }
    })
  }
  test('S0: double-clicking a unit leaves its card open (E2)', () => {
    const { second } = twice(s0, unitA)
    expect(second.state.selection).toEqual(su)
  })
  test('SA: a double-click on a target submits once', () => {
    const { first, second } = twice(sa, call)
    expect(kinds(first.effects)).toEqual(['submit'])
    expect(second.effects).toEqual([])
  })
  test('a second click after the double-click interval acts', () => {
    const first = reduceSelection(start(sa), click(call, 1_000))
    expect(kinds(reduceSelection(first.state, click(call, 1_000 + doubleClickMs)).effects)).toEqual(['submit'])
  })
  test('a click on another object right after acts', () => {
    const first = reduceSelection(start(s0), click(call, 1_000))
    expect(reduceSelection(first.state, click(unitA, 1_100)).state.selection).toEqual(su)
  })
})

describe('Arming and the armed unit\'s submits', () => {
  test('"Dispatch A4…" arms the unit and reads its options', () => {
    expect(step(su, { kind: 'arm', unitId: unitA.id, when: null })).toEqual({ state: start(sa), effects: [{ kind: 'options', unitId: unitA.id }] })
  })
  test('an accepted submit returns to the unit\'s card', () => {
    const result = step(sa, { kind: 'result', unitId: unitA.id, target: { taskId: call.id }, outcome: { ok: true }, atMs: 1 })
    expect(result.state.selection).toEqual(su)
  })
  test('a busy unit refused when_required shows the busy prompt at the target, reads the options again, then sends the choice', () => {
    const refused = step(sa, { kind: 'result', unitId: unitA.id, target: { taskId: call.id }, outcome: { ok: false, code: 'when_required', text: 'busy' }, atMs: 1 })
    expect(refused.state.selection).toEqual({ ...sa, prompt: { kind: 'busy', target: { taskId: call.id } } })
    expect(refused.effects).toEqual([{ kind: 'options', unitId: unitA.id }])
    expect(reduceSelection(refused.state, { kind: 'prompt', choice: 'after' }).effects).toEqual([{ kind: 'submit', unitId: unitA.id, target: { taskId: call.id }, when: 'after' }])
    expect(reduceSelection(refused.state, { kind: 'prompt', choice: 'now' }).effects).toEqual([{ kind: 'submit', unitId: unitA.id, target: { taskId: call.id }, when: 'now' }])
    expect(() => reduceSelection(refused.state, { kind: 'prompt', choice: 'move' })).toThrow('offers no move')
  })
  test('any other refusal shows beside the target for 4 s, stays armed and sends nothing', () => {
    const refused = step(sa, { kind: 'result', unitId: unitA.id, target: { siteId: site.id }, outcome: { ok: false, code: 'site_not_accepting', text: 'S-1 is closed' }, atMs: 1_000 })
    expect(refused.state.selection).toEqual({ ...sa, refusal: { targetId: site.id, code: 'site_not_accepting', text: 'S-1 is closed', untilMs: 1_000 + refusalShownMs } })
    expect(refused.effects).toEqual([])
    expect(reduceSelection(refused.state, { kind: 'tick', atMs: 1_000 + refusalShownMs - 1 }).state).toBe(refused.state)
    expect(reduceSelection(refused.state, { kind: 'tick', atMs: 1_000 + refusalShownMs }).state.selection).toEqual(sa)
  })
  test('a result for a unit no longer armed changes nothing', () => {
    expect(step(sc, { kind: 'result', unitId: unitA.id, target: { taskId: call.id }, outcome: { ok: true }, atMs: 1 }).state.selection).toEqual(sc)
  })
  test('confirming a prompt that is not shown is a programming error', () => {
    expect(() => step(sa, { kind: 'prompt', choice: 'move' })).toThrow('no prompt shown')
  })
})

describe('The shared selection', () => {
  const kindOf = (id: string) => [unitA, unitB, call, call2, site, track].find(entry => entry.id === id)?.kind ?? null
  test('the panel\'s own select coming back is no event', () => {
    for (const selection of Object.values(states)) expect(selectionChangeEvent(start(selection), selectedObjectOf(selection), kindOf, 1)).toBeNull()
  })
  test('a map selection of another object is a click on it; a cleared one, or another Pack\'s object, clears', () => {
    expect(selectionChangeEvent(start(s0), unitA.id, kindOf, 7)).toEqual({ kind: 'click', on: unitA, atMs: 7 })
    expect(selectionChangeEvent(start(su), null, kindOf, 7)).toEqual({ kind: 'cleared' })
    expect(selectionChangeEvent(start(su), 'other-pack-object', kindOf, 7)).toEqual({ kind: 'cleared' })
    expect(step(sa, { kind: 'cleared' }).state.selection).toEqual(s0)
  })
  test('Einsatz objects are classified by their record: a receiving unit is a site', () => {
    const of = (packData: unknown, packId: string = einsatzPackId) => dispatchKindOf({ packId: packId as never, packData: packData as never })
    expect(of({ type: 'unit', accepting: true })).toBe('site')
    expect(of({ type: 'unit' })).toBe('unit')
    expect(of({ type: 'task' })).toBe('call')
    expect(of({ type: 'track' })).toBe('track')
    expect(of({ type: 'track-index' })).toBeNull()
    expect(of({ type: 'unit' }, 'other')).toBeNull()
  })
})
