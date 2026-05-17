import type { ControlInstanceId } from '../src/core/model/index.ts'
import { createScenarioCatalog, type ScenarioCatalog } from '../src/core/scenarios/catalog.ts'
import { ambulancePack } from '../src/packs/ambulance/pack.ts'
import { osloAmbulanceTutorialScenario } from '../src/packs/ambulance/scenario.ts'
import { createLocalAmbulanceSimulationAdapter } from '../src/packs/ambulance/sim/adapter.ts'
import { createLocalTrafficSimulationAdapter } from '../src/packs/traffic/sim/adapter.ts'
import { trafficPack } from '../src/packs/traffic/pack.ts'
import { createDirectRoutingAdapter } from '../src/routing/direct-adapter.ts'
import type { SimulationAdapter, SimulationScenarioRuntimeConfig } from '../src/simulation/protocol.ts'

export const testPacks = [ambulancePack, trafficPack] as const

export const createTestScenarioCatalog = (): ScenarioCatalog => createScenarioCatalog(testPacks)

export const createTestSimulationAdapters = (): ReadonlyArray<SimulationAdapter> => [
  createLocalAmbulanceSimulationAdapter({ routing: createDirectRoutingAdapter() }),
  createLocalTrafficSimulationAdapter(),
]

export const testScenarioRuntimeConfig = (): SimulationScenarioRuntimeConfig => ({
  scenarioId: osloAmbulanceTutorialScenario.id,
  requiredProviderIds: osloAmbulanceTutorialScenario.requiredProviderIds,
  world: osloAmbulanceTutorialScenario.world,
  initialObjects: osloAmbulanceTutorialScenario.initialObjects,
  providerConfigs: osloAmbulanceTutorialScenario.providerConfigs,
  providerConfig: {},
})

export const testControlInstanceId = (suffix: string): ControlInstanceId =>
  `control-instance:${suffix}` as ControlInstanceId

