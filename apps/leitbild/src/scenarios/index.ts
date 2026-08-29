import type { MissionDefinition, ObjectId, ScenarioDefinition } from '../core/model/index.ts'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { leitbildPacks } from '../app-assembly.ts'
import { scenarioDefinitionFromConfig } from '../core/scenarios/config.ts'
import { createDirectRoutingAdapter } from '../routing/direct-adapter.ts'
import type { RoutingAdapter } from '../routing/protocol.ts'

const scenarioDir = dirname(fileURLToPath(import.meta.url))

const readScenarioConfig = (fileName: string): unknown =>
  JSON.parse(readFileSync(join(scenarioDir, fileName), 'utf8')) as unknown

export const builtinMissions: ReadonlyArray<MissionDefinition> = [{
  id: 'mission:oslo-drone-search-and-intercept',
  schemaVersion: 1,
  title: 'Oslo drone search, supply, and intercept',
  briefing: 'Coordinate a small mixed drone group to survey a riverside incident, support ground responders, and demonstrate a controlled effect against a nearby operational asset.',
  scenarioId: 'oslo-drone-operations',
  goals: [{
    id: 'goal:drone-shared-operations',
    title: 'Operate multiple drones in one shared simulation run',
    description: 'Use map commands, direct flight windows, and swarm commands while every drone remains an individually simulated object.',
  }],
  objectives: [
    {
      id: 'objective:survey-riverside',
      title: 'Survey the riverside incident',
      stageId: 'stage:survey',
      successCriteria: 'At least one surveillance drone reaches the riverside search area and remains airborne with usable battery reserve.',
      failureCriteria: 'All surveillance-capable drones are disabled, destroyed, or below reserve before reaching the search area.',
    },
    {
      id: 'objective:supply-support',
      title: 'Demonstrate supply support',
      stageId: 'stage:support',
      successCriteria: 'The supply-capable drone is tasked to support the incident or a ground responder.',
    },
    {
      id: 'objective:controlled-effect',
      title: 'Demonstrate controlled drone effect',
      stageId: 'stage:effect',
      successCriteria: 'An effect-capable drone applies a validated payload effect to the configured target asset.',
      failureCriteria: 'The effect command is rejected because of range, depleted payload, or invalid capability.',
    },
  ],
  tasks: [
    {
      id: 'task:survey-search-zone',
      title: 'Survey search zone',
      objectiveId: 'objective:survey-riverside',
      targetObjectIds: ['incident:drone-search-zone' as ObjectId],
      assigneeObjectId: 'drone:oslo-survey-1' as ObjectId,
    },
    {
      id: 'task:supply-ground-team',
      title: 'Position supply drone for ground support',
      objectiveId: 'objective:supply-support',
      targetObjectIds: ['incident:drone-search-zone' as ObjectId, 'amb:drone-target-a12' as ObjectId],
      assigneeObjectId: 'drone:oslo-supply-1' as ObjectId,
    },
    {
      id: 'task:controlled-effect-target',
      title: 'Apply a controlled effect to a target asset',
      objectiveId: 'objective:controlled-effect',
      targetObjectIds: ['amb:drone-target-a21' as ObjectId],
      assigneeObjectId: 'drone:oslo-interceptor-1' as ObjectId,
    },
  ],
  stages: [
    {
      id: 'stage:survey',
      title: 'Survey',
      objectiveIds: ['objective:survey-riverside'],
      activeOnStart: true,
    },
    {
      id: 'stage:support',
      title: 'Support',
      objectiveIds: ['objective:supply-support'],
      activeOnStart: true,
    },
    {
      id: 'stage:effect',
      title: 'Effect',
      objectiveIds: ['objective:controlled-effect'],
      activeOnStart: true,
    },
  ],
  triggers: [{
    id: 'trigger:survey-drone-arrives',
    kind: 'object_reaches_target',
    activeInStageIds: ['stage:survey'],
    condition: { objectId: 'drone:oslo-survey-1', targetObjectId: 'incident:drone-search-zone', radiusM: 80 },
    oneShot: true,
  }],
  actions: [{
    id: 'action:complete-survey-objective',
    kind: 'complete_objective',
    triggerId: 'trigger:survey-drone-arrives',
    payload: { objectiveId: 'objective:survey-riverside' },
  }],
  evaluationMetrics: [
    {
      id: 'metric:drone-battery-reserve',
      label: 'Drone battery reserve',
      description: 'Minimum remaining battery reserve across active drones during mission execution.',
    },
    {
      id: 'metric:effect-command-validity',
      label: 'Effect command validity',
      description: 'Whether effect commands are accepted only when capability, payload, range, and target checks pass.',
    },
  ],
}]

export const createBuiltinScenarios = async (
  routing: RoutingAdapter,
): Promise<ReadonlyArray<ScenarioDefinition>> => [
  await scenarioDefinitionFromConfig(readScenarioConfig('oslo-ambulance.scenario.json'), leitbildPacks, { routing }),
  await scenarioDefinitionFromConfig(readScenarioConfig('oslo-all-packs-demo.scenario.json'), leitbildPacks, { routing }),
  await scenarioDefinitionFromConfig(readScenarioConfig('oslo-drone-operations.scenario.json'), leitbildPacks, { routing }),
  await scenarioDefinitionFromConfig(readScenarioConfig('halden.scenario.json'), leitbildPacks, { routing }),
  await scenarioDefinitionFromConfig(readScenarioConfig('halden-process-plant-demo.scenario.json'), leitbildPacks, { routing }),
  await scenarioDefinitionFromConfig(readScenarioConfig('norway-airspace.scenario.json'), leitbildPacks, { routing }),
  await scenarioDefinitionFromConfig(readScenarioConfig('norway-electric-grid.scenario.json'), leitbildPacks, { routing }),
]

export const scenarios: ReadonlyArray<ScenarioDefinition> = await createBuiltinScenarios(createDirectRoutingAdapter())

const osloScenario = scenarios.find(scenario => scenario.id === 'oslo-ambulance')
if (!osloScenario) throw new Error('built-in oslo-ambulance scenario was not loaded')
export const osloAmbulanceScenario: ScenarioDefinition = osloScenario
