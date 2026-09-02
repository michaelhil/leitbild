import type { CompiledScenario,OperationalObject } from '../model/index.ts'
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
  readonly scenario: CompiledScenario
}

export interface ScenarioRuntimeResolver {
  readonly resolve: (scenario: CompiledScenario) => ResolvedScenarioRuntime
}

export const createScenarioRuntimeResolver = (config: {
  readonly packs: ReadonlyArray<WorldPack>
}): ScenarioRuntimeResolver => {
  const packs = new Map<string, WorldPack>()

  for (const pack of config.packs) {
    if (packs.has(pack.descriptor.id)) throw new Error(`duplicate pack id: ${pack.descriptor.id}`)
    packs.set(pack.descriptor.id, pack)
  }

  const validateScenario = (scenario: CompiledScenario): void => {
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
    for (const selection of scenario.recording) {
      if (!scenario.packs.includes(selection.packId)) throw new Error(`scenario ${scenario.id} records inactive Pack: ${selection.packId}`)
      const pack = packs.get(selection.packId)!
      const profile = pack.recording?.profiles.find(candidate => candidate.id === selection.profileId)
      if (!profile) throw new Error(`scenario ${scenario.id} selects unknown recording profile ${selection.profileId} for Pack ${selection.packId}`)
      if (selection.intervalMs !== undefined && selection.intervalMs < profile.minimumIntervalMs) {
        throw new Error(`scenario ${scenario.id} recording interval for ${selection.packId} must be at least ${profile.minimumIntervalMs} ms`)
      }
    }
    const activeCategoryIds = new Set(
      scenario.packs.flatMap(packId => packs.get(packId)?.presentation.categories.map(category => category.id) ?? []),
    )
    {
      const sectionCategoryIds = new Set<string>()
      for (const section of scenario.view.rail.sections) {
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

  const resolveRuntime = (input: CompiledScenario): ResolvedScenarioRuntime => {
    // Compilation and persisted-artifact loading validate the full wire shape.
    // Resolution checks installed ownership and selections, not the same JSON twice.
    const scenario = input
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

  return { resolve: resolveRuntime }
}
