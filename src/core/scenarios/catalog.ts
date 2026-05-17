import type { MissionDefinition, OperationalObject, ScenarioDefinition } from '../model/index.ts'
import { missionDefinitionSchema, scenarioDefinitionSchema } from '../model/index.ts'
import type { LeitbildPack } from '../packs/protocol.ts'

export interface ScenarioCatalog {
  readonly listScenarios: () => ReadonlyArray<ScenarioDefinition>
  readonly getScenario: (id: string) => ScenarioDefinition | undefined
  readonly initialObjectsFor: (id: string) => ReadonlyArray<OperationalObject> | undefined
  readonly defaultScenarioId: () => string
  readonly listMissions: () => ReadonlyArray<MissionDefinition>
  readonly getMission: (id: string) => MissionDefinition | undefined
}

export const createScenarioCatalog = (packs: ReadonlyArray<LeitbildPack>): ScenarioCatalog => {
  const scenarios = new Map<string, ScenarioDefinition>()
  const missions = new Map<string, MissionDefinition>()

  for (const pack of packs) {
    for (const missionCandidate of pack.missions ?? []) {
      const mission = missionDefinitionSchema.parse(missionCandidate) as MissionDefinition
      if (missions.has(mission.id)) throw new Error(`duplicate mission id: ${mission.id}`)
      missions.set(mission.id, mission)
    }
    for (const scenarioCandidate of pack.scenarios ?? []) {
      const scenario = scenarioDefinitionSchema.parse(scenarioCandidate) as ScenarioDefinition
      if (scenario.contributedByPackId !== pack.id) {
        throw new Error(`scenario ${scenario.id} contribution pack mismatch: expected ${pack.id}, got ${scenario.contributedByPackId}`)
      }
      if (!scenario.requiredPackIds.includes(pack.id)) {
        throw new Error(`scenario ${scenario.id} must include contributing pack ${pack.id} in requiredPackIds`)
      }
      const objectIds = new Set<string>(scenario.initialObjects.map(object => object.id))
      const unknownContextObjectIds = scenario.initialContexts
        .map(initialContext => initialContext.objectId)
        .filter(objectId => !objectIds.has(objectId))
      if (unknownContextObjectIds.length > 0) {
        throw new Error(`scenario ${scenario.id} has contexts for unknown objects: ${unknownContextObjectIds.join(', ')}`)
      }
      if (scenarios.has(scenario.id)) throw new Error(`duplicate scenario id: ${scenario.id}`)
      scenarios.set(scenario.id, scenario)
    }
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

  return {
    listScenarios: sortedScenarios,
    getScenario: (id: string): ScenarioDefinition | undefined => scenarios.get(id),
    initialObjectsFor: (id: string): ReadonlyArray<OperationalObject> | undefined => {
      const scenario = scenarios.get(id)
      if (!scenario) return undefined
      const contextsByObjectId = new Map(scenario.initialContexts.map(initialContext => [initialContext.objectId, initialContext.context]))
      return scenario.initialObjects.map(object => {
        const context = contextsByObjectId.get(object.id)
        return context ? { ...object, context } : object
      })
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
