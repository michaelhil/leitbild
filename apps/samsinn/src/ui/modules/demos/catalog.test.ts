import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseScriptMd } from '../../../core/scripts/script-md-parser.ts'
import { DEMO_CATALOG, getDemo } from './catalog.ts'

describe('control-room demo catalog', () => {
  test('ids are unique and every action has the content it needs', () => {
    const ids = DEMO_CATALOG.map(d => d.id)
    expect(new Set(ids).size).toBe(ids.length)

    for (const demo of DEMO_CATALOG) {
      expect(demo.prompts.length).toBeGreaterThan(0)
      for (const prompt of demo.prompts) {
        if (prompt.action?.kind === 'start-script') {
          expect(prompt.action.scriptName.length).toBeGreaterThan(0)
        } else {
          expect(prompt.prompt?.length ?? 0).toBeGreaterThan(0)
        }
      }
    }
  })

  test('unstructured demo creates four distinct personas and has a bounded stop', () => {
    const demo = getDemo('control-room-chaos')!
    const action = demo.prompts[0]!.action
    expect(action?.kind).toBe('spawn-broadcast')
    if (action?.kind !== 'spawn-broadcast') throw new Error('wrong action')

    expect(action.agents).toHaveLength(4)
    expect(new Set(action.agents.map(a => a.name)).size).toBe(4)
    expect(new Set(action.agents.map(a => a.persona)).size).toBe(4)
    expect(action.autoPauseAfterMs).toBeGreaterThanOrEqual(10_000)
    expect(action.autoPauseAfterMs).toBeLessThanOrEqual(30_000)
  })

  test('structured demo points at a valid four-person bundled script', () => {
    const demo = getDemo('control-room-script')!
    const action = demo.prompts[0]!.action
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
    const action = demo.prompts[0]!.action
    expect(action?.kind).toBe('start-script')
    if (action?.kind !== 'start-script') throw new Error('wrong action')

    const file = resolve(process.cwd(), 'examples', 'scripts', `${action.scriptName}.md`)
    const script = parseScriptMd(action.scriptName, readFileSync(file, 'utf8'))
    expect(script.turnMode).toBe('broadcast-pass')
    expect(script.cast).toHaveLength(4)
    expect(script.steps).toHaveLength(3)
  })
})
