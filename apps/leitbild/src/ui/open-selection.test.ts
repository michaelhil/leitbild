import { describe, expect, test } from 'bun:test'
import { moduleQueryOutcomeSchema, moduleResourceDescriptorSchema, type ModuleQueryOutcome } from '@leitbild/contracts'
import { keptSelection, planningDemoQuery } from './open-selection.ts'
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
})

test('Planning demo links forward only the Definition and Run for the demo view', () => {
  expect(planningDemoQuery(new URLSearchParams('planning=demo&definition=two-deliveries&run=run-1&extra=1'))).toBe('demo=two-deliveries&run=run-1')
  expect(planningDemoQuery(new URLSearchParams('planning=library&definition=two-deliveries&run=run-1'))).toBeNull()
  expect(planningDemoQuery(new URLSearchParams('planning=demo&definition=two-deliveries'))).toBeNull()
  expect(planningDemoQuery(new URLSearchParams('planning=demo&definition=%2Ffoo&run=run-1'))).toBeNull()
})
