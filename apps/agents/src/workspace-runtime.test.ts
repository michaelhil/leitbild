// ============================================================================
// AgentsWorkspaceRuntime.resetState tests.
//
// resetState backs the `reset_system` MCP tool.
// It clears rooms and agents; preserves tool registry + skills + provider
// state. Covered by a positive path + name-reuse path; the subprocess-level
// integration is exercised end-to-end by experiments/batch-reset.test.ts
// under SOAK=1.
// ============================================================================

import { describe, test, expect } from 'bun:test'
import { createAgentsWorkspaceRuntime } from './workspace-runtime.ts'
import { SYSTEM_SENDER_ID } from './core/types/constants.ts'
import { createHumanAgent } from './agents/human-agent.ts'

describe('AgentsWorkspaceRuntime.resetState', () => {
  test('clears rooms and agents, returns counts, preserves infrastructure', async () => {
    const system = createAgentsWorkspaceRuntime()

    // Seed state: 2 rooms, 2 human agents (no LLM traffic needed).
    system.rooms.createRoom({ name: 'alpha', createdBy: SYSTEM_SENDER_ID })
    system.rooms.createRoom({ name: 'bravo', createdBy: SYSTEM_SENDER_ID })

    const a = createHumanAgent({ name: 'Alice' }, () => {})
    const b = createHumanAgent({ name: 'Bob' }, () => {})
    system.team.addAgent(a)
    system.team.addAgent(b)

    const toolCountBefore = system.toolRegistry.list().length

    const result = await system.resetState()

    expect(result.rooms).toBe(2)
    expect(result.agents).toBe(2)

    // State is empty after reset
    expect(system.rooms.listAllRooms()).toHaveLength(0)
    expect(system.team.listAgents()).toHaveLength(0)

    // Infrastructure preserved
    expect(system.toolRegistry.list().length).toBe(toolCountBefore)
  })

  test('name re-use after reset — re-create agents/rooms with the same names', async () => {
    const system = createAgentsWorkspaceRuntime()

    system.rooms.createRoom({ name: 'trial', createdBy: SYSTEM_SENDER_ID })
    const agent1 = createHumanAgent({ name: 'solver' }, () => {})
    system.team.addAgent(agent1)

    await system.resetState()

    // Re-create with the SAME names — must succeed (no stale name lingering)
    expect(() => system.rooms.createRoom({ name: 'trial', createdBy: SYSTEM_SENDER_ID })).not.toThrow()
    const agent2 = createHumanAgent({ name: 'solver' }, () => {})
    expect(() => system.team.addAgent(agent2)).not.toThrow()

    expect(system.team.getAgent('solver')?.id).toBe(agent2.id)
    expect(system.team.getAgent('solver')?.id).not.toBe(agent1.id)
  })
})

describe('lateBinding warn-once', () => {
  test('warns once when a slot fires unsubscribed; stays silent after', () => {
    const warnings: string[] = []
    const origWarn = console.warn
    console.warn = (...args: unknown[]) => { warnings.push(args.join(' ')) }

    try {
      const system = createAgentsWorkspaceRuntime({ workspaceLabel: 'test-Workspace' })
      // Use `bookmarksChanged` — wired into house callbacks but with no
      // internal subscribers (wire-workspace-runtime-events would normally set one;
      // tests skip that). Firing it without a subscriber should warn once.
      //
      // (The original version of this test fired `messagePosted` via room.post
      // — but other in-process subscribers (summary scheduler, etc.) listen
      // there, so that slot is no longer "unsubscribed" by default.)
      system.bookmarks.add('first')
      system.bookmarks.add('second')
      system.bookmarks.add('third')

      const slotWarnings = warnings.filter(w => w.includes('bookmarksChanged'))
      expect(slotWarnings.length).toBe(1)
      expect(slotWarnings[0]).toContain('test-Workspace')
      expect(slotWarnings[0]).toContain('first event dropped')
    } finally {
      console.warn = origWarn
    }
  })

  test('stays silent once a subscriber is set', () => {
    const warnings: string[] = []
    const origWarn = console.warn
    console.warn = (...args: unknown[]) => { warnings.push(args.join(' ')) }

    try {
      const system = createAgentsWorkspaceRuntime({ workspaceLabel: 'test-2' })
      // Set the subscriber BEFORE any event — no warning should fire.
      system.setOnMessagePosted(() => { /* ok */ })
      const room = system.rooms.createRoom({ name: 'lb-test-2', createdBy: SYSTEM_SENDER_ID })
      const human = createHumanAgent({ name: 'Trigger2' }, () => {})
      system.team.addAgent(human)
      room.post({ senderId: human.id, content: 'hi', type: 'chat' })

      expect(warnings.filter(w => w.includes('messagePosted'))).toEqual([])
    } finally {
      console.warn = origWarn
    }
  })
})
