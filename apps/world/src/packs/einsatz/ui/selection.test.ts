import { describe, expect, test } from 'bun:test'
import { initialSelection, planExpectation, reduceSelection, type ClickedObject, type SelectionState } from './selection.ts'
import type { UnitOptions } from '../situation/schema.ts'
import { dispatchWords } from './presenters.ts'

const free = { id: 'unit:a', status: { word: 'Free', tone: 'free' as const }, commandedBy: null, carry: null, plan: [] }
const unit = { kind: 'unit', id: free.id } as const
const call = { kind: 'call', id: 'call:b' } as const
const old = { id: 'step-1', label: 'Old call', state: 'active' as const, target: { taskId: 'call:a' } }
const next = { id: 'step-2', label: 'Later stop', state: 'queued' as const, target: { siteId: 'site:a' } }
const busy = { ...free, plan: [old, next] }
const job = { taskId: 'call:a', label: 'Old call', code: 'P2', freeInS: 30 }

const options: UnitOptions = {
  unitId: free.id, plan: [], busy: null, refused: [{ target: { taskId: 'call:c' }, label: 'Covered', code: 'requirement_covered', text: 'This need is covered' }],
  targets: [{ target: { taskId: call.id }, label: 'New call', verb: 'serve', etaS: 100, canReplace: true, canAdd: true, afterOnly: false }],
}
const assigned: UnitOptions = { ...options, plan: planExpectation(busy.plan), busy: job }
const click = (on: ClickedObject, atMs = 1_000) => ({ kind: 'click' as const, on, atMs })
const selected = (): SelectionState => reduceSelection(initialSelection, click(unit)).state

