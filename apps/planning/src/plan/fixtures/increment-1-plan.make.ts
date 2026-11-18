// Test support, not shipped. Writes the plan file of increment-1-plan.json: a Train A plan made the way a
// planner made one in increment 1, on the real solver and checker, through the Module's own operations:
// create from the Train A Definition, link a Run, refresh (World shows every precondition as the plan
// expects it), Generate, and baseline the recommended option as "Freeze". Nothing in it is typed by hand.
// The committed file was written by this script at commit 1212cfe0e (increment 1 as released). Run at a
// later commit it writes that code's plan file instead, so it writes only to the path it is given.
// usage: bun apps/planning/src/plan/fixtures/increment-1-plan.make.ts <empty scratch directory> <output file>
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { newRequestId, workspaceIdSchema } from '@leitbild/contracts'
import { bundledPlanDefinitions, createPlanDefinitions } from '../../definitions/index.ts'
import { createPlanStore } from '../store.ts'
import { createPlanningModuleApi } from '../../api/module-api.ts'
import { createPlanningOperations } from '../../api/operations.ts'
import { createRealSolver } from '../../api/wiring.ts'
import { createSolverPool } from '../../solve/pool.ts'
import { createWorldDouble, subjectsFor } from '../../api/fixtures/doubles.ts'

const [root, output] = process.argv.slice(2)
if (root === undefined || output === undefined) throw new Error('usage: increment-1-plan.make.ts <empty scratch directory> <output file>')
if ((await readdir(root)).length > 0) throw new Error(`${root} is not empty`)

const definition = bundledPlanDefinitions.find(entry => entry.id === 'train-a-work-week')!
const at = definition.inputs.settings.dataDate!
const expected = Object.fromEntries(definition.inputs.jobs.flatMap(job => job.checks.map(check => [check.fact, { value: check.expect }])))
const workspaceId = workspaceIdSchema.parse(crypto.randomUUID())
const store = createPlanStore(root)
const pool = createSolverPool()
const definitions = createPlanDefinitions()
const operations = createPlanningOperations({ store, definitions, world: createWorldDouble(() => subjectsFor(definition.inputs, expected, at)), solver: createRealSolver(pool) })
const handle = createPlanningModuleApi({ operations, definitions, store })

const request = async (path: string, init?: RequestInit): Promise<any> => {
  const response = (await handle(new Request(`http://planning${path}`, init), new URL(`http://planning${path}`)))!
  const body = await response.json()
  if (response.status >= 300) throw new Error(`${path}: ${response.status} ${JSON.stringify(body)}`)
  return body
}
const call = (capabilityId: string, given: { resource?: string; definition?: boolean; input?: unknown; expectedRevision?: number }) =>
  request(`/internal/workspaces/${workspaceId}/capabilities/${capabilityId}/invoke`, { method: 'POST', body: JSON.stringify({
    workspaceId, capabilityId, input: given.input ?? {},
    ...(given.resource === undefined ? {} : { resource: { workspaceId, moduleId: 'planning', type: 'planning.plan', id: given.resource } }),
    ...(given.definition === true ? { definition: { workspaceId, moduleId: 'planning', type: 'planning.plan-definition', id: definition.id, revisionId: definition.revisionId } } : {}),
    ...(given.expectedRevision === undefined ? {} : { expectedRevision: given.expectedRevision }),
    access: { workspaceId, requestId: newRequestId(), actor: { kind: 'human', displayName: 'Planner' } },
  }) })

try {
  await request(`/internal/workspaces/${workspaceId}`, { method: 'PUT', body: JSON.stringify({ workspaceId }) })
  const created = (await call('planning.plan.create', { definition: true })).result.plan
  const linked = (await call('planning.plan.edit', { resource: created.id, input: { edits: [{ edit: 'plan', run: 'run-train-a' }] }, expectedRevision: created.revision })).result.plan
  const refreshed = (await call('planning.sources.refresh', { input: { plan: created.id }, expectedRevision: linked.revision })).result.plan
  const generated = (await call('planning.plan.generate', { resource: created.id, input: {}, expectedRevision: refreshed.revision })).result
  if (generated.recommended === undefined) throw new Error('Generate recommended no option')
  await call('planning.plan.baseline', { resource: created.id, input: { option: generated.recommended, name: 'Freeze' }, expectedRevision: refreshed.revision })
  const directory = join(root, 'workspaces', workspaceId, 'planning', 'plans')
  await Bun.write(output, Bun.file(join(directory, `${created.id}.json`)))
  console.log(`Wrote ${output}: plan ${created.id} at revision ${refreshed.revision}, baseline of ${generated.recommended}`)
} finally {
  await pool.shutdown()
}
