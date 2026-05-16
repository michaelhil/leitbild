import { describe, expect, test } from 'bun:test'
import {
  agentContextViewSchema,
  confirmedFact,
  geoPointFromLonLat,
  missionDefinitionSchema,
  missionProgressStateSchema,
  nowIso,
  objectContextSchema,
  operationalObjectSchema,
  scenarioDefinitionSchema,
  type ControlInstanceId,
  type DomainId,
  type ObjectId,
} from '../src/core/model/index.ts'
import { createOsloAmbulanceScenario } from '../src/domains/ambulance/scenario.ts'
import { createAmbulanceSimEngine } from '../src/domains/ambulance/sim/engine.ts'
import { createDirectRoutingAdapter } from '../src/routing/direct-adapter.ts'

const ambulanceObjects = () =>
  createAmbulanceSimEngine({
    controlInstanceId: 'control-instance:context-model-test' as ControlInstanceId,
    scenario: createOsloAmbulanceScenario(),
    routing: createDirectRoutingAdapter(),
  }).snapshot().objects

const ambulanceObjectWithContext = () => {
  const at = nowIso()
  const ambulance = ambulanceObjects().find(object => object.kind === 'mobile_entity')
  if (!ambulance) throw new Error('scenario missing ambulance')

  return {
    ...ambulance,
    context: {
      schemaVersion: 1,
      facts: [{
        id: 'fact:crew-dispatch-note',
        key: 'dispatch.current_call',
        perspective: 'asset',
        fact: confirmedFact('Respond to Incident 77 via main entrance', at, 'radio', 0.95),
        relatedObjectIds: ['incident:77' as ObjectId],
        relatedTaskIds: ['task:respond-incident-77'],
      }],
      activity: [{
        id: 'activity:radio-1',
        at,
        source: 'radio',
        perspective: 'asset',
        summary: 'Dispatch assigned Ambulance A-12 to Incident 77.',
        relatedObjectIds: ['incident:77' as ObjectId],
        relatedTaskIds: ['task:respond-incident-77'],
      }],
      references: [{
        kind: 'object',
        id: 'incident:77',
        label: 'Incident 77',
      }],
      summaries: [{
        id: 'summary:initial-dispatch',
        createdAt: at,
        perspective: 'asset',
        summary: 'Ambulance A-12 has one active response assignment.',
        coversActivityIds: ['activity:radio-1'],
      }],
    },
  }
}

