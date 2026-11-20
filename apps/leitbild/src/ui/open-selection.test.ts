import { describe, expect, test } from 'bun:test'
import { moduleQueryOutcomeSchema, moduleResourceDescriptorSchema, type ModuleQueryOutcome } from '@leitbild/contracts'
import { addressedRunAndPlanning, keptSelection, planningDemoQuery, planningFrameQuery } from './open-selection.ts'
import { room, run, WS } from './workspace-page.test-support.ts'

const outcomes = (...values: unknown[]): ModuleQueryOutcome[] => values.map(value => moduleQueryOutcomeSchema.parse(value))
const ready = outcomes({ moduleId: 'world', status: 'ready' }, { moduleId: 'agents', status: 'ready' })
const worldFailed = outcomes(
  { moduleId: 'world', status: 'failed', failure: { code: 'module_unavailable', message: 'World did not answer', retryable: true } },
  { moduleId: 'agents', status: 'ready' },
)
const open = { world: 'a', agents: null, agentsVisible: false }

describe('what stays open after the Resources are read again', () => {
  test('a Run that is still listed stays open', () => {
    expect(keptSelection(open, [run('a', 'Running', '2026-10-12T21:00:00.000Z')], ready)).toEqual(open)
  })

  test('a missing Run closes when every Module answered', () => {
    expect(keptSelection(open, [run('b', 'Running', '2026-10-12T21:00:00.000Z')], ready)).toEqual({ world: null, agents: null, agentsVisible: false })
  })

  test('a Module that failed to answer keeps its Run open', () => {
    expect(keptSelection(open, [], worldFailed)).toEqual(open)
  })

  test('a missing room closes and hides the Agents pane; a failed World does not close it', () => {
    const chatting = { world: null, agents: 'c', agentsVisible: true }
    expect(keptSelection(chatting, [], ready)).toEqual({ world: null, agents: null, agentsVisible: false })
    expect(keptSelection(chatting, [room('c', '2026-10-12T21:30:00.000Z')], worldFailed)).toEqual(chatting)
  })

  test('nothing open stays nothing open', () => {
    const none = { world: null, agents: null, agentsVisible: false }
    expect(keptSelection(none, [], ready)).toEqual(none)
  })

  test('Planning closes a deleted plan only after its Module answered; its library stays available', () => {
    const planning = { world: null, agents: null, agentsVisible: false, planning: 'plan-1' }
    const available = outcomes(...ready, { moduleId: 'planning', status: 'ready' })
    const failed = outcomes(...ready, { moduleId: 'planning', status: 'failed', failure: { code: 'module_unavailable', message: 'Planning did not answer', retryable: true } })
    expect(keptSelection(planning, [], available).planning).toBeNull()
    expect(keptSelection(planning, [], failed).planning).toBe('plan-1')
    const listed = (type: string) => moduleResourceDescriptorSchema.parse({
      ref: { workspaceId: WS, moduleId: 'planning', type, id: 'plan-1' }, title: 'Week 47', capabilityIds: [], observedAt: '2026-11-11T10:00:00.000Z',
    })
    expect(keptSelection(planning, [listed('planning.plan')], available).planning).toBe('plan-1')
    // A retired Study of the same id is not a plan.
    expect(keptSelection(planning, [listed('planning.study')], available).planning).toBeNull()
    expect(keptSelection({ ...planning, planning: 'library' }, [], available).planning).toBe('library')
    expect(keptSelection({ ...planning, planning: 'library' }, [], ready).planning).toBeNull()
    expect(keptSelection({ ...planning, planning: 'demo' }, [], available).planning).toBe('demo')
    expect(keptSelection({ ...planning, planning: 'demo' }, [], ready).planning).toBeNull()
  })

  test('a Run and its plans stay open together; each closes on its own Module\'s answer', () => {
    const available = outcomes(...ready, { moduleId: 'planning', status: 'ready' })
    const plan = moduleResourceDescriptorSchema.parse({
      ref: { workspaceId: WS, moduleId: 'planning', type: 'planning.plan', id: 'plan-1' }, title: 'Week 47', capabilityIds: [], observedAt: '2026-11-11T10:00:00.000Z',
    })
    const listedRun = run('a', 'Running', '2026-10-12T21:00:00.000Z')
    const beside = { world: 'a', agents: null, agentsVisible: false, planning: 'library' }
    expect(keptSelection(beside, [listedRun], available)).toEqual(beside)
    expect(keptSelection({ ...beside, planning: 'plan-1' }, [listedRun, plan], available)).toEqual({ ...beside, planning: 'plan-1' })
    // A deleted plan closes and leaves the Run open; a deleted Run closes and leaves Planning open.
    expect(keptSelection({ ...beside, planning: 'plan-1' }, [listedRun], available)).toEqual({ ...beside, planning: null })
    expect(keptSelection(beside, [], available)).toEqual({ ...beside, world: null })
  })
})

