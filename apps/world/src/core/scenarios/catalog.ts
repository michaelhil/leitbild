import type { OperationalObject, ScenarioDefinition } from '../model/index.ts'
import { scenarioDefinitionSchema } from '../model/index.ts'
import type { WorldPack } from '../packs/protocol.ts'

export interface ResolvedPackRuntime {
  readonly packId: string
  readonly runtimeId: string
  readonly runtimeConfig: unknown
}

export interface ResolvedScenarioRuntime {
  readonly scenarioId: string
  readonly packs: ReadonlyArray<WorldPack>
  readonly runtimes: ReadonlyArray<ResolvedPackRuntime>
  readonly initialObjects: ReadonlyArray<OperationalObject>
  readonly runtimeConfigByRuntimeId: Record<string, unknown>
  readonly scenario: ScenarioDefinition
}

export interface ScenarioCatalog {
  readonly listScenarios: () => ReadonlyArray<ScenarioDefinition>
  readonly getScenario: (id: string) => ScenarioDefinition | undefined
  readonly initialObjectsFor: (id: string) => ReadonlyArray<OperationalObject> | undefined
  readonly runtimeFor: (id: string) => ResolvedScenarioRuntime | undefined
  readonly runtimeForDefinition: (scenario: ScenarioDefinition) => ResolvedScenarioRuntime
  readonly defaultScenarioId: () => string
}

export const createScenarioCatalog = (config: {
  readonly packs: ReadonlyArray<WorldPack>
  readonly scenarios: ReadonlyArray<ScenarioDefinition>
  readonly defaultScenarioId?: string
}): ScenarioCatalog => {
  const scenarios = new Map<string, ScenarioDefinition>()
  const packs = new Map<string, WorldPack>()

  for (const pack of config.packs) {
    if (packs.has(pack.descriptor.id)) throw new Error(`duplicate pack id: ${pack.descriptor.id}`)
    packs.set(pack.descriptor.id, pack)
  }

  const validateScenario = (scenario: ScenarioDefinition): void => {
    if (scenario.packs.length === 0) throw new Error(`scenario ${scenario.id} must declare at least one pack`)
    const objectIds = new Set<string>(scenario.initialObjects.map(object => object.id))
    if (objectIds.size !== scenario.initialObjects.length) throw new Error(`scenario ${scenario.id} has duplicate initial object ids`)
    for (const packId of scenario.packs) {
      const pack = packs.get(packId)
      if (!pack) throw new Error(`scenario ${scenario.id} references unknown pack: ${packId}`)
      const runtimeId = scenario.packRuntimes[packId] ?? pack.runtime?.defaultRuntimeId
      if (!runtimeId) continue
      const runtimes = pack.runtime?.runtimes ?? []
      if (!runtimes.some(runtime => runtime.id === runtimeId)) {
        throw new Error(`scenario ${scenario.id} runtime ${runtimeId} is not registered by pack ${packId}`)
      }
    }
    for (const packId of Object.keys(scenario.packRuntimes)) {
      if (!scenario.packs.includes(packId)) throw new Error(`scenario ${scenario.id} selects a runtime for inactive Pack: ${packId}`)
    }
    for (const packId of Object.keys(scenario.packConfigs)) {
      if (!scenario.packs.includes(packId)) throw new Error(`scenario ${scenario.id} configures inactive Pack: ${packId}`)
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

  const defaultScenarioId = config.defaultScenarioId ?? config.scenarios[0]?.id
  if (!defaultScenarioId) throw new Error('scenario catalog has no scenarios')
  if (!scenarios.has(defaultScenarioId)) throw new Error(`default scenario is not registered: ${defaultScenarioId}`)

  const sortedScenarios = (): ReadonlyArray<ScenarioDefinition> =>
    [...scenarios.values()].sort((left, right) => left.id.localeCompare(right.id))

  const resolveRuntime = (scenario: ScenarioDefinition): ResolvedScenarioRuntime => {
    validateScenario(scenario)
    const initialObjects = scenario.initialObjects
    const activePacks = scenario.packs.map(packId => packs.get(packId)!)
    const runtimes = scenario.packs.flatMap(packId => {
      const pack = packs.get(packId)
      if (!pack?.runtime?.defaultRuntimeId && scenario.packRuntimes[packId] === undefined) {
        return []
      }
      const runtimeId = scenario.packRuntimes[packId] ?? pack!.runtime!.defaultRuntimeId
      return [{
        packId,
        runtimeId,
        runtimeConfig: scenario.packConfigs[packId] ?? {},
      }]
    })
    return {
      scenarioId: scenario.id,
      scenario,
      packs: activePacks,
      runtimes,
      initialObjects,
      runtimeConfigByRuntimeId: Object.fromEntries(runtimes.map(runtime => [runtime.runtimeId, runtime.runtimeConfig])),
    }
  }

  return {
    listScenarios: sortedScenarios,
    getScenario: (id: string): ScenarioDefinition | undefined => scenarios.get(id),
    initialObjectsFor: (id: string): ReadonlyArray<OperationalObject> | undefined => {
      const scenario = scenarios.get(id)
      if (!scenario) return undefined
      return scenario.initialObjects
    },
    runtimeFor: (id: string): ResolvedScenarioRuntime | undefined => {
      const scenario = scenarios.get(id)
      if (!scenario) return undefined
      return resolveRuntime(scenario)
    },
    runtimeForDefinition: resolveRuntime,
    defaultScenarioId: (): string => defaultScenarioId,
  }
}
