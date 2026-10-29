import { describe, expect, test } from 'bun:test'
import { BUNDLED_ROOM_DEFINITIONS, getBundledRoomDefinition, roomDefinitionSchema } from './room-definition-catalog.ts'

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

  test('ships one Assistant definition whose Room Scope is selected at creation', () => {
    expect(BUNDLED_ROOM_DEFINITIONS.map(definition => definition.id)).toEqual(['leitbild-assistant'])
    expect(getBundledRoomDefinition('leitbild-assistant')?.assistance).toBe(true)
  })

  test('Assistant configuration carries no duplicated access policy', () => {
    const definition = getBundledRoomDefinition('leitbild-assistant')!
    const assistant = definition.room.agents[0]!
    expect(assistant.includeContext).toEqual({ participants: true, activity: false, knownAgents: false })
    expect(assistant.tools).toEqual(['product_search', 'product_read', 'place_resolve', 'wiki_lookup'])
    // Check-ins are optional operator configuration, not a hidden task quota.
    expect(assistant.maxToolIterations).toBeUndefined()
    expect(assistant).not.toHaveProperty('toolGrants')
    expect(definition.room).not.toHaveProperty('scope')
  })

  test('an authored check-in threshold accepts any positive integer without a fifty-round ceiling', () => {
    const definition = getBundledRoomDefinition('leitbild-assistant')!
    const withThreshold = (maxToolIterations: number) => ({ ...definition, room: { ...definition.room,
      agents: [{ ...definition.room.agents[0]!, maxToolIterations }],
    } })
    for (const threshold of [51, 1_000, Number.MAX_SAFE_INTEGER]) {
      expect(roomDefinitionSchema.parse(withThreshold(threshold)).room.agents[0]!.maxToolIterations).toBe(threshold)
    }
    for (const threshold of [0, -1, 1.5, Infinity, NaN]) {
      expect(roomDefinitionSchema.safeParse(withThreshold(threshold)).success).toBe(false)
    }
  })
})
