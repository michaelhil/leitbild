import { describe, expect, test } from 'bun:test'
import { advance, at, emptyState, first, low, middle, newTask, newUnit, refusalOf, run, runAll, second, send, start, taskOf, templates, third, top, types, unitOf } from '../fixtures/engine-harness.ts'
import { needsFrom, roleViewOf, taskPriorityOf } from './coverage.ts'
import type { EngineState } from './model.ts'
import { isFree } from './rules.ts'

const far = (index: number) => at(0.05 * (index + 1), 0.02)

/**
 * The divert-protection scenario: A1 en route to TOP1 (first priority); A2
 * en route to C9 (second); A3 on task at LOW3 (third); A4 en route to C20
 * (first); A6 en route to LOW6 (third). Every unit carries one load of any
 * class; load says nothing of priority.
 */
const protectionScenario = async (): Promise<EngineState> => {
  let state = await runAll(emptyState(), [
    ...['a1', 'a2', 'a3', 'a4', 'a6'].map((id, index) => newUnit(id, types.roadCarrier, at(0.001 * index))),
    newTask('top1', templates.load, far(0), { [low]: 1 }, { priority: first }),
    newTask('c9', templates.load, far(1), { [low]: 1 }, { priority: second }),
    newTask('low3', templates.load, at(0.002), { [top]: 1 }),
    newTask('c20', templates.load, far(2), { [low]: 1, [middle]: 1 }, { priority: first }),
    newTask('low6', templates.load, far(3), { [top]: 1 }),
  ])
  state = await runAll(state, [
    send(['a1'], { taskId: 'top1' }),
    send(['a2'], { taskId: 'c9' }),
    send(['a3'], { taskId: 'low3' }),
    send(['a4'], { taskId: 'c20' }),
    send(['a6'], { taskId: 'low6' }),
  ])
  return await advance(state, start + 3_000)
}

describe('Einsatz divert protection', () => {
  test('the scenario stands as described', async () => {
    const state = await protectionScenario()
    expect(['a1', 'a2', 'a3', 'a4', 'a6'].map(id => unitOf(state, id).phase)).toEqual(['en-route', 'en-route', 'on-task', 'en-route', 'en-route'])
    expect(['top1', 'c9', 'low3', 'c20', 'low6'].map(id => taskOf(state, id).priority)).toEqual([first, second, third, first, third])
    expect([...state.units.values()].filter(isFree)).toEqual([])
  })

  test('a busy unit is ordered only with when, and now names the task it drops', async () => {
    const state = await run(await protectionScenario(), newTask('n1', templates.load, at(0.003), { [low]: 1 }, { priority: first }))
    expect(await refusalOf(state, send(['a2'], { taskId: 'n1' }))).toEqual({ code: 'when_required', reason: expect.stringMatching(/^when_required: A2 is busy with C9, free in about \d+:\d\d: say when, "after" its current job, or "now", dropping C9$/) })
    expect((await refusalOf(state, send(['a2', 'a6'], { taskId: 'n1' }, 'c9'))).reason).toBe('when_required: A2, A6 are busy: order a busy unit on its own, saying when')
    expect((await refusalOf(state, send(['a2'], { taskId: 'n1' }, 'low6'))).reason).toBe('drops_mismatch: A2 works for C9 (c9): name it in drops to take A2 off it')
  })

  test('a divert comes from equal or lower priority only, before arrival; an equal priority is the caller\'s decision', async () => {
    const state = await run(await protectionScenario(), newTask('n2', templates.load, at(0.003), { [low]: 1 }, { priority: second }))
    expect((await refusalOf(state, send(['a1'], { taskId: 'n2' }, 'top1'))).reason).toBe('divert_from_higher_priority: TOP1 (Q1) is more urgent than N2 (Q2)')
    expect((await refusalOf(state, send(['a3'], { taskId: 'n2' }, 'low3'))).code).toBe('divert_after_arrival')
    expect(unitOf(await run(state, send(['a2'], { taskId: 'n2' }, 'c9')), 'a2')).toMatchObject({ taskId: 'n2', lastAction: { verb: 'divert' } })
    expect(unitOf(await run(state, send(['a6'], { taskId: 'n2' }, 'low6')), 'a6')).toMatchObject({ taskId: 'n2' })
  })

  test('a divert returns the work it leaves with its age', async () => {
    let state = await run(await protectionScenario(), newTask('n1', templates.load, at(0.003), { [top]: 1 }, { priority: first }))
    state = await run(state, send(['a2'], { taskId: 'n1' }, 'c9'))
    expect(unitOf(state, 'a2')).toMatchObject({ taskId: 'n1', phase: 'en-route', lastAction: { verb: 'divert', target: 'n1', cause: 'from C9' } })
    expect(taskOf(state, 'c9')).toMatchObject({ createdAtMs: start, loads: { [low]: 1 }, alerts: [{ code: 'work_returned' }] })
    expect(taskOf(state, 'c9').coverage.loads).toEqual([{ classId: low, waiting: 1, covered: 0 }])
    expect(taskOf(state, 'n1').coverage.loads).toEqual([{ classId: top, waiting: 1, covered: 1 }])
  })
})

