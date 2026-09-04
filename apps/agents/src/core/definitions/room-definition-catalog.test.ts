import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseScriptMd } from '../scripts/script-md-parser.ts'
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

  test('unstructured control room creates four distinct personas and has a bounded stop', () => {
    const definition = getBundledRoomDefinition('control-room-chaos')!
    const action = definition.deck.entries[0]!.action
    expect(action.kind).toBe('post-message')
    if (action.kind !== 'post-message') throw new Error('wrong action')
    expect(definition.room.agents).toHaveLength(4)
    expect(new Set(definition.room.agents.map(agent => agent.name)).size).toBe(4)
    expect(new Set(definition.room.agents.map(agent => agent.persona)).size).toBe(4)
    expect(action.pauseAfterMs).toBeGreaterThanOrEqual(10_000)
    expect(action.pauseAfterMs).toBeLessThanOrEqual(30_000)
  })

  test('structured control room points at a valid four-person bundled script', () => {
    const definition = getBundledRoomDefinition('control-room-script')!
    const action = definition.deck.entries[0]!.action
    expect(action?.kind).toBe('start-script')
    if (action?.kind !== 'start-script') throw new Error('wrong action')
    const file = resolve(import.meta.dir, '../../../examples/scripts', `${action.scriptName}.md`)
    const script = parseScriptMd(action.scriptName, readFileSync(file, 'utf8'))
    expect(script.cast).toHaveLength(4)
    expect(script.steps).toHaveLength(4)
    expect(script.cast.find(cast => cast.name === 'ProcedureAnalyst')?.tools)
      .toEqual(['procedure_lookup', 'wiki_lookup'])
  })

  test('broadcast-pass control room uses broadcast turn-taking', () => {
    const definition = getBundledRoomDefinition('control-room-broadcast-pass')!
    expect(definition.category).toBe('Turn-Taking Demos')
    const action = definition.deck.entries[0]!.action
    expect(action?.kind).toBe('start-script')
    if (action?.kind !== 'start-script') throw new Error('wrong action')
    const file = resolve(import.meta.dir, '../../../examples/scripts', `${action.scriptName}.md`)
    const script = parseScriptMd(action.scriptName, readFileSync(file, 'utf8'))
    expect(script.turnMode).toBe('broadcast-pass')
    expect(script.cast).toHaveLength(4)
    expect(script.steps).toHaveLength(3)
  })

  test('Halden control room is connected through semantic World Capability grants', () => {
    const definition = getBundledRoomDefinition('halden-integrated-control-room')!
    const operator = definition.room.agents[0]!
    expect(operator.tools).not.toContain('workspace_invoke')
    const exactGrants = operator.toolGrants?.flatMap(grant => 'capabilityId' in grant ? [String(grant.capabilityId)] : [])
    expect(exactGrants).toContain('world.simulation-run.context')
    expect(exactGrants).toContain('world.process-plant.control.write')
    expect(exactGrants).toContain('world.electric-grid.grid.summary')
  })
})
