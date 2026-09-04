import { describe, expect, test } from 'bun:test'
import { BUNDLED_ROOM_DEFINITIONS, getBundledRoomDefinition } from './room-definition-catalog.ts'

describe('bundled Room Definitions', () => {
  test('ids are unique and every Prompt Deck action has the content it needs', () => {
    const ids = BUNDLED_ROOM_DEFINITIONS.map(definition => definition.id)
    expect(new Set(ids).size).toBe(ids.length)

    for (const definition of BUNDLED_ROOM_DEFINITIONS) {
      expect(definition.deck.entries.length).toBeGreaterThan(0)
      for (const entry of definition.deck.entries) {
        if (entry.action.kind === 'start-script') expect(entry.action.scriptName.length).toBeGreaterThan(0)
        else expect(entry.action.content.length).toBeGreaterThan(0)
      }
    }
  })

  test('ships only explicit Workspace and Run assistance definitions', () => {
    expect(BUNDLED_ROOM_DEFINITIONS.map(definition => definition.id).sort()).toEqual([
      'leitbild-assistant',
      'simulation-assistant',
    ])
    expect(getBundledRoomDefinition('leitbild-assistant')?.assistance).toEqual({ kind: 'workspace' })
    const runAssistance = getBundledRoomDefinition('simulation-assistant')?.assistance
    expect(runAssistance?.kind).toBe('resource')
    expect(runAssistance?.kind === 'resource' ? String(runAssistance.resourceType) : undefined)
      .toBe('world.run-family')
  })

  test('Run assistance grants live selected-subject reads and writes without pinning Run ids', () => {
    const definition = getBundledRoomDefinition('simulation-assistant')!
    const assistant = definition.room.agents[0]!
    expect(assistant.includeContext).toEqual({ participants: true, activity: false, knownAgents: false })
    expect(assistant.toolGrants).toEqual([{ scope: 'room-subject', risks: ['read', 'write'] }])
    expect(definition.room).not.toHaveProperty('subjectSelection')
  })
})
