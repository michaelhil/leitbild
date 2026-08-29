import { describe, expect, test } from 'bun:test'
import type { IsoTimestamp } from '../src/core/model/index.ts'
import { scenarioDefinitionSchema } from '../src/core/model/index.ts'
import { dueScenarioScriptSteps } from '../src/core/control-instances/scenario-runner.ts'
import { osloAmbulanceScenario, scenarios } from '../src/scenarios/index.ts'

describe('scenario script model', () => {
  test('validates timed scenario steps and declarative actions', () => {
    const parsed = scenarioDefinitionSchema.parse(osloAmbulanceScenario)

    expect(parsed.packs).toEqual(['ambulance', 'traffic', 'weather'])
    expect(parsed.initialObjects.some(object => object.id === 'traffic:ring2-slowdown')).toBe(true)
    expect(parsed.script?.steps.map(step => step.id)).toContain('majorstuen-created')
    expect(parsed.script?.steps.some(step =>
      step.actions.some(action => action.type === 'show_guidance'))).toBe(true)
    expect(parsed.script?.steps.some(step =>
      step.actions.some(action => action.type === 'upsert_object'))).toBe(true)
    expect(parsed.script?.steps.some(step =>
      step.actions.some(action => action.type === 'delete_object' && action.objectId === 'traffic:ring2-slowdown'))).toBe(true)
  })

  test('drone scenario can issue startup flight commands through the scenario runner', () => {
    const droneScenario = scenarios.find(scenario => scenario.id === 'oslo-drone-operations')
    if (!droneScenario) throw new Error('missing drone scenario')
    const parsed = scenarioDefinitionSchema.parse(droneScenario)
    const commandActions = parsed.script?.steps.flatMap(step =>
      step.actions.filter(action => action.type === 'issue_command')) ?? []

    expect(commandActions.map(action => action.command.kind)).toEqual([
      'drone.arm',
      'drone.takeoff',
      'drone.goto',
    ])
  })

  test('rejects duplicate scenario script step ids', () => {
    expect(() => scenarioDefinitionSchema.parse({
      ...osloAmbulanceScenario,
      script: {
        steps: [
          osloAmbulanceScenario.script?.steps[0],
          osloAmbulanceScenario.script?.steps[0],
        ],
      },
    })).toThrow('duplicate scenario script step id')
  })

  test('computes due script steps from scenario start and fired step ids', () => {
    const script = osloAmbulanceScenario.script
    if (!script) throw new Error('scenario missing script')
    const startedAt = '2026-01-01T09:00:00.000Z' as IsoTimestamp
    const dueAtThreeMinutes = dueScenarioScriptSteps({
      script,
      state: {
        scenarioId: osloAmbulanceScenario.id,
        highlightedObjectIds: [],
        script: {
          startedAt,
          firedStepIds: ['scenario-started'],
        },
      },
      nowMs: Date.parse(startedAt) + 180_000,
    })

    expect(dueAtThreeMinutes.map(step => step.id)).toEqual([
      'partial-incident-clarified',
      'marienlyst-traffic-created',
      'majorstuen-created',
      'majorstuen-clarified',
    ])
  })
})
