// The scripted Assistant cycle (design 9 row 5): facts, create, link, refresh, edits, generate, explain,
// baseline, then a read from a new Room, all through Host with the Agents workspace tools, against World's
// real planning facts query on a real Supply run. The Run's journal gains nothing from Planning, and every
// result stays within 4 KB. The solver and checker are lane S and K doubles until integration.
import { afterAll, expect, test } from 'bun:test'
import { planInputsSchema } from '../../../apps/planning/src/plan/schema.ts'
import { createPlanningStack } from './planning-stack.ts'

const supplyRun = planInputsSchema.parse(await Bun.file(new URL('../../../apps/planning/src/plan/fixtures/supply-run.case2.json', import.meta.url)).json())
const stack = await createPlanningStack()
afterAll(() => stack.close())
// A person starts the Definition's World Scenario through Host's normal launch (A1); Planning never does.
const runId = await stack.start('world.scenario', supplyRun.settings.scenario!.id, 'world.scenario.start')

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength
const one = async (room: ReturnType<typeof stack.room>, call: Record<string, unknown>) => {
  const answer = await room.call({ calls: [{ key: 'c', ...call }] }) as { success: boolean; data: { results: Array<{ success: boolean; data?: any; error?: string }> } }
  expect(answer.success).toBe(true)
  const result = answer.data.results[0]!
  if (!result.success) throw new Error(`${String(call.operationId)} failed: ${result.error}`)
  expect(bytes(result.data)).toBeLessThanOrEqual(4_096)
  return result.data
}

test('the whole plan cycle through Host, with no World write', async () => {
  const journal = stack.runEvents(runId)
  const assistant = stack.room('room-1')
  const scope = await assistant.explore({ view: 'scope' }) as { data: { definitions: any[]; resources: any[] } }
  const run = scope.data.resources.find(resource => resource.target.ref.type === 'world.simulation-run' && resource.target.ref.id === runId).target
  const supplyDefinition = scope.data.definitions.find(definition => definition.target.ref.id === 'supply-run').target

  const found = await one(assistant, { operationId: 'world.simulation-run.planning-facts', target: run, input: { text: 'truck' } })
  expect(found.items.length).toBeGreaterThan(0)

  const created = await one(assistant, { operationId: 'planning.plan.create', target: supplyDefinition, input: {} })
  const plan = { kind: 'resource', ref: { workspaceId: stack.workspaceId, moduleId: 'planning', type: 'planning.plan', id: created.plan.id } }
  expect(created.attention[0].kind).toBe('world')

  const linked = await one(assistant, { operationId: 'planning.plan.edit', target: plan, input: { edits: [{ edit: 'plan', run: runId }] }, expectedRevision: 1 })
  expect(linked.plan.revision).toBe(2)
  const refreshed = await one(assistant, { operationId: 'planning.sources.refresh', input: { plan: created.plan.id }, expectedRevision: 2 })
  expect([refreshed.plan.revision, refreshed.problems]).toEqual([3, []])

  const job = supplyRun.jobs[0]!
  const edited = await one(assistant, { operationId: 'planning.plan.edit', target: plan, input: { edits: [{ edit: 'job', key: job.key, tags: [...job.tags, 'checked'] }], reason: 'Dispatcher checked the request' }, expectedRevision: 3 })
  expect(edited.plan.revision).toBe(4)

  const generated = await one(assistant, { operationId: 'planning.plan.generate', target: plan, input: {}, expectedRevision: 4 })
  expect([generated.plan.revision, typeof generated.recommended]).toEqual([4, 'string'])
  const explained = await one(assistant, { operationId: 'planning.plan.explain', target: plan, input: { ask: 'finish' } })
  expect(explained.items.length).toBeGreaterThan(0)
  const baselined = await one(assistant, { operationId: 'planning.plan.baseline', target: plan, input: { option: generated.recommended, name: 'Dispatch' }, expectedRevision: 4 })
  expect(baselined.plan.revision).toBe(4)

  // A new Room finds the same plan by discovery and reads it.
  const fresh = stack.room('room-2')
  const again = await fresh.explore({ view: 'scope', moduleId: 'planning' }) as { data: { resources: any[] } }
  const target = again.data.resources.find(resource => resource.target.ref.id === created.plan.id).target
  const summary = await one(fresh, { operationId: 'planning.plan.read', target, input: {} })
  expect(summary.sections[0].data.plan).toMatchObject({ id: created.plan.id, title: supplyRun.settings.title, revision: 4 })
  const options = await one(fresh, { operationId: 'planning.plan.read', target, input: { section: 'options' } })
  expect(options.sections[0].data).toMatchObject({ recommended: generated.recommended, items: [{ key: generated.recommended, fresh: true }] })

  const stored = await stack.store.read(stack.workspaceId, created.plan.id)
  expect([stored.revision, stored.baselines.length, stored.options?.options.length]).toEqual([4, 1, 1])
  expect(stored.changes.map(change => change.kinds)).toEqual([[], ['plan'], ['refresh'], ['job'], [], []])

  // Every value the case names came from World's real answer, and the Run's journal is as before.
  expect(stored.inputs.world.facts.length).toBeGreaterThan(0)
  expect(stack.runEvents(runId)).toBe(journal)
})

test('refusals through Host carry their cause and the current revision', async () => {
  const assistant = stack.room('room-3')
  const scope = await assistant.explore({ view: 'scope', moduleId: 'planning' }) as { data: { definitions: any[] } }
  const created = await one(assistant, { operationId: 'planning.plan.create', target: scope.data.definitions.find(definition => definition.target.ref.id === 'blank').target, input: {} })
  const plan = { kind: 'resource', ref: { workspaceId: stack.workspaceId, moduleId: 'planning', type: 'planning.plan', id: created.plan.id } }
  type Refusal = { success: boolean; details: { code: string; details: { status: number; hostDetails: { currentRevision?: number } } } }
  const attempt = async (call: Record<string, unknown>) => ((await assistant.call({ calls: [{ key: 'c', operationId: 'planning.plan.edit', target: plan, input: { edits: [{ edit: 'plan', title: 'Week 48' }] }, ...call }] })) as { data: { results: Refusal[] } }).data.results[0]!
  const missing = await attempt({})
  expect([missing.success, missing.details.code, missing.details.details.status, missing.details.details.hostDetails.currentRevision]).toEqual([false, 'plan_revision_required', 400, 1])
  const stale = await attempt({ expectedRevision: 7 })
  expect([stale.details.code, stale.details.details.status, stale.details.details.hostDetails.currentRevision]).toEqual(['plan_revision_conflict', 409, 1])
  const malformed = await attempt({ expectedRevision: 1, input: { edits: [{ edit: 'job', key: 'J1', duration: { unit: 'weeks' } }] } })
  expect(malformed.details.code).toBe('invalid_request')
  expect(JSON.stringify(malformed.details.details.hostDetails)).toContain('"field":"duration"')
})