describe('Einsatz carriers of different load classes', () => {
  /** A carrier of any class at the task and a carrier of the top class only further away; the task holds one top and one low load. */
  const mixed = () => runAll(emptyState(), [
    newUnit('near', types.roadCarrier, at(0)),
    newUnit('solo', types.narrowCarrier, at(0.01)),
    newTask('t1', templates.load, at(0), { [top]: 1, [low]: 1 }),
  ])
  const bothCovered = [{ classId: top, waiting: 1, covered: 1 }, { classId: low, waiting: 1, covered: 1 }]

  test('a send is judged the same whichever order it names its units in', async () => {
    const state = await mixed()
    for (const units of [['near', 'solo'], ['solo', 'near']]) expect(taskOf(await run(state, send(units, { taskId: 't1' })), 't1').coverage.loads).toEqual(bothCovered)
  })

  test('a unit that would add nothing beside the rest of the send is refused, whichever position it holds', async () => {
    const state = await run(await mixed(), newUnit('spare', types.narrowCarrier, at(0.02)))
    for (const units of [['spare', 'near', 'solo'], ['near', 'solo', 'spare']]) {
      expect((await refusalOf(state, send(units, { taskId: 't1' }))).code).toBe('requirement_covered')
    }
  })

  test('each carrier picks up the load coverage allocated to it, though the any-class carrier arrives first, and the task closes', async () => {
    let state = await run(await mixed(), send(['near', 'solo'], { taskId: 't1' }))
    expect(taskOf(state, 't1').coverage.loads).toEqual(bothCovered)
    state = await advance(state, start + 6_000)
    expect(unitOf(state, 'near')).toMatchObject({ phase: 'holding', load: { [low]: 1 } })
    expect(unitOf(state, 'solo')).toMatchObject({ phase: 'en-route', taskId: 't1' })
    expect(taskOf(state, 't1')).toMatchObject({ loads: { [top]: 1 }, coverage: { loads: [{ classId: top, waiting: 1, covered: 1 }] } })
    state = await advance(state, start + 30_000)
    expect(unitOf(state, 'solo').load).toEqual({ [top]: 1 })
    expect(taskOf(state, 't1')).toMatchObject({ loads: {}, pickedUp: { [top]: 1, [low]: 1 }, alerts: [] })
    expect(taskOf(state, 't1').closedAtMs).toBeDefined()
  })
})

describe('Einsatz priority and need', () => {
  test('a task takes the priority it names, else its template\'s, else the lowest; load never changes it', async () => {
    let state = await runAll(emptyState(), [
      newTask('floored', templates.payload, at(0), { [low]: 1 }),
      newTask('named', templates.payload, at(0), { [top]: 1 }, { priority: first }),
      newTask('bare', templates.load, at(0), { [top]: 1 }),
      newUnit('u1', types.directCarrier, at(0)),
    ])
    expect(['floored', 'named', 'bare'].map(id => taskOf(state, id).priority)).toEqual([second, first, third])
    expect(taskPriorityOf(state.catalog, templates.load, undefined)).toBe(third)
    state = await run(state, send(['u1'], { taskId: 'bare' }))
    state = await advance(state, start + 3_000)
    expect(taskOf(state, 'bare').priority).toBe(third)
  })

  test('need follows what the role can serve; an open report needs attention', async () => {
    const state = await runAll(emptyState(), [
      newUnit('g1', types.pairServer, at(0)),
      newUnit('c1', types.roadCarrier, at(0)),
      newTask('pair', templates.pair, at(0.01)),
      newTask('note', templates.report, at(0.01)),
      newTask('mixed', templates.load, at(0.01), { [middle]: 1, [low]: 1 }),
    ])
    const servers = roleViewOf(state.catalog, [unitOf(state, 'g1')])
    const carriers = roleViewOf(state.catalog, [unitOf(state, 'c1')])
    const needs = (id: string, view: typeof servers) => needsFrom(state.catalog, taskOf(state, id), taskOf(state, id).coverage, view)
    expect(needs('pair', servers)).toBe(true)
    expect(needs('pair', carriers)).toBe(false)
    expect(needs('note', carriers)).toBe(true)
    expect(needs('mixed', carriers)).toBe(true)
    expect(needs('mixed', servers)).toBe(false)
  })
})

