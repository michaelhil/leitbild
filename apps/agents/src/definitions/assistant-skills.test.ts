import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { createSkillStore, loadSkills } from '../skills/loader.ts'
import { createToolRegistry } from '../core/tool-registry.ts'
import assistantRoom from './leitbild-assistant.room.json'

// Skills are injected in full into every prompt of the agents that select
// them, so their size is an attention budget, not just a storage detail.
const OPERATOR_DISPLAYS_BODY_MAX_CHARS = 4_800
const DESCRIPTION_MAX_CHARS = 1_024

describe('Leitbild Assistant skills', () => {
  test('every selected skill exists and the display skill stays within its prompt budget', async () => {
    const store = createSkillStore()
    await loadSkills(join(import.meta.dir, '..', '..', 'skills'), store, createToolRegistry())
    for (const name of assistantRoom.room.agents[0]!.skills) expect(store.get(name)).toBeDefined()
    const displays = store.get('operator-displays')!
    expect(displays.description.length).toBeLessThanOrEqual(DESCRIPTION_MAX_CHARS)
    expect(displays.body.length).toBeLessThanOrEqual(OPERATOR_DISPLAYS_BODY_MAX_CHARS)
    expect(displays.body).toContain('world.process-plant.display.compose')
    expect(displays.body).toContain('```leitbild-view\nview <viewRef>\n```')
  })
})
