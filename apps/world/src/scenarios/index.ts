import type { ScenarioDefinition } from '../core/model/index.ts'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { worldPacks } from '../app-assembly.ts'
import { scenarioDefinitionFromConfig } from '../core/scenarios/config.ts'
import { createDirectRoutingAdapter } from '../routing/direct-adapter.ts'
import type { RoutingAdapter } from '../routing/protocol.ts'

const scenarioDir = dirname(fileURLToPath(import.meta.url))

const readScenarioConfig = (fileName: string): unknown =>
  JSON.parse(readFileSync(join(scenarioDir, fileName), 'utf8')) as unknown

export const createBuiltinScenarios = async (
  routing: RoutingAdapter,
): Promise<ReadonlyArray<ScenarioDefinition>> => [
  await scenarioDefinitionFromConfig(readScenarioConfig('oslo-ambulance.scenario.json'), worldPacks, { routing }),
  await scenarioDefinitionFromConfig(readScenarioConfig('oslo-all-packs-demo.scenario.json'), worldPacks, { routing }),
  await scenarioDefinitionFromConfig(readScenarioConfig('oslo-drone-operations.scenario.json'), worldPacks, { routing }),
  await scenarioDefinitionFromConfig(readScenarioConfig('halden.scenario.json'), worldPacks, { routing }),
  await scenarioDefinitionFromConfig(readScenarioConfig('halden-process-plant-demo.scenario.json'), worldPacks, { routing }),
  await scenarioDefinitionFromConfig(readScenarioConfig('norway-airspace.scenario.json'), worldPacks, { routing }),
  await scenarioDefinitionFromConfig(readScenarioConfig('norway-electric-grid.scenario.json'), worldPacks, { routing }),
]

export const scenarios: ReadonlyArray<ScenarioDefinition> = await createBuiltinScenarios(createDirectRoutingAdapter())

const osloScenario = scenarios.find(scenario => scenario.id === 'oslo-ambulance')
if (!osloScenario) throw new Error('built-in oslo-ambulance scenario was not loaded')
export const osloAmbulanceScenario: ScenarioDefinition = osloScenario
