import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { builtinScenarioSources, discoverScenarioSources } from '../src/scenarios/sources.ts'

describe('bundled scenario discovery', () => {
  test('ships the editable power-complex and weather-response definitions', () => {
    expect(builtinScenarioSources.map(source => source.id)).toEqual([
      'halden-power-complex',
      'halden-weather-response',
    ])
    expect(builtinScenarioSources[0]?.packs.map(pack => pack.id)).toEqual(['process-plant', 'electric-grid'])
  })
  test('accepts an empty catalog and discovers new files without a registry edit', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'leitbild-scenario-discovery-'))
    try {
      expect(discoverScenarioSources(directory)).toEqual([])
      const source = builtinScenarioSources[0]!
      await writeFile(join(directory, 'z.scenario.json'), JSON.stringify({ ...source, id: 'last' }))
      await writeFile(join(directory, 'a.scenario.json'), JSON.stringify({ ...source, id: 'first' }))
      expect(discoverScenarioSources(directory).map(entry => entry.id)).toEqual(['first', 'last'])
      await writeFile(join(directory, 'duplicate.scenario.json'), JSON.stringify({ ...source, id: 'first' }))
      expect(() => discoverScenarioSources(directory)).toThrow('duplicate bundled Scenario')
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
})
