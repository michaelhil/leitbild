import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { scenarioSourceSchema, type ScenarioSource } from '../core/scenarios/config.ts'

const scenarioDir = dirname(fileURLToPath(import.meta.url))

const readScenarioSource = (fileName: string): ScenarioSource =>
  scenarioSourceSchema.parse(JSON.parse(readFileSync(join(scenarioDir, fileName), 'utf8')) as unknown)

export const builtinScenarioSources: ReadonlyArray<ScenarioSource> = [
  readScenarioSource('oslo-ambulance.scenario.json'),
  readScenarioSource('oslo-integrated-operations.scenario.json'),
  readScenarioSource('oslo-drone-operations.scenario.json'),
  readScenarioSource('halden.scenario.json'),
  readScenarioSource('halden-process-plant-demo.scenario.json'),
  readScenarioSource('halden-four-unit-grid.scenario.json'),
  readScenarioSource('norway-airspace.scenario.json'),
  readScenarioSource('norway-electric-grid.scenario.json'),
]
