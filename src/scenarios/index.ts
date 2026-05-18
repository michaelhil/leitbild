import type { ScenarioDefinition } from '../core/model/index.ts'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { scenarioDefinitionFromConfig } from '../core/scenarios/config.ts'
import { ambulancePack } from '../packs/ambulance/pack.ts'
import { trafficPack } from '../packs/traffic/pack.ts'

const scenarioDir = dirname(fileURLToPath(import.meta.url))

const readScenarioConfig = (fileName: string): unknown =>
  JSON.parse(readFileSync(join(scenarioDir, fileName), 'utf8')) as unknown

export const osloAmbulanceScenario: ScenarioDefinition = scenarioDefinitionFromConfig(
  readScenarioConfig('oslo-ambulance.scenario.json'),
  [ambulancePack, trafficPack],
)

export const scenarios: ReadonlyArray<ScenarioDefinition> = [
  osloAmbulanceScenario,
]
