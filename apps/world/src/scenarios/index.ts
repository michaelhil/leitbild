import { worldPacks } from '../app-assembly.ts'
import { compileScenarioSource } from '../core/scenarios/config.ts'
import { createDirectRoutingAdapter } from '../routing/direct-adapter.ts'
import type { RoutingAdapter } from '../routing/protocol.ts'
export { builtinScenarioSources } from './sources.ts'
import { builtinScenarioSources } from './sources.ts'

export const scenarios = await Promise.all(builtinScenarioSources.map(source =>
  compileScenarioSource(source, worldPacks, { routing: createDirectRoutingAdapter() })))

const osloScenario = scenarios.find(scenario => scenario.id === 'oslo-ambulance')
if (!osloScenario) throw new Error('built-in oslo-ambulance scenario was not loaded')
export const osloAmbulanceScenario = osloScenario
