import { describe, expect, test } from 'bun:test'
import type { IsoTimestamp } from '../src/core/model/index.ts'
import { scenarioDefinitionSchema } from '../src/core/model/index.ts'
import { dueScenarioTimelineCues } from '../src/core/simulation-runs/timeline-runner.ts'
import { osloAmbulanceScenario, scenarios } from '../src/scenarios/index.ts'

describe('scenario timeline model', () => {
  test('validates timed scenario cues and declarative actions', () => {
    const parsed = scenarioDefinitionSchema.parse(osloAmbulanceScenario)

    expect(parsed.packs).toEqual(['ambulance', 'traffic', 'weather'])
    expect(parsed.initialObjects.some(object => object.id === 'traffic:ring2-slowdown')).toBe(true)
    expect(parsed.timeline?.cues.map(cue => cue.id)).toContain('majorstuen-created')
    expect(parsed.timeline?.cues.some(cue =>
      cue.actions.some(action => action.type === 'show_guidance'))).toBe(true)
    expect(parsed.timeline?.cues.some(cue =>
      cue.actions.some(action => action.type === 'upsert_object'))).toBe(true)
    expect(parsed.timeline?.cues.some(cue =>
      cue.actions.some(action => action.type === 'delete_object' && action.objectId === 'traffic:ring2-slowdown'))).toBe(true)
  })

  test('drone scenario can issue startup flight commands through the scenario runner', () => {
    const droneScenario = scenarios.find(scenario => scenario.id === 'oslo-drone-operations')
    if (!droneScenario) throw new Error('missing drone scenario')
    const parsed = scenarioDefinitionSchema.parse(droneScenario)
    const commandActions = parsed.timeline?.cues.flatMap(cue =>
      cue.actions.filter(action => action.type === 'issue_command')) ?? []

    expect(commandActions.map(action => action.command.kind)).toEqual([
      'drone.arm',
      'drone.takeoff',
      'drone.goto',
    ])
  })

  test('rejects duplicate scenario timeline cue ids', () => {
    expect(() => scenarioDefinitionSchema.parse({
      ...osloAmbulanceScenario,
      timeline: {
        cues: [
          osloAmbulanceScenario.timeline?.cues[0],
          osloAmbulanceScenario.timeline?.cues[0],
        ],
      },
    })).toThrow('duplicate scenario timeline cue id')
  })

  test('computes due timeline cues from scenario start and fired cue ids', () => {
    const timeline = osloAmbulanceScenario.timeline
    if (!timeline) throw new Error('scenario missing timeline')
    const startedAt = '2026-01-01T09:00:00.000Z' as IsoTimestamp
    const dueAtThreeMinutes = dueScenarioTimelineCues({
      timeline,
      state: {
        scenarioId: osloAmbulanceScenario.id,
        highlightedObjectIds: [],
        timeline: {
          startedAt,
          firedCueIds: ['scenario-started'],
        },
      },
      nowMs: Date.parse(startedAt) + 180_000,
    })

    expect(dueAtThreeMinutes.map(cue => cue.id)).toEqual([
      'partial-incident-clarified',
      'marienlyst-traffic-created',
      'majorstuen-created',
      'majorstuen-clarified',
    ])
  })
})
