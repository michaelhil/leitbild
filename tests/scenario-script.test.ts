import { describe, expect, test } from 'bun:test'
import type { IsoTimestamp } from '../src/core/model/index.ts'
import { scenarioDefinitionSchema } from '../src/core/model/index.ts'
import { dueScenarioScriptSteps } from '../src/core/control-instances/scenario-runner.ts'
import { osloAmbulanceTutorialScenario } from '../src/scenarios/index.ts'

describe('scenario script model', () => {
  test('validates timed scenario steps and declarative actions', () => {
    const parsed = scenarioDefinitionSchema.parse(osloAmbulanceTutorialScenario)

    expect(parsed.script?.steps.map(step => step.id)).toContain('majorstuen-created')
    expect(parsed.script?.steps.some(step =>
      step.actions.some(action => action.type === 'show_guidance'))).toBe(true)
    expect(parsed.script?.steps.some(step =>
      step.actions.some(action => action.type === 'upsert_object'))).toBe(true)
  })

  test('rejects duplicate scenario script step ids', () => {
    expect(() => scenarioDefinitionSchema.parse({
      ...osloAmbulanceTutorialScenario,
      script: {
        steps: [
          osloAmbulanceTutorialScenario.script?.steps[0],
          osloAmbulanceTutorialScenario.script?.steps[0],
        ],
      },
    })).toThrow('duplicate scenario script step id')
  })

  test('computes due script steps from scenario start and fired step ids', () => {
    const script = osloAmbulanceTutorialScenario.script
    if (!script) throw new Error('scenario missing script')
    const startedAt = '2026-01-01T09:00:00.000Z' as IsoTimestamp
    const dueAtThreeMinutes = dueScenarioScriptSteps({
      script,
      state: {
        scenarioId: osloAmbulanceTutorialScenario.id,
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
      'majorstuen-created',
      'majorstuen-clarified',
    ])
  })
})
