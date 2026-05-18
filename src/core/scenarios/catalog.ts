import type { MissionDefinition, OperationalObject, ScenarioDefinition } from '../model/index.ts'
import { missionDefinitionSchema, scenarioDefinitionSchema } from '../model/index.ts'
import type { LeitbildPack } from '../packs/protocol.ts'

export interface ResolvedScenarioProvider {
  readonly packId: string
  readonly providerId: string
  readonly providerConfig: unknown
}

export interface ResolvedScenarioRuntime {
  readonly scenarioId: string
  readonly providers: ReadonlyArray<ResolvedScenarioProvider>
  readonly initialObjects: ReadonlyArray<OperationalObject>
  readonly providerConfigs: Record<string, unknown>
  readonly scenario: ScenarioDefinition
}

export interface ScenarioCatalog {
  readonly listScenarios: () => ReadonlyArray<ScenarioDefinition>
  readonly getScenario: (id: string) => ScenarioDefinition | undefined
  readonly initialObjectsFor: (id: string) => ReadonlyArray<OperationalObject> | undefined
  readonly runtimeFor: (id: string) => ResolvedScenarioRuntime | undefined
  readonly defaultScenarioId: () => string
  readonly listMissions: () => ReadonlyArray<MissionDefinition>
  readonly getMission: (id: string) => MissionDefinition | undefined
}

export const createScenarioCatalog = (config: {
  readonly packs: ReadonlyArray<LeitbildPack>
  readonly scenarios: ReadonlyArray<ScenarioDefinition>
  readonly missions?: ReadonlyArray<MissionDefinition>
}): ScenarioCatalog => {
  const scenarios = new Map<string, ScenarioDefinition>()
  const missions = new Map<string, MissionDefinition>()
  const packs = new Map<string, LeitbildPack>()

  for (const pack of config.packs) {
    if (packs.has(pack.id)) throw new Error(`duplicate pack id: ${pack.id}`)
    packs.set(pack.id, pack)
  }

  for (const missionCandidate of config.missions ?? []) {
    const mission = missionDefinitionSchema.parse(missionCandidate) as MissionDefinition
    if (missions.has(mission.id)) throw new Error(`duplicate mission id: ${mission.id}`)
    missions.set(mission.id, mission)
  }

  const validateScenario = (scenario: ScenarioDefinition): void => {
    if (scenario.packs.length === 0) throw new Error(`scenario ${scenario.id} must declare at least one pack`)
    const objectIds = new Set<string>(scenario.initialObjects.map(object => object.id))
    if (objectIds.size !== scenario.initialObjects.length) throw new Error(`scenario ${scenario.id} has duplicate initial object ids`)
    const unknownContextObjectIds = scenario.initialContexts
      .map(initialContext => initialContext.objectId)
      .filter(objectId => !objectIds.has(objectId))
    if (unknownContextObjectIds.length > 0) {
      throw new Error(`scenario ${scenario.id} has contexts for unknown objects: ${unknownContextObjectIds.join(', ')}`)
    }
    for (const packId of scenario.packs) {
      const pack = packs.get(packId)
      if (!pack) throw new Error(`scenario ${scenario.id} references unknown pack: ${packId}`)
      const providerId = scenario.providerOverrides[packId] ?? pack.defaultSimulationProviderId
      if (!providerId) throw new Error(`scenario ${scenario.id} pack ${packId} has no default simulation provider`)
      const providers = pack.simulationProviders ?? []
      if (!providers.some(provider => provider.id === providerId)) {
        throw new Error(`scenario ${scenario.id} provider ${providerId} is not registered by pack ${packId}`)
      }
    }
    for (const packId of Object.keys(scenario.providerOverrides)) {
      if (!scenario.packs.includes(packId)) throw new Error(`scenario ${scenario.id} has provider override for inactive pack: ${packId}`)
    }
    for (const packId of Object.keys(scenario.providerConfigs)) {
      if (!scenario.packs.includes(packId)) throw new Error(`scenario ${scenario.id} has provider config for inactive pack: ${packId}`)
    }
  }

  for (const scenarioCandidate of config.scenarios) {
    const scenario = scenarioDefinitionSchema.parse(scenarioCandidate) as ScenarioDefinition
    validateScenario(scenario)
    if (scenarios.has(scenario.id)) throw new Error(`duplicate scenario id: ${scenario.id}`)
    scenarios.set(scenario.id, scenario)
  }

  for (const scenario of scenarios.values()) {
    if (scenario.missionId && !missions.has(scenario.missionId)) {
      throw new Error(`scenario ${scenario.id} references unknown mission ${scenario.missionId}`)
    }
  }

  const sortedScenarios = (): ReadonlyArray<ScenarioDefinition> =>
    [...scenarios.values()].sort((left, right) => left.id.localeCompare(right.id))

  const sortedMissions = (): ReadonlyArray<MissionDefinition> =>
    [...missions.values()].sort((left, right) => left.id.localeCompare(right.id))

  const applyInitialContexts = (scenario: ScenarioDefinition): ReadonlyArray<OperationalObject> => {
    const contextsByObjectId = new Map(scenario.initialContexts.map(initialContext => [initialContext.objectId, initialContext.context]))
    return scenario.initialObjects.map(object => {
      const context = contextsByObjectId.get(object.id)
      return context ? { ...object, context } : object
    })
  }

  return {
    listScenarios: sortedScenarios,
    getScenario: (id: string): ScenarioDefinition | undefined => scenarios.get(id),
    initialObjectsFor: (id: string): ReadonlyArray<OperationalObject> | undefined => {
      const scenario = scenarios.get(id)
      if (!scenario) return undefined
      return applyInitialContexts(scenario)
    },
    runtimeFor: (id: string): ResolvedScenarioRuntime | undefined => {
      const scenario = scenarios.get(id)
      if (!scenario) return undefined
      const initialObjects = applyInitialContexts(scenario)
      const providers = scenario.packs.map(packId => {
        const pack = packs.get(packId)
        if (!pack?.defaultSimulationProviderId && scenario.providerOverrides[packId] === undefined) {
          throw new Error(`scenario ${scenario.id} pack ${packId} has no default simulation provider`)
        }
        const providerId = scenario.providerOverrides[packId] ?? pack!.defaultSimulationProviderId!
        return {
          packId,
          providerId,
          providerConfig: scenario.providerConfigs[packId] ?? {},
        }
      })
      return {
        scenarioId: scenario.id,
        scenario,
        providers,
        initialObjects,
        providerConfigs: Object.fromEntries(providers.map(provider => [provider.providerId, provider.providerConfig])),
      }
    },
    defaultScenarioId: (): string => {
      const first = sortedScenarios()[0]
      if (!first) throw new Error('scenario catalog has no scenarios')
      return first.id
    },
    listMissions: sortedMissions,
    getMission: (id: string): MissionDefinition | undefined => missions.get(id),
  }
}
