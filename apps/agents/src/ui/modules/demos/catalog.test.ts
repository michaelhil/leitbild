import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseScriptMd } from '../../../core/scripts/script-md-parser.ts'
import { DEMO_CATALOG, getDemo } from '../../../core/definitions/demo-catalog.ts'

describe('control-room demo catalog', () => {
  test('ids are unique and every action has the content it needs', () => {
    const ids = DEMO_CATALOG.map(d => d.id)
    expect(new Set(ids).size).toBe(ids.length)

    for (const demo of DEMO_CATALOG) {
      expect(demo.deck.entries.length).toBeGreaterThan(0)
      for (const entry of demo.deck.entries) {
        if (entry.action.kind === 'start-script') {
          expect(entry.action.scriptName.length).toBeGreaterThan(0)
        } else {
          expect(entry.action.content.length).toBeGreaterThan(0)
        }
      }
    }
  })

  test('unstructured demo creates four distinct personas and has a bounded stop', () => {
    const demo = getDemo('control-room-chaos')!
    const action = demo.deck.entries[0]!.action
    expect(action.kind).toBe('post-message')
    if (action.kind !== 'post-message') throw new Error('wrong action')

    expect(demo.room.agents).toHaveLength(4)
    expect(new Set(demo.room.agents.map(a => a.name)).size).toBe(4)
    expect(new Set(demo.room.agents.map(a => a.persona)).size).toBe(4)
    expect(action.pauseAfterMs).toBeGreaterThanOrEqual(10_000)
    expect(action.pauseAfterMs).toBeLessThanOrEqual(30_000)
  })

  test('structured demo points at a valid four-person bundled script', () => {
    const demo = getDemo('control-room-script')!
    const action = demo.deck.entries[0]!.action
    expect(action?.kind).toBe('start-script')
    if (action?.kind !== 'start-script') throw new Error('wrong action')

    const file = resolve(process.cwd(), 'examples', 'scripts', `${action.scriptName}.md`)
    const script = parseScriptMd(action.scriptName, readFileSync(file, 'utf8'))
    expect(script.cast).toHaveLength(4)
    expect(script.steps).toHaveLength(4)
    expect(script.cast.find(c => c.name === 'ProcedureAnalyst')?.tools)
      .toEqual(['procedure_lookup', 'wiki_lookup'])
  })

  test('broadcast-pass demo uses broadcast turn-taking and the Turn-Taking category', () => {
    const demo = getDemo('control-room-broadcast-pass')!
    expect(demo.category).toBe('Turn-Taking Demos')
    const action = demo.deck.entries[0]!.action
    expect(action?.kind).toBe('start-script')
    if (action?.kind !== 'start-script') throw new Error('wrong action')

    const file = resolve(process.cwd(), 'examples', 'scripts', `${action.scriptName}.md`)
    const script = parseScriptMd(action.scriptName, readFileSync(file, 'utf8'))
    expect(script.turnMode).toBe('broadcast-pass')
    expect(script.cast).toHaveLength(4)
    expect(script.steps).toHaveLength(3)
  })
})
