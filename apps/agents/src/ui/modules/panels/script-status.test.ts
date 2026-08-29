import { describe, expect, test } from 'bun:test'
import type { ActiveScript } from '../stores.ts'
import { buildScriptStatusSnapshot } from './script-status.ts'

const active = (overrides: Partial<ActiveScript> = {}): ActiveScript => ({
  scriptId: 's1', scriptName: 'demo', title: 'Demo', stepIndex: 1,
  totalSteps: 2, stepTitle: 'Compare evidence', readiness: { Alex: true, Sam: false },
  readyStreak: { Alex: 2, Sam: 0 }, whisperFailures: 0, lastWhisper: {},
  stepLogs: {
    1: [
      { speaker: 'Alex', content: 'one', messageId: 'm1', whispersByCast: {} },
      { speaker: 'Director', content: 'context', messageId: 'm2', whispersByCast: {} },
      { speaker: 'Alex', content: 'two', messageId: 'm3', whispersByCast: {} },
    ],
  },
  cast: [
    { id: 'a', name: 'Alex', model: 'gpt-5.4', persona: '', starts: true },
    { id: 'b', name: 'Sam', model: 'gpt-5.4', persona: '', starts: false },
  ],
  steps: [
    { title: 'Gather', roles: {} },
    { title: 'Compare evidence', goal: 'Find the best-supported path', roles: {} },
  ],
  ended: false,
  ...overrides,
})

describe('buildScriptStatusSnapshot', () => {
  test('counts cast utterances only and preserves readiness', () => {
    const snapshot = buildScriptStatusSnapshot(active())
    expect(snapshot.stepIndex).toBe(1)
    expect(snapshot.stepTitle).toBe('Compare evidence')
    expect(snapshot.goal).toBe('Find the best-supported path')
    expect(snapshot.rows).toEqual([
      { name: 'Alex', utterances: 2, ready: true, readyStreak: 2 },
      { name: 'Sam', utterances: 0, ready: false, readyStreak: 0 },
    ])
  })

  test('completed runs show the final step and complete state', () => {
    const snapshot = buildScriptStatusSnapshot(active({ ended: true, stepIndex: 2, stepTitle: '(complete)' }))
    expect(snapshot.complete).toBe(true)
    expect(snapshot.stepIndex).toBe(1)
    expect(snapshot.stepTitle).toBe('Complete')
    expect(snapshot.rows[0]?.ready).toBe(true)
  })
})
