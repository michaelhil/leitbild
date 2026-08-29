import type { SimulationRunId } from '../src/core/model/index.ts'
import { createScenarioCatalog, type ScenarioCatalog } from '../src/core/scenarios/catalog.ts'
import { ambulancePack } from '../src/packs/ambulance/pack.ts'
import { aviationPack } from '../src/packs/aviation/pack.ts'
import { osloAmbulanceScenario, scenarios } from '../src/scenarios/index.ts'
import { createLocalAmbulancePackRuntimeAdapter } from '../src/packs/ambulance/sim/adapter.ts'
import { createAviationNoopPackRuntimeAdapter } from '../src/packs/aviation/sim/noop-adapter.ts'
import { createLocalTrafficPackRuntimeAdapter } from '../src/packs/traffic/sim/adapter.ts'
import { trafficPack } from '../src/packs/traffic/pack.ts'
import { createLocalWeatherPackRuntimeAdapter } from '../src/packs/weather/sim/adapter.ts'
import { weatherPack } from '../src/packs/weather/pack.ts'
import { processPlantPack } from '../src/packs/process-plant/pack.ts'
import { createLocalProcessPlantPackRuntimeAdapter } from '../src/packs/process-plant/sim/adapter.ts'
import { dronePack } from '../src/packs/drone/pack.ts'
import { createDroneNativePackRuntimeAdapter } from '../src/packs/drone/native/adapter.ts'
import { electricGridPack } from '../src/packs/electric-grid/pack.ts'
import { createLocalElectricGridPackRuntimeAdapter } from '../src/packs/electric-grid/sim/adapter.ts'
import { createDirectRoutingAdapter } from '../src/routing/direct-adapter.ts'
import type { PackRuntimeAdapter, PackScenarioRuntimeConfig } from '../src/simulation/protocol.ts'
import { builtinMissions } from '../src/scenarios/index.ts'

export const testPacks = [ambulancePack, trafficPack, weatherPack, dronePack, processPlantPack, aviationPack, electricGridPack] as const

export const createTestScenarioCatalog = (): ScenarioCatalog => createScenarioCatalog({
  packs: testPacks,
  scenarios,
  missions: builtinMissions,
  defaultScenarioId: osloAmbulanceScenario.id,
})

export const createTestPackRuntimeAdapters = (): ReadonlyArray<PackRuntimeAdapter> => [
  createLocalAmbulancePackRuntimeAdapter({ routing: createDirectRoutingAdapter() }),
  createAviationNoopPackRuntimeAdapter(),
  createLocalTrafficPackRuntimeAdapter(),
  createLocalWeatherPackRuntimeAdapter(),
  createDroneNativePackRuntimeAdapter(),
  createLocalProcessPlantPackRuntimeAdapter(),
  createLocalElectricGridPackRuntimeAdapter(),
]

export const testScenarioRuntimeConfig = (): PackScenarioRuntimeConfig => {
  const runtime = createTestScenarioCatalog().runtimeFor(osloAmbulanceScenario.id)
  if (!runtime) throw new Error(`missing test scenario runtime: ${osloAmbulanceScenario.id}`)
  return {
    scenarioId: runtime.scenarioId,
    runtimeIds: runtime.runtimes.map(runtime => runtime.runtimeId),
    world: runtime.scenario.world,
    initialObjects: runtime.initialObjects,
    runtimeConfigs: runtime.runtimeConfigs,
    runtimeConfig: {},
  }
}

export const testSimulationRunId = (suffix: string): SimulationRunId =>
  `run-${suffix}` as SimulationRunId

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
