import type { ControlInstanceId } from '../src/core/model/index.ts'
import { createScenarioCatalog, type ScenarioCatalog } from '../src/core/scenarios/catalog.ts'
import { ambulancePack } from '../src/packs/ambulance/pack.ts'
import { aviationPack } from '../src/packs/aviation/pack.ts'
import { osloAmbulanceScenario, scenarios } from '../src/scenarios/index.ts'
import { createLocalAmbulanceSimulationAdapter } from '../src/packs/ambulance/sim/adapter.ts'
import { createAviationNoopSimulationAdapter } from '../src/packs/aviation/sim/noop-adapter.ts'
import { createLocalTrafficSimulationAdapter } from '../src/packs/traffic/sim/adapter.ts'
import { trafficPack } from '../src/packs/traffic/pack.ts'
import { createLocalWeatherSimulationAdapter } from '../src/packs/weather/sim/adapter.ts'
import { weatherPack } from '../src/packs/weather/pack.ts'
import { processPlantPack } from '../src/packs/process-plant/pack.ts'
import { createLocalProcessPlantSimulationAdapter } from '../src/packs/process-plant/sim/adapter.ts'
import { createDirectRoutingAdapter } from '../src/routing/direct-adapter.ts'
import type { SimulationAdapter, SimulationScenarioRuntimeConfig } from '../src/simulation/protocol.ts'

export const testPacks = [ambulancePack, trafficPack, weatherPack, processPlantPack, aviationPack] as const

export const createTestScenarioCatalog = (): ScenarioCatalog => createScenarioCatalog({
  packs: testPacks,
  scenarios,
  defaultScenarioId: osloAmbulanceScenario.id,
})

export const createTestSimulationAdapters = (): ReadonlyArray<SimulationAdapter> => [
  createLocalAmbulanceSimulationAdapter({ routing: createDirectRoutingAdapter() }),
  createAviationNoopSimulationAdapter(),
  createLocalTrafficSimulationAdapter(),
  createLocalWeatherSimulationAdapter(),
  createLocalProcessPlantSimulationAdapter(),
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

export const waitForCondition = async (
  label: string,
  condition: () => boolean,
  options?: {
    readonly timeoutMs?: number
    readonly intervalMs?: number
  },
): Promise<void> => {
  const timeoutMs = options?.timeoutMs ?? 3_000
  const intervalMs = options?.intervalMs ?? 25
  const startedAt = Date.now()

  while (Date.now() - startedAt <= timeoutMs) {
    if (condition()) return
    await Bun.sleep(intervalMs)
  }

  throw new Error(`timed out waiting for condition: ${label}`)
}
