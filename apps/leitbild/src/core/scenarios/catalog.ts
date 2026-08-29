import type { MissionDefinition, OperationalObject, ScenarioDefinition } from '../model/index.ts'
import { missionDefinitionSchema, scenarioDefinitionSchema } from '../model/index.ts'
import type { LeitbildPack } from '../packs/protocol.ts'

export interface ResolvedPackRuntime {
  readonly packId: string
  readonly runtimeId: string
  readonly runtimeConfig: unknown
}

export interface ResolvedScenarioRuntime {
  readonly scenarioId: string
  readonly packs: ReadonlyArray<LeitbildPack>
  readonly runtimes: ReadonlyArray<ResolvedPackRuntime>
  readonly initialObjects: ReadonlyArray<OperationalObject>
  readonly runtimeConfigs: Record<string, unknown>
  readonly scenario: ScenarioDefinition
}

export interface ScenarioCatalog {
  readonly listScenarios: () => ReadonlyArray<ScenarioDefinition>
  readonly getScenario: (id: string) => ScenarioDefinition | undefined
  readonly initialObjectsFor: (id: string) => ReadonlyArray<OperationalObject> | undefined
  readonly runtimeFor: (id: string) => ResolvedScenarioRuntime | undefined
  readonly runtimeForDefinition: (scenario: ScenarioDefinition) => ResolvedScenarioRuntime
  readonly defaultScenarioId: () => string
  readonly listMissions: () => ReadonlyArray<MissionDefinition>
  readonly getMission: (id: string) => MissionDefinition | undefined
}

export const createScenarioCatalog = (config: {
  readonly packs: ReadonlyArray<LeitbildPack>
  readonly scenarios: ReadonlyArray<ScenarioDefinition>
  readonly missions?: ReadonlyArray<MissionDefinition>
  readonly defaultScenarioId?: string
}): ScenarioCatalog => {
  const scenarios = new Map<string, ScenarioDefinition>()
  const missions = new Map<string, MissionDefinition>()
  const packs = new Map<string, LeitbildPack>()

  for (const pack of config.packs) {
    if (packs.has(pack.descriptor.id)) throw new Error(`duplicate pack id: ${pack.descriptor.id}`)
    packs.set(pack.descriptor.id, pack)
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
      const runtimeId = scenario.runtimeOverrides[packId] ?? pack.runtime?.defaultRuntimeId
      if (!runtimeId) throw new Error(`scenario ${scenario.id} pack ${packId} has no default pack runtime`)
      const runtimes = pack.runtime?.runtimes ?? []
      if (!runtimes.some(runtime => runtime.id === runtimeId)) {
        throw new Error(`scenario ${scenario.id} runtime ${runtimeId} is not registered by pack ${packId}`)
      }
    }
    for (const packId of Object.keys(scenario.runtimeOverrides)) {
      if (!scenario.packs.includes(packId)) throw new Error(`scenario ${scenario.id} has runtime override for inactive pack: ${packId}`)
    }
    for (const packId of Object.keys(scenario.runtimeConfigs)) {
      if (!scenario.packs.includes(packId)) throw new Error(`scenario ${scenario.id} has runtime config for inactive pack: ${packId}`)
    }
    const processSystemIds = new Set<string>()
    for (const processSystem of scenario.processSystems) {
      if (processSystemIds.has(processSystem.id)) {
        throw new Error(`scenario ${scenario.id} has duplicate process system id: ${processSystem.id}`)
      }
      processSystemIds.add(processSystem.id)
      if (!scenario.packs.includes(processSystem.pack)) {
        throw new Error(`scenario ${scenario.id} has process system ${processSystem.id} for inactive pack: ${processSystem.pack}`)
      }
    }
    const activeCategoryIds = new Set(
      scenario.packs.flatMap(packId => packs.get(packId)?.presentation.categories.map(category => category.id) ?? []),
    )
    for (const region of scenario.surface.regions) {
      if (region.primitive !== 'objectRail') continue
      const sectionCategoryIds = new Set<string>()
      for (const section of region.config.sections) {
        if (sectionCategoryIds.has(section.categoryId)) {
          throw new Error(`scenario ${scenario.id} surface rail has duplicate category section: ${section.categoryId}`)
        }
        sectionCategoryIds.add(section.categoryId)
        if (!activeCategoryIds.has(section.categoryId)) {
          throw new Error(`scenario ${scenario.id} surface rail references inactive category: ${section.categoryId}`)
        }
      }
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
  const defaultScenarioId = config.defaultScenarioId ?? config.scenarios[0]?.id
  if (!defaultScenarioId) throw new Error('scenario catalog has no scenarios')
  if (!scenarios.has(defaultScenarioId)) throw new Error(`default scenario is not registered: ${defaultScenarioId}`)

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

  const resolveRuntime = (scenario: ScenarioDefinition): ResolvedScenarioRuntime => {
    validateScenario(scenario)
    const initialObjects = applyInitialContexts(scenario)
    const activePacks = scenario.packs.map(packId => packs.get(packId)!)
    const runtimes = scenario.packs.map(packId => {
      const pack = packs.get(packId)
      if (!pack?.runtime?.defaultRuntimeId && scenario.runtimeOverrides[packId] === undefined) {
        throw new Error(`scenario ${scenario.id} pack ${packId} has no default pack runtime`)
      }
      const runtimeId = scenario.runtimeOverrides[packId] ?? pack!.runtime!.defaultRuntimeId
      return {
        packId,
        runtimeId,
        runtimeConfig: scenario.runtimeConfigs[packId] ?? {},
      }
    })
    return {
      scenarioId: scenario.id,
      scenario,
      packs: activePacks,
      runtimes,
      initialObjects,
      runtimeConfigs: Object.fromEntries(runtimes.map(runtime => [runtime.runtimeId, runtime.runtimeConfig])),
    }
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
      return resolveRuntime(scenario)
    },
    runtimeForDefinition: resolveRuntime,
    defaultScenarioId: (): string => defaultScenarioId,
    listMissions: sortedMissions,
    getMission: (id: string): MissionDefinition | undefined => missions.get(id),
  }
}