describe('map-first dispatch', () => {
  test('opening a free unit asks for targets and commits only on the valid target click', () => {
    const opened = reduceSelection(initialSelection, click(unit))
    expect(opened.effects).toEqual([{ kind: 'select', objectId: unit.id }, { kind: 'options', unitId: unit.id }])
    expect(reduceSelection(opened.state, click(call, 1_010), options, free).effects).toEqual([{
      kind: 'submit', job: null, input: { units: [unit.id], stops: [{ taskId: call.id }], expectedPlan: [] },
    }])
    // A tap before the options arrive is answered in the loading state's one word, the card's own notice.
    expect(reduceSelection(opened.state, click(call), null, free).effects).toEqual([{ kind: 'feedback', text: dispatchWords.loadingTargets }])
    expect(reduceSelection(opened.state, click({ kind: 'call', id: 'call:c' }), options, free).effects).toEqual([{ kind: 'feedback', text: 'This need is covered' }])
  })

  test('an accepted first order clears targeting and lets the same unit rearm immediately', () => {
    const opened = selected()
    const finished = reduceSelection(opened, { kind: 'initial-order-accepted', unitId: unit.id })
    expect(finished.effects).toEqual([{ kind: 'select', objectId: null }])
    expect(finished.state.selection.kind).toBe('none')
    const reopened = reduceSelection(finished.state, click(unit, 1_100))
    expect(reopened.effects).toEqual([{ kind: 'select', objectId: unit.id }, { kind: 'options', unitId: unit.id }])
    // A tap on its current call is a target the options read does not list: nothing is removed.
    expect(reduceSelection(reopened.state, click({ kind: 'call', id: 'call:a' }, 1_110), assigned, busy).effects)
      .toEqual([{ kind: 'feedback', text: dispatchWords.targetUnavailable }])
    expect(reduceSelection(opened, { kind: 'initial-order-accepted', unitId: 'unit:other' }).state).toBe(opened)
  })

  test('assigned units ask once, and choosing Cancel or a stale plan sends no order', () => {
    const picked = reduceSelection(selected(), click(call), assigned, busy)
    expect(picked.effects).toEqual([])
    expect(picked.state.selection).toMatchObject({ decision: { kind: 'order', assigned: true, currentLabel: 'Old call' } })
    expect(reduceSelection(picked.state, { kind: 'decide', choice: 'cancel' }, assigned, busy).effects).toEqual([])
    expect(reduceSelection(picked.state, { kind: 'decide', choice: 'replace' }, options, free).effects).toEqual([{ kind: 'feedback', text: dispatchWords.planChanged }])
  })

  test('Replace preserves the observed task and plan; Add appends and drops nothing', () => {
    const picked = reduceSelection(selected(), click(call), assigned, busy).state
    for (const [choice, when, drops] of [['replace', 'now', job.taskId], ['add', 'after', undefined]] as const) {
      expect(reduceSelection(picked, { kind: 'decide', choice }, assigned, busy).effects).toEqual([{
        kind: 'submit', job: drops ? job : null,
        input: { units: [unit.id], stops: [{ taskId: call.id }], when, expectedPlan: assigned.plan, ...(drops ? { drops } : {}) },
      }])
    }
  })

  test('a delivery with no task still asks, and cannot be replaced by an add-only target', () => {
    const delivery = { ...busy, plan: [{ ...old, target: next.target }] }
    const after: UnitOptions = { ...options, plan: planExpectation(delivery.plan), targets: options.targets.map(entry => ({ ...entry, afterOnly: true, canReplace: false })) }
    const picked = reduceSelection(selected(), click(call), after, delivery).state
    expect(picked.selection).toMatchObject({ decision: { assigned: true, replace: false, add: true, job: null } })
    expect(reduceSelection(picked, { kind: 'decide', choice: 'replace' }, after, delivery).effects).toEqual([])
  })

  test('only the × on a plan row asks "Remove stop?", for exactly that stop; a map tap on a target already in the plan is a target, answered by the options read', () => {
    const repeated = { ...busy, plan: [old, { ...next, target: old.target }] }
    const covered: UnitOptions = {
      ...assigned, plan: planExpectation(repeated.plan),
      refused: [{ target: old.target, label: old.label, code: 'requirement_covered', text: 'Old call needs nothing more than A provides' }],
    }
    const tapped = reduceSelection(selected(), click({ kind: 'call', id: 'call:a' }), covered, repeated)
    expect(tapped.effects).toEqual([{ kind: 'feedback', text: 'Old call needs nothing more than A provides' }])
    expect(tapped.state.selection).toEqual({ kind: 'unit', unitId: unit.id })
    const asked = reduceSelection(selected(), { kind: 'stop', stopId: next.id }, covered, repeated)
    expect(asked.effects).toEqual([])
    expect(asked.state.selection).toMatchObject({ decision: { kind: 'remove', stop: { id: next.id, index: 2, label: next.label } } })
    expect(reduceSelection(asked.state, { kind: 'decide', choice: 'replace' }, covered, repeated).effects).toEqual([])
    expect(reduceSelection(asked.state, { kind: 'decide', choice: 'remove' }, covered, repeated).effects).toEqual([{
      kind: 'remove', unitId: unit.id, stopId: next.id, expectedPlan: planExpectation(repeated.plan),
    }])
  })

  test('a tap on the active stop or on a queued stop gets the options read\'s plain answer and sends nothing: the read judges a planned target by adding it only', () => {
    const held: UnitOptions = {
      ...assigned,
      targets: [],
      refused: [
        { target: old.target, label: old.label, code: 'requirement_covered', text: 'Old call needs nothing more than A provides' },
        { target: next.target, label: next.label, code: 'site_not_accepting', text: 'Later stop is not accepting' },
      ],
    }
    for (const [on, text] of [[{ kind: 'call', id: 'call:a' }, 'Old call needs nothing more than A provides'], [{ kind: 'site', id: 'site:a' }, 'Later stop is not accepting']] as const) {
      const tapped = reduceSelection(selected(), click(on), held, busy)
      expect(tapped.effects).toEqual([{ kind: 'feedback', text }])
      expect(tapped.state.selection).toEqual({ kind: 'unit', unitId: unit.id })
    }
    // With load still waiting there, the read offers the planned call for a further trip only: Replace is disabled with its words.
    const further: UnitOptions = { ...assigned, refused: [], targets: [{ target: old.target, label: old.label, verb: 'pick-up', etaS: 0, afterOnly: true, canReplace: false, canAdd: true, replaceRefusal: 'Old call is already in A\'s plan' }] }
    const picked = reduceSelection(selected(), click({ kind: 'call', id: 'call:a' }), further, busy)
    expect(picked.effects).toEqual([])
    expect(picked.state.selection).toMatchObject({ decision: { kind: 'order', replace: false, add: true, replaceReason: 'Old call is already in A\'s plan' } })
    expect(reduceSelection(picked.state, { kind: 'decide', choice: 'replace' }, further, busy).effects).toEqual([])
  })

  test('after an Undo the unit\'s plan no longer matches the options read before it, so a target tap sends nothing until its options are read again', () => {
    // The options were read while the unit held its stop; the Undo took the stop back.
    const undone = { ...busy, plan: [] }
    const stale = reduceSelection(selected(), click(call), assigned, undone)
    expect(stale.effects.filter(effect => effect.kind === 'submit')).toEqual([])
    expect(stale.state.selection).toEqual({ kind: 'unit', unitId: unit.id })
    expect(reduceSelection(selected(), click(call), options, undone).effects).toEqual([{
      kind: 'submit', job: null, input: { units: [unit.id], stops: [{ taskId: call.id }], expectedPlan: [] },
    }])
  })
})
