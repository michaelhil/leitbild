// The L2 page rule through Host: the Workspace page offers a Planning plan's delete card and a plan
// Definition's primary card only when they take no required input. Host's own cardCapability throws on a
// violation, which stuck every Workspace page holding a Study (ops addendum).
import { afterAll, expect, test } from 'bun:test'
import { workspaceCapabilityCatalogSchema, workspaceDefinitionCatalogSchema, workspaceResourceCatalogSchema } from '@leitbild/contracts'
import { cardCapability } from '../../../apps/leitbild/src/ui/card-actions.ts'
import { createPlanningStack } from './planning-stack.ts'

const stack = await createPlanningStack()
afterAll(() => stack.close())
const read = async (path: string) => (await fetch(`${stack.hostUrl}/api/workspaces/${stack.workspaceId}/${path}`)).json()

test('generic plan cards run with no input and the guided plan starts from World', async () => {
  const definitions = workspaceDefinitionCatalogSchema.parse(await read('definitions')).definitions.filter(definition => definition.ref.moduleId === 'planning')
  const capabilities = workspaceCapabilityCatalogSchema.parse(await read('capabilities')).capabilities
  expect(definitions.map(definition => String(definition.ref.id))).toEqual(['blank', 'halden-delivery-planning', 'train-a-work-week', 'supply-run'])
  for (const definition of definitions) {
    if (definition.ref.id === 'halden-delivery-planning') {
      expect(definition.primaryCapabilityId).toBeUndefined()
      const started = await fetch(`${stack.hostUrl}/api/workspaces/${stack.workspaceId}/capabilities/planning.plan.create/invoke`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ definition: { ...definition.ref, revisionId: definition.currentRevisionId }, input: {} }),
      })
      expect(started.status).toBe(400)
      expect((await started.json()).error.code).toBe('demo_run_required')
      continue
    }
    const primary = cardCapability(definition, 'primary', capabilities)!
    expect(String(primary.id)).toBe('planning.plan.create')
    const started = await fetch(`${stack.hostUrl}/api/workspaces/${stack.workspaceId}/capabilities/${primary.id}/invoke`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ definition: { ...definition.ref, revisionId: definition.currentRevisionId }, input: {} }),
    })
    expect(started.ok).toBe(true)
  }
  const plans = workspaceResourceCatalogSchema.parse(await read('resources')).resources.filter(resource => resource.ref.type === 'planning.plan')
  expect(plans).toHaveLength(3)
  for (const plan of plans) {
    expect(String(cardCapability(plan, 'delete', capabilities)!.id)).toBe('planning.plan.delete')
    const deleted = await fetch(`${stack.hostUrl}/api/workspaces/${stack.workspaceId}/capabilities/planning.plan.delete/invoke`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ resource: plan.ref, input: {} }),
    })
    expect(await deleted.json()).toEqual({ result: { deleted: true } })
  }
  expect(workspaceResourceCatalogSchema.parse(await read('resources')).resources.filter(resource => resource.ref.type === 'planning.plan')).toEqual([])
})
