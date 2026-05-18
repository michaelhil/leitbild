import type { ControlInstanceId } from '../src/core/model/index.ts'
import { createScenarioCatalog, type ScenarioCatalog } from '../src/core/scenarios/catalog.ts'
import { ambulancePack } from '../src/packs/ambulance/pack.ts'
import { osloAmbulanceScenario, scenarios } from '../src/scenarios/index.ts'
import { createLocalAmbulanceSimulationAdapter } from '../src/packs/ambulance/sim/adapter.ts'
import { createLocalTrafficSimulationAdapter } from '../src/packs/traffic/sim/adapter.ts'
import { trafficPack } from '../src/packs/traffic/pack.ts'
import { createDirectRoutingAdapter } from '../src/routing/direct-adapter.ts'
import type { SimulationAdapter, SimulationScenarioRuntimeConfig } from '../src/simulation/protocol.ts'

export const testPacks = [ambulancePack, trafficPack] as const

export const createTestScenarioCatalog = (): ScenarioCatalog => createScenarioCatalog({
  packs: testPacks,
  scenarios,
  defaultScenarioId: osloAmbulanceScenario.id,
})

export const createTestSimulationAdapters = (): ReadonlyArray<SimulationAdapter> => [
  createLocalAmbulanceSimulationAdapter({ routing: createDirectRoutingAdapter() }),
  createLocalTrafficSimulationAdapter(),
]

export const testScenarioRuntimeConfig = (): SimulationScenarioRuntimeConfig => {
  const runtime = createTestScenarioCatalog().runtimeFor(osloAmbulanceScenario.id)
  if (!runtime) throw new Error(`missing test scenario runtime: ${osloAmbulanceScenario.id}`)
  return {
    scenarioId: runtime.scenarioId,
    providerIds: runtime.providers.map(provider => provider.providerId),
    world: runtime.scenario.world,
    initialObjects: runtime.initialObjects,
    providerConfigs: runtime.providerConfigs,
    providerConfig: {},
  }
}

export const testControlInstanceId = (suffix: string): ControlInstanceId =>
  `control-instance:${suffix}` as ControlInstanceId