describe('Einsatz coverage and eligibility', () => {
  test('a requirement counts only units meeting its where; the reason is in property words', async () => {
    let state = await runAll(emptyState(), [
      newUnit('c1', types.roadCarrier, at(0)),
      newUnit('d1', types.directCarrier, at(0)),
      newTask('r1', templates.lift, at(0.01)),
    ])
    const short = await refusalOf(state, send(['c1'], { taskId: 'r1' }))
    expect(short.reason).toBe('requirement_unmet: C1 · Lift 400 kg · needs ≥ 500 kg')
    expect((await refusalOf(state, send(['d1'], { taskId: 'r1' }))).reason).toBe('requirement_unmet: Lift not declared on Flyer')
    state = await run(state, { kind: 'unit.adjust', unitId: 'c1', properties: { liftKg: 600 }, reason: 'Refitted' })
    expect(unitOf(state, 'c1').lastAction).toMatchObject({ verb: 'adjust', cause: 'Refitted' })
    state = await run(state, send(['c1'], { taskId: 'r1' }))
    expect(taskOf(state, 'r1').coverage.requirements).toEqual([{ provides: 'aid', count: 1, enRoute: 1, onTask: 0, completed: 0 }])
    const lowered = await refusalOf(state, { kind: 'unit.adjust', unitId: 'c1', properties: { liftKg: 450 }, reason: 'Damaged' })
    expect(lowered.reason).toBe('requirement_unmet: R1: C1 · Lift 450 kg · needs ≥ 500 kg')
    expect((await refusalOf(state, send(['d1'], { taskId: 'r1' }))).code).toBe('requirement_unmet')
  })

  test('a counted requirement is sent all or nothing and refuses units beyond its count', async () => {
    let state = await runAll(emptyState(), [
      newUnit('g1', types.pairServer, at(0)),
      newUnit('g2', types.pairServer, at(0)),
      newUnit('g3', types.pairServer, at(0)),
      newUnit('c1', types.roadCarrier, at(0)),
      newTask('pair', templates.pair, at(0.01)),
    ])
    expect((await refusalOf(state, send(['g1', 'c1'], { taskId: 'pair' }))).reason).toBe('requirement_unmet: C1 provides nothing PAIR needs')
    expect(unitOf(state, 'g1').taskId).toBeUndefined()
    state = await run(state, send(['g1', 'g2'], { taskId: 'pair' }))
    expect(taskOf(state, 'pair').coverage.requirements[0]).toMatchObject({ enRoute: 2, completed: 0 })
    expect((await refusalOf(state, send(['g3'], { taskId: 'pair' }))).reason).toBe('requirement_covered: PAIR needs nothing more that G3 provides')
    state = await advance(state, start + 120_000)
    expect(taskOf(state, 'pair')).toMatchObject({ served: { guard: 2 } })
    expect(taskOf(state, 'pair').closedAtMs).toBeDefined()
  })

  test('a point move never commits a unit; a unit sent to a task is busy', async () => {
    let state = await runAll(emptyState(), [
      newUnit('u1', types.roadCarrier, at(0)),
      newTask('t1', templates.load, at(0.01), { [low]: 1 }),
    ])
    state = await run(state, send(['u1'], { point: at(0.02) }))
    expect(unitOf(state, 'u1')).toMatchObject({ phase: 'en-route', lastAction: { verb: 'move' } })
    expect(isFree(unitOf(state, 'u1'))).toBe(true)
    state = await run(state, send(['u1'], { taskId: 't1' }))
    expect(unitOf(state, 'u1')).toMatchObject({ phase: 'en-route', taskId: 't1' })
    expect(isFree(unitOf(state, 'u1'))).toBe(false)
    expect(taskOf(state, 't1').coverage.loads).toEqual([{ classId: low, waiting: 1, covered: 1 }])
  })
})
