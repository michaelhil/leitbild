import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { worldPacks } from '../app-assembly.ts'
import { compileScenarioSource, scenarioSourceSchema, type ScenarioSource } from '../core/scenarios/config.ts'
import { createDirectRoutingAdapter } from '../routing/direct-adapter.ts'
import type { RoutingAdapter } from '../routing/protocol.ts'

const scenarioDir = dirname(fileURLToPath(import.meta.url))

const readScenarioSource = (fileName: string): ScenarioSource =>
  scenarioSourceSchema.parse(JSON.parse(readFileSync(join(scenarioDir, fileName), 'utf8')) as unknown)

export const builtinScenarioSources: ReadonlyArray<ScenarioSource> = [
  readScenarioSource('oslo-ambulance.scenario.json'),
  readScenarioSource('oslo-all-packs-demo.scenario.json'),
  readScenarioSource('oslo-drone-operations.scenario.json'),
  readScenarioSource('halden.scenario.json'),
  readScenarioSource('halden-process-plant-demo.scenario.json'),
  readScenarioSource('norway-airspace.scenario.json'),
  readScenarioSource('norway-electric-grid.scenario.json'),
]

export const scenarios = await Promise.all(builtinScenarioSources.map(source =>
  compileScenarioSource(source, worldPacks, { routing: createDirectRoutingAdapter() })))

const osloScenario = scenarios.find(scenario => scenario.id === 'oslo-ambulance')
if (!osloScenario) throw new Error('built-in oslo-ambulance scenario was not loaded')
export const osloAmbulanceScenario = osloScenario
