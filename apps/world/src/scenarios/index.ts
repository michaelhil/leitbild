import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { worldPacks } from '../app-assembly.ts'
import { scenarioTemplateFromDraft, type ScenarioTemplate } from '../core/scenarios/config.ts'
import { createDirectRoutingAdapter } from '../routing/direct-adapter.ts'
import type { RoutingAdapter } from '../routing/protocol.ts'

const scenarioDir = dirname(fileURLToPath(import.meta.url))

const readScenarioDraft = (fileName: string): unknown =>
  JSON.parse(readFileSync(join(scenarioDir, fileName), 'utf8')) as unknown

export const createBuiltinScenarioTemplates = async (
  routing: RoutingAdapter,
): Promise<ReadonlyArray<ScenarioTemplate>> => [
  await scenarioTemplateFromDraft(readScenarioDraft('oslo-ambulance.scenario.json'), worldPacks, { routing }),
  await scenarioTemplateFromDraft(readScenarioDraft('oslo-all-packs-demo.scenario.json'), worldPacks, { routing }),
  await scenarioTemplateFromDraft(readScenarioDraft('oslo-drone-operations.scenario.json'), worldPacks, { routing }),
  await scenarioTemplateFromDraft(readScenarioDraft('halden.scenario.json'), worldPacks, { routing }),
  await scenarioTemplateFromDraft(readScenarioDraft('halden-process-plant-demo.scenario.json'), worldPacks, { routing }),
  await scenarioTemplateFromDraft(readScenarioDraft('norway-airspace.scenario.json'), worldPacks, { routing }),
  await scenarioTemplateFromDraft(readScenarioDraft('norway-electric-grid.scenario.json'), worldPacks, { routing }),
]

export const scenarioTemplates = await createBuiltinScenarioTemplates(createDirectRoutingAdapter())
export const scenarios = scenarioTemplates.map(template => template.definition)

const osloScenario = scenarios.find(scenario => scenario.id === 'oslo-ambulance')
if (!osloScenario) throw new Error('built-in oslo-ambulance scenario was not loaded')
export const osloAmbulanceScenario = osloScenario
