import type { SimulationRunId } from '../src/core/model/index.ts'
import { createScenarioRuntimeResolver, type ScenarioRuntimeResolver } from '../src/core/scenarios/runtime-resolver.ts'
import { ambulancePack } from '../src/packs/ambulance/pack.ts'
import { aviationPack } from '../src/packs/aviation/pack.ts'
import { testScenarioSources, responseScenario, scenarios } from './fixtures/scenarios.ts'
import { compileScenarioSource } from '../src/core/scenarios/config.ts'
import { scenarioAuthoringCatalogFor } from '../src/core/scenarios/authoring.ts'
import { createLocalAmbulancePackRuntimeAdapter } from '../src/packs/ambulance/sim/adapter.ts'
import { createVatsimPackRuntimeAdapter } from '../src/packs/aviation/sim/vatsim/adapter.ts'
import { createAviationMultiPackRuntimeAdapter } from '../src/packs/aviation/sim/multi/adapter.ts'
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
import type { PackRuntimeAdapter, PackRuntimeConnectionConfig, PackScenarioRuntimeConfig } from '../src/simulation/protocol.ts'

export const testPacks = [ambulancePack, trafficPack, weatherPack, dronePack, processPlantPack, aviationPack, electricGridPack] as const

export const createTestScenarioRuntimeResolver = (): ScenarioRuntimeResolver => createScenarioRuntimeResolver({
  packs: testPacks,
})

export const testScenarioAuthoring = () => ({
  scenarioSources: testScenarioSources,
  compileScenarioSource: (source: unknown) => compileScenarioSource(source, testPacks, { routing: createDirectRoutingAdapter() }),
  scenarioAuthoringCatalog: scenarioAuthoringCatalogFor(testPacks),
})

export const createTestPackRuntimeAdapters = (): ReadonlyArray<PackRuntimeAdapter> => {
  const vatsim = createVatsimPackRuntimeAdapter()
  return [
    createLocalAmbulancePackRuntimeAdapter({ routing: createDirectRoutingAdapter() }),
    createLocalTrafficPackRuntimeAdapter(),
    createLocalWeatherPackRuntimeAdapter(),
    createDroneNativePackRuntimeAdapter(),
    createLocalProcessPlantPackRuntimeAdapter(),
    createLocalElectricGridPackRuntimeAdapter(),
    vatsim,
    createAviationMultiPackRuntimeAdapter({ vatsim, defaultSource: 'vatsim' }),
  ]
}

export const testScenarioRuntimeConfig = (): PackScenarioRuntimeConfig => {
  const runtime = createTestScenarioRuntimeResolver().resolve(responseScenario)
  if (!runtime) throw new Error(`missing test scenario runtime: ${responseScenario.id}`)
  return {
    scenarioId: runtime.scenarioId,
    runtimeIds: runtime.runtimes.map(runtime => runtime.runtimeId),
    connections: [],
    world: runtime.scenario.world,
    initialObjects: runtime.initialObjects,
    runtimeConfigByRuntimeId: runtime.runtimeConfigByRuntimeId,
    runtimeConfig: {},
  }
}

export const testSimulationRunId = (suffix: string): SimulationRunId =>
  `run-${suffix}` as SimulationRunId

export const testRuntimeConnectionConfig = (config: {
  readonly simulationRunId: SimulationRunId
  readonly runtimeIds: ReadonlyArray<string>
  readonly initialObjects?: PackScenarioRuntimeConfig['initialObjects']
  readonly runtimeConfig?: unknown
}): PackRuntimeConnectionConfig => ({
  simulationRunId: config.simulationRunId,
  scenario: {
    scenarioId: 'scenario:test-runtime',
    runtimeIds: config.runtimeIds,
    connections: [],
    world: { startsAt: '2026-01-01T00:00:00.000Z' as PackScenarioRuntimeConfig['world']['startsAt'], environment: { mode: 'test' } },
    initialObjects: config.initialObjects ?? [],
    runtimeConfig: config.runtimeConfig ?? {},
  },
  ...(config.initialObjects === undefined ? {} : { initialObjects: config.initialObjects }),
})

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
