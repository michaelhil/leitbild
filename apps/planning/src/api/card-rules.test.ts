// The L2 rule as Host applies it to cards (apps/leitbild/src/ui/card-actions.ts; checked there by the
// integration test): a primary or delete card Capability is a command of the right risk and scope that
// takes no required input. The revision travels in the envelope expectedRevision.
import { afterAll, describe, expect, test } from 'bun:test'
import { createHarness } from './fixtures/harness.ts'

const harness = await createHarness()
afterAll(() => harness.close())

describe('Host card rules (L2)', () => {
  test('the plan card names read as its inspection and delete as its delete, and neither the delete nor the primary needs input', async () => {
    const plan = await harness.create('train-a-work-week')
    const capabilities = (await harness.request(`/internal/workspaces/${harness.workspaceId}/capabilities`)).body.capabilities
    const resource = (await harness.request(`/internal/workspaces/${harness.workspaceId}/resources`)).body.resources.find((entry: { ref: { id: string } }) => entry.ref.id === plan.id)
    const definition = (await harness.request(`/internal/workspaces/${harness.workspaceId}/definitions`)).body.definitions[0]
    expect(resource).toMatchObject({ inspectionCapabilityId: 'planning.plan.read', deleteCapabilityId: 'planning.plan.delete', uiPath: `/workspaces/${harness.workspaceId}/planning?plan=${plan.id}` })
    for (const [id, risk] of [[resource.deleteCapabilityId, 'destructive'], [definition.primaryCapabilityId, 'write']] as const) {
      const capability = capabilities.find((entry: { id: string }) => entry.id === id)
      expect([capability.kind, capability.risk, capability.inputSchema.required ?? []]).toEqual(['command', risk, []])
    }
    // The delete card sends {} and may send no revision at all.
    expect((await harness.call('planning.plan.delete', { resource: plan.id })).body).toEqual({ result: { deleted: true } })
  })
})