describe('what an address opens', () => {
  const opened = (search: string) => addressedRunAndPlanning(new URLSearchParams(search))

  test('a Run and Planning open together: the Run with its plans', () => {
    expect(opened('world=run-1&planning=library')).toEqual({ world: 'run-1', planning: 'library' })
    expect(opened('world=run-1&planning=plan-1&agents=room-1')).toEqual({ world: 'run-1', planning: 'plan-1' })
    expect(opened('world=run-1')).toEqual({ world: 'run-1', planning: null })
    expect(opened('planning=library')).toEqual({ world: null, planning: 'library' })
    expect(opened('')).toEqual({ world: null, planning: null })
  })

  test('the guided demo opens no Run in the page, as before', () => {
    expect(opened('planning=demo&definition=two-deliveries&run=run-1')).toEqual({ world: null, planning: 'demo' })
    expect(opened('world=run-1&planning=demo&definition=two-deliveries&run=run-1')).toEqual({ world: null, planning: 'demo' })
  })
})

describe('the Planning frame\'s address', () => {
  const query = (open: Partial<Parameters<typeof planningFrameQuery>[0]>) =>
    planningFrameQuery({ planning: null, demoQuery: null, world: null, agents: null, ...open })

  test('beside a Run it names the Run, then the plan and the Assistant\'s room', () => {
    expect(query({ world: 'run-1', planning: 'library' })).toBe('run=run-1')
    expect(query({ world: 'run-1', planning: 'plan-1' })).toBe('run=run-1&plan=plan-1')
    expect(query({ world: 'run-1', planning: 'plan-1', agents: 'room-1' })).toBe('run=run-1&plan=plan-1&agents=room-1')
    expect(query({ world: 'run-1', planning: 'library', agents: 'room-1' })).toBe('run=run-1&agents=room-1')
  })

  test('without a Run, and for the guided demo, it is as before; without Planning there is none', () => {
    expect(query({ planning: 'library' })).toBe('')
    expect(query({ planning: 'plan-1' })).toBe('plan=plan-1')
    expect(query({ planning: 'plan-1', agents: 'room-1' })).toBe('plan=plan-1&agents=room-1')
    expect(query({ planning: 'demo', demoQuery: 'demo=two-deliveries&run=run-1' })).toBe('demo=two-deliveries&run=run-1')
    expect(query({ planning: 'demo', demoQuery: 'demo=two-deliveries&run=run-1', agents: 'room-1' })).toBe('demo=two-deliveries&run=run-1&agents=room-1')
    expect(query({ planning: 'demo' })).toBeNull()
    expect(query({ world: 'run-1' })).toBeNull()
    expect(query({})).toBeNull()
  })
})

test('Planning demo links forward only the Definition and Run for the demo view', () => {
  expect(planningDemoQuery(new URLSearchParams('planning=demo&definition=two-deliveries&run=run-1&extra=1'))).toBe('demo=two-deliveries&run=run-1')
  expect(planningDemoQuery(new URLSearchParams('planning=library&definition=two-deliveries&run=run-1'))).toBeNull()
  expect(planningDemoQuery(new URLSearchParams('planning=demo&definition=two-deliveries'))).toBeNull()
  expect(planningDemoQuery(new URLSearchParams('planning=demo&definition=%2Ffoo&run=run-1'))).toBeNull()
  expect(planningDemoQuery(new URLSearchParams('planning=demo&definition=nuclear-maintenance-planning&run=run-1&option=option-2&agents=room-1'))).toBe('demo=nuclear-maintenance-planning&run=run-1&option=option-2')
  expect(planningDemoQuery(new URLSearchParams('planning=demo&definition=nuclear-maintenance-planning&run=run-1&option=%2Finvalid'))).toBe('demo=nuclear-maintenance-planning&run=run-1')
})
