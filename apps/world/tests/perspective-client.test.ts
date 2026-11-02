import { expect, test } from 'bun:test'
import type { PerspectiveAdmission } from '@leitbild/contracts'
import { perspectiveAdmissionSchema, worldPerspectiveReferenceSchema } from '@leitbild/contracts'
import { createPerspectiveOwnerClient } from '../src/ui/perspective-client.ts'
import { configureActiveRoleSet, currentActiveRoleSet } from '../src/ui/roles/role-session.ts'

test('World UI captures its own held roles for every scoped request including old-scope cleanup', async () => {
  const originalFetch = globalThis.fetch, priorRoles = currentActiveRoleSet(), calls: any[] = []
  const workspaceId = '00000000-0000-4000-8000-000000000001', roles = ['blue-ems']
  const admission: PerspectiveAdmission = perspectiveAdmissionSchema.parse({ resource: { workspaceId, moduleId: 'world', type: 'world.perspective', id: 'scope-a' }, status: 'pending', revision: 0, admissionGeneration: crypto.randomUUID(), runIncarnation: crypto.randomUUID(), roleSetDigest: 'a'.repeat(64), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
  const recipient = { subject: admission.resource, clientId: 'client', documentId: 'document', leaseId: 'lease', expiresAt: new Date(Date.now() + 60_000).toISOString() }
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)); calls.push({ url: String(url), body })
    if (String(url).includes('presentation.register')) return Response.json({ result: recipient })
    if (String(url).includes('presentation.unregister')) return Response.json({ result: { closed: true } })
    return Response.json({ result: admission })
  }) as typeof fetch
  try {
    const client = createPerspectiveOwnerClient({ workspaceId, runId: 'run-a', roleIds: roles })
    roles.splice(0, 1, 'red-armour'); configureActiveRoleSet(['red-armour'])
    await client.prepare(crypto.randomUUID()); await client.read(admission.resource)
    await client.register(admission.resource); await client.unregister(admission.resource, recipient)
    expect(calls).toHaveLength(4)
    expect(calls.every(call => JSON.stringify(call.body.input.roleIds) === JSON.stringify(['blue-ems']))).toBe(true)
    expect(calls[0].body.resource).toEqual({ workspaceId, moduleId: 'world', type: 'world.simulation-run', id: 'run-a' })
    expect(calls.slice(1).every(call => JSON.stringify(call.body.resource) === JSON.stringify(admission.resource))).toBe(true)
    expect(calls.every(call => call.body.actor.kind === 'human')).toBe(true)
    await expect(client.read(worldPerspectiveReferenceSchema.parse({ ...admission.resource, workspaceId: '00000000-0000-4000-8000-000000000002' }))).rejects.toThrow('one exact Resource')
    expect(calls).toHaveLength(4)
  } finally { globalThis.fetch = originalFetch; configureActiveRoleSet(priorRoles) }
})

test('structured owner refusal remains available for exact revision-conflict read-back', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => Response.json({ error: { code: 'perspective_revision_conflict', message: 'Read the current admission revision' } }, { status: 409 })) as unknown as typeof fetch
  try {
    const workspaceId = '00000000-0000-4000-8000-000000000001', client = createPerspectiveOwnerClient({ workspaceId, runId: 'run', roleIds: ['blue'] })
    await expect(client.revoke(worldPerspectiveReferenceSchema.parse({ workspaceId, moduleId: 'world', type: 'world.perspective', id: 'scope' }), 0, 'role changed')).rejects.toMatchObject({ code: 'perspective_revision_conflict', message: 'Read the current admission revision' })
  } finally { globalThis.fetch = originalFetch }
})
