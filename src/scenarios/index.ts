import type { ScenarioDefinition } from '../core/model/index.ts'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { scenarioDefinitionFromConfig } from '../core/scenarios/config.ts'
import { ambulancePack } from '../packs/ambulance/pack.ts'
import { trafficPack } from '../packs/traffic/pack.ts'
import { weatherPack } from '../packs/weather/pack.ts'
import { createDirectRoutingAdapter } from '../routing/direct-adapter.ts'
import type { RoutingAdapter } from '../routing/protocol.ts'

const scenarioDir = dirname(fileURLToPath(import.meta.url))

const readScenarioConfig = (fileName: string): unknown =>
  JSON.parse(readFileSync(join(scenarioDir, fileName), 'utf8')) as unknown

const packs = [ambulancePack, trafficPack, weatherPack]

export const createBuiltinScenarios = async (
  routing: RoutingAdapter,
): Promise<ReadonlyArray<ScenarioDefinition>> => [
  await scenarioDefinitionFromConfig(readScenarioConfig('oslo-ambulance.scenario.json'), packs, { routing }),
  await scenarioDefinitionFromConfig(readScenarioConfig('halden.scenario.json'), packs, { routing }),
]

export const scenarios: ReadonlyArray<ScenarioDefinition> = await createBuiltinScenarios(createDirectRoutingAdapter())

const osloScenario = scenarios.find(scenario => scenario.id === 'oslo-ambulance')
if (!osloScenario) throw new Error('built-in oslo-ambulance scenario was not loaded')
export const osloAmbulanceScenario: ScenarioDefinition = osloScenario