describe('object context, scenario, and mission model', () => {
  test('OperationalObject accepts valid perspective-bearing context', () => {
    const parsed = operationalObjectSchema.parse(ambulanceObjectWithContext())

    expect(parsed.context?.schemaVersion).toBe(1)
    expect(parsed.context?.facts[0]?.perspective).toBe('asset')
    expect(parsed.context?.facts[0]?.fact.source).toBe('radio')
  })

  test('ObjectContext rejects invalid schema versions', () => {
    expect(() => objectContextSchema.parse({
      schemaVersion: 2,
      facts: [],
      activity: [],
      references: [],
      summaries: [],
    })).toThrow()
  })

  test('context facts require key, source, perspective, and timestamp', () => {
    const at = nowIso()
    expect(() => objectContextSchema.parse({
      schemaVersion: 1,
      facts: [{
        id: 'fact:missing-key',
        perspective: 'asset',
        fact: confirmedFact('known', at, 'radio'),
        relatedObjectIds: [],
        relatedTaskIds: [],
      }],
      activity: [],
      references: [],
      summaries: [],
    })).toThrow()

    expect(() => objectContextSchema.parse({
      schemaVersion: 1,
      facts: [{
        id: 'fact:missing-source-in-fact',
        key: 'dispatch.current_call',
        perspective: 'asset',
        fact: { state: 'confirmed', value: 'known', updatedAt: at },
        relatedObjectIds: [],
        relatedTaskIds: [],
      }],
      activity: [],
      references: [],
      summaries: [],
    })).toThrow()

    expect(() => objectContextSchema.parse({
      schemaVersion: 1,
      facts: [{
        id: 'fact:missing-perspective',
        key: 'dispatch.current_call',
        fact: confirmedFact('known', at, 'radio'),
        relatedObjectIds: [],
        relatedTaskIds: [],
      }],
      activity: [],
      references: [],
      summaries: [],
    })).toThrow()
  })

  test('ScenarioDefinition validates initial objects and initial contexts', () => {
    const object = ambulanceObjectWithContext()
    const parsed = scenarioDefinitionSchema.parse({
      id: 'scenario:oslo-context-basic',
      schemaVersion: 1,
      title: 'Oslo context basic',
      packId: 'ambulance',
      domain: 'ambulance_dispatch' as DomainId,
      world: {
        startsAt: nowIso(),
        mapCenter: geoPointFromLonLat(10.7522, 59.9139),
        environment: { weather: 'clear' },
      },
      initialObjects: [object],
      initialContexts: [{
        objectId: object.id,
        context: object.context,
      }],
      simulatorConfig: { adapter: 'ambulance.local' },
      missionId: 'mission:oslo-response-basic',
    })

    expect(parsed.initialObjects).toHaveLength(1)
    expect(parsed.initialContexts[0]?.context.facts[0]?.key).toBe('dispatch.current_call')
  })

  test('MissionDefinition validates objectives, tasks, stages, triggers, actions, and metrics', () => {
    const parsed = missionDefinitionSchema.parse({
      id: 'mission:oslo-response-basic',
      schemaVersion: 1,
      title: 'Oslo response basic',
      briefing: 'Dispatch one ambulance to the incident and transport to hospital if required.',
      scenarioId: 'scenario:oslo-context-basic',
      goals: [{
        id: 'goal:stabilize-patient',
        title: 'Stabilize and transport patient',
      }],
      objectives: [{
        id: 'objective:dispatch',
        title: 'Dispatch ambulance',
        stageId: 'stage:response',
        successCriteria: 'An ambulance is assigned to Incident 77.',
      }],
      tasks: [{
        id: 'task:respond-incident-77',
        title: 'Respond to Incident 77',
        objectiveId: 'objective:dispatch',
        targetObjectIds: ['incident:77'],
        assigneeObjectId: 'amb:a12',
      }],
      stages: [{
        id: 'stage:response',
        title: 'Initial response',
        objectiveIds: ['objective:dispatch'],
        activeOnStart: true,
      }],
      triggers: [{
        id: 'trigger:ambulance-assigned',
        kind: 'task_assigned',
        activeInStageIds: ['stage:response'],
        condition: { taskId: 'task:respond-incident-77' },
        oneShot: true,
      }],
      actions: [{
        id: 'action:complete-dispatch-objective',
        kind: 'complete_objective',
        triggerId: 'trigger:ambulance-assigned',
        payload: { objectiveId: 'objective:dispatch' },
      }],
      evaluationMetrics: [{
        id: 'metric:time-to-dispatch',
        label: 'Time to dispatch',
      }],
    })

    expect(parsed.triggers[0]?.kind).toBe('task_assigned')
    expect(parsed.actions[0]?.kind).toBe('complete_objective')
  })

  test('MissionProgressState is runtime state separate from MissionDefinition', () => {
    const at = nowIso()
    const definition = missionDefinitionSchema.parse({
      id: 'mission:oslo-response-basic',
      schemaVersion: 1,
      title: 'Oslo response basic',
    })
    const progress = missionProgressStateSchema.parse({
      missionId: definition.id,
      schemaVersion: 1,
      activeStageIds: ['stage:response'],
      objectives: [{
        objectiveId: 'objective:dispatch',
        status: 'active',
        updatedAt: at,
      }],
      tasks: [{
        taskId: 'task:respond-incident-77',
        status: 'assigned',
        updatedAt: at,
      }],
      firedTriggerIds: ['trigger:ambulance-assigned'],
      startedAt: at,
      updatedAt: at,
    })

    expect(definition).not.toHaveProperty('activeStageIds')
    expect(progress.activeStageIds).toEqual(['stage:response'])
  })

  test('AgentContextView is derivable and not required on stored objects', () => {
    const at = nowIso()
    const object = operationalObjectSchema.parse(ambulanceObjects()[0])
    expect(object.context).toBeUndefined()

    const view = agentContextViewSchema.parse({
      schemaVersion: 1,
      generatedAt: at,
      perspective: 'ai',
      object: {
        id: object.id,
        label: object.label,
        kind: object.kind,
        status: object.operational.status,
      },
      currentAssignment: 'Respond to Incident 77',
      importantFacts: [],
      recentActivity: [],
      summaries: [],
      relevantObjects: [],
      allowedCommands: ['ambulance.set_destination'],
    })

    expect(view.object.id).toBe(object.id)
    expect(view.allowedCommands).toEqual(['ambulance.set_destination'])
  })
})
