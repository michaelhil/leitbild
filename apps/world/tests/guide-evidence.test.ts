import { expect, test } from 'bun:test'
import { compiledScenarioSchema } from '../src/core/model/scenario.ts'
import { guideDefinitionSchema } from '../src/core/guides/model.ts'
import { evaluateGuideCondition } from '../src/core/guides/conditions.ts'
import type { SimulationRunRuntime } from '../src/core/simulation-runs/runtime.ts'
import type { Observation } from '../src/core/observation/model.ts'
import { responseScenario } from './fixtures/scenarios.ts'

test('side-specific instructions require visible typed references and never enter the public compiled view', () => {
  const guide = guideDefinitionSchema.parse({ id: 'side-guide', title: 'Orientation', steps: [{ id: 'blue-unit', title: 'Your unit', instruction: 'Inspect the unit in your picture', effects: [{ id: 'unit', target: { kind: 'object', objectId: 'unit:a12' }, action: { kind: 'highlight' } }], completion: { kind: 'acknowledge' } }] })
  const scenario = { ...responseScenario, timeline: undefined, agentRestrictions: { operationIds: [], objects: [] },
    sides: [{ id: 'blue', label: 'Blue', colour: '#112233' }, { id: 'red', label: 'Red', colour: '#445566' }],
    roles: [{ id: 'blue-role', label: 'Blue', class: 'operator', sees: ['blue'] }, { id: 'red-role', label: 'Red', class: 'operator', sees: ['red'] }],
    initialObjects: responseScenario.initialObjects.map(object => ({ ...object, audience: object.id === 'unit:a12' ? ['blue'] : 'public' })), guide }
  expect(compiledScenarioSchema.safeParse(scenario).success).toBe(false)
  const scoped = { ...scenario, guide: { ...guide, steps: guide.steps.map(step => ({ ...step, roles: ['blue-role'] })) } }
  expect(compiledScenarioSchema.safeParse(scoped).success).toBe(true)
  expect(compiledScenarioSchema.safeParse({ ...scoped, guide: { ...guide, steps: guide.steps.map(step => ({ ...step, roles: ['red-role'] })) } }).success).toBe(false)
})

test('guide numeric decisions use declared quantity, actual sample quality/time, and current access', async () => {
  const now = '2026-11-02T10:00:00.000Z'
  let quality: Observation['quality'] = 'good', at = now, allowed = true, unit = 'MPa', revokeDuringRead = false
  const runtime = {
    snapshot: () => ({ seq: 7, objects: [], clock: { currentTime: now } }),
    observations: () => ({
      declarations: async () => [{ objectId: 'plant:a', revision: 'test', elements: [], observables: [{ ref: 'plant:a#pressure', quantity: 'pressure', unit }] }],
      read: async () => {
        if (revokeDuringRead) allowed = false
        return { observations: [{ ref: 'plant:a#pressure', at, clock: 'simulation', quality, value: 5 }], refused: [], unknown: [], leads: [] }
      },
    }),
  } as unknown as SimulationRunRuntime
  const evaluate = () => evaluateGuideCondition({ runtime, actor: { id: 'actor:learner' as never, label: 'Learner', role: 'operator' }, startsAt: now, canInspect: () => allowed,
    condition: { kind: 'observation', ref: 'plant:a#pressure', operator: 'gt', value: 4, quantity: 'pressure', unit: 'MPa', maxAgeSeconds: 5 } })
  expect((await evaluate()).status).toBe('satisfied')
  quality = 'uncertain'; expect((await evaluate()).status).toBe('unknown')
  quality = 'good'; at = '2026-11-02T09:59:50.000Z'; expect((await evaluate()).status).toBe('stale')
  at = now; unit = 'Pa'; expect((await evaluate()).status).toBe('unknown')
  unit = 'MPa'; revokeDuringRead = true; const refused = await evaluate()
  expect(refused.status).toBe('refused')
  expect(refused.value).toBeUndefined()
})
