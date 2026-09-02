import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { scenarioSourceSchema, type ScenarioSource } from '../core/scenarios/config.ts'

const scenarioDir = dirname(fileURLToPath(import.meta.url))

export const discoverScenarioSources = (directory: string): ReadonlyArray<ScenarioSource> => {
  const ids = new Set<string>()
  return readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.scenario.json'))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(entry => {
      const source = scenarioSourceSchema.parse(JSON.parse(readFileSync(join(directory, entry.name), 'utf8')) as unknown)
      if (ids.has(source.id)) throw new Error(`duplicate bundled Scenario: ${source.id}`)
      ids.add(source.id)
      return source
    })
}

export const builtinScenarioSources = discoverScenarioSources(scenarioDir)
