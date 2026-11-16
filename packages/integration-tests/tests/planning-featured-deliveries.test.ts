import { afterAll, expect, test } from 'bun:test'
import { definitionIdSchema, featuredDefinitionCatalogSchema, moduleCapabilityInvocationResultSchema, moduleIdSchema } from '@leitbild/contracts'
import { createPlanningClient } from '../../../apps/planning/src/ui/api.ts'
import { createWorkspaceApi } from '../../../apps/leitbild/src/ui/launch-workspace.ts'
import { createPlanningStack } from './planning-stack.ts'

const stack = await createPlanningStack()
afterAll(() => stack.close())

const scenario = definitionIdSchema.parse('halden-delivery-planning')
const truck = 'einsatz/unit/unit%3Adelivery-truck'
const transport = (path: string, init?: RequestInit) => fetch(new URL(path, stack.hostUrl), init)
const api = createWorkspaceApi(transport)

const launch = async (workspaceId: string): Promise<string> => {
  const catalogue = featuredDefinitionCatalogSchema.parse(await (await transport('/api/featured-definitions')).json())
  const demo = catalogue.definitions.find(item => item.definition.moduleId === 'world' && item.definition.id === scenario)
  if (!demo) throw new Error('The World demo is missing from the public carousel')
  expect(demo.requiresModules).toContain(moduleIdSchema.parse('planning'))
  const started = await transport(`/api/workspaces/${workspaceId}/capabilities/world.scenario.start/invoke`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      definition: { ...demo.definition, workspaceId, revisionId: demo.revisionId },
      input: { playback: 'playing' },
    }),
  })
  const receipt = moduleCapabilityInvocationResultSchema.parse(await started.json())
  const run = receipt.createdResources?.find(item => item.type === 'world.simulation-run')
  if (!run) throw new Error('The demo start did not create a World Run')
  return run.id
}

const createDemoPlan = async (client: ReturnType<typeof createPlanningClient>, runId: string) => {
  const definitions = await client.definitions()
  const definition = definitions.definitions.find(item => item.ref.id === scenario)
  if (!definition) throw new Error('The bundled delivery plan is missing')
  return client.createDemo(definition, runId)
}

test('the public delivery demo runs in World and solves both orders from its linked truck', async () => {
  const { workspaceId } = stack
  const runId = await launch(workspaceId)

  const client = createPlanningClient(workspaceId, transport)
  const catalog = await client.catalog()
  const worldRun = catalog.resources.find(item => item.ref.id === runId)
  expect(worldRun?.sourceDefinition?.id).toBe(scenario)
  expect(worldRun?.summary.find(item => item.key === 'status')?.value).toBe('Running')
  expect(catalog.resources.filter(item => item.ref.type === 'planning.plan')).toHaveLength(0)

  // Both clicks can arrive before the other one returns. The module should keep one plan for the Run.
  const [first, second] = await Promise.all([createDemoPlan(client, runId), createDemoPlan(client, runId)])
  expect(second.result.plan.id).toBe(first.result.plan.id)
  const plans = (await client.catalog()).resources.filter(item => item.ref.type === 'planning.plan')
  expect(plans).toHaveLength(1)
  const planId = first.result.plan.id
  expect(plans[0]?.ref.id).toBe(planId)
  const ready = await stack.store.read(workspaceId, planId)
  expect(ready.inputs.settings.run?.id).toBe(runId)
  expect(ready.inputs.world.facts.find(fact => fact.locator === truck && fact.id.endsWith('/service-seconds'))?.value).toBe(600)

  const generated = await client.generate(planId, ready.revision, {})
  expect(generated.options.map(option => option.status.word)).toEqual(['validated feasible', 'validated feasible'])
  const scheduled = await stack.store.read(workspaceId, planId)
  const orders = scheduled.options!.options.map(option => {
    const rows = option.rows.slice().sort((left, right) => left.start.localeCompare(right.start))
    expect(rows).toHaveLength(2)
    const [first, second] = rows
    expect(Date.parse(first!.finish) - Date.parse(first!.start)).toBe(600_000)
    expect(Date.parse(second!.finish) - Date.parse(second!.start)).toBe(600_000)
    expect(Date.parse(second!.start) - Date.parse(first!.finish)).toBe(300_000)
    return rows.map(row => row.job)
  })
  expect(orders).toEqual([['school', 'sports-hall'], ['sports-hall', 'school']])
}, 60_000)

test('a run from the wrong scenario or Workspace cannot create a demo plan', async () => {
  const foreign = await api.create('Foreign demo run')
  const foreignRun = await launch(foreign.id)
  const wrongScenario = await stack.start('world.scenario', 'supply-run', 'world.scenario.start')
  const client = createPlanningClient(stack.workspaceId, transport)
  const before = (await client.catalog()).resources.filter(item => item.ref.type === 'planning.plan')
  for (const run of [foreignRun, wrongScenario]) {
    await expect(createDemoPlan(client, run)).rejects.toMatchObject({ status: 409, code: 'demo_run_mismatch' })
  }
  const after = (await client.catalog()).resources.filter(item => item.ref.type === 'planning.plan')
  expect(after.map(item => item.ref.id)).toEqual(before.map(item => item.ref.id))
}, 60_000)
