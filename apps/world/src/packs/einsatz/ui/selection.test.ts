import { describe, expect, test } from 'bun:test'
import { initialSelection, planExpectation, reduceSelection, type ClickedObject, type SelectionState } from './selection.ts'
import type { UnitOptions } from '../situation/schema.ts'

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
    expect(reduceSelection(opened.state, click(call), null, free).effects[0]?.kind).toBe('feedback')
    expect(reduceSelection(opened.state, click({ kind: 'call', id: 'call:c' }), options, free).effects).toEqual([{ kind: 'feedback', text: 'This need is covered' }])
  })

  test('an accepted first order clears targeting and lets the same unit rearm immediately', () => {
    const opened = selected()
    const finished = reduceSelection(opened, { kind: 'initial-order-accepted', unitId: unit.id })
    expect(finished.effects).toEqual([{ kind: 'select', objectId: null }])
    expect(finished.state.selection.kind).toBe('none')
    const reopened = reduceSelection(finished.state, click(unit, 1_100))
    expect(reopened.effects).toEqual([{ kind: 'select', objectId: unit.id }, { kind: 'options', unitId: unit.id }])
    expect(reduceSelection(reopened.state, click({ kind: 'call', id: 'call:a' }, 1_110), assigned, busy).state.selection)
      .toMatchObject({ decision: { kind: 'remove', stops: [{ id: old.id }] } })
    expect(reduceSelection(opened, { kind: 'initial-order-accepted', unitId: 'unit:other' }).state).toBe(opened)
  })

  test('assigned units ask once, and choosing Cancel or a stale plan sends no order', () => {
    const picked = reduceSelection(selected(), click(call), assigned, busy)
    expect(picked.effects).toEqual([])
    expect(picked.state.selection).toMatchObject({ decision: { kind: 'order', assigned: true, currentLabel: 'Old call' } })
    expect(reduceSelection(picked.state, { kind: 'decide', choice: 'cancel' }, assigned, busy).effects).toEqual([])
    expect(reduceSelection(picked.state, { kind: 'decide', choice: 'replace' }, options, free).effects).toEqual([{ kind: 'feedback', text: 'The plan changed. Pick the target again.' }])
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

  test('a repeated red target asks which exact stop to remove', () => {
    const repeated = { ...busy, plan: [old, { ...next, target: old.target }] }
    const selectedStop = reduceSelection(selected(), click({ kind: 'call', id: 'call:a' }), null, repeated)
    expect(selectedStop.state.selection).toMatchObject({ decision: { kind: 'remove', stops: [{ id: old.id, index: 1 }, { id: next.id, index: 2 }] } })
    expect(reduceSelection(selectedStop.state, { kind: 'decide', choice: { remove: next.id } }, null, repeated).effects).toEqual([{
      kind: 'remove', unitId: unit.id, stopId: next.id, expectedPlan: planExpectation(repeated.plan),
    }])
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
