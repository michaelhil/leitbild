import { expect, test } from 'bun:test'
import { accessContextSchema, planningSourceBasisSchema, planningSourceRequestSchema } from '@leitbild/contracts'
import { createWorldPlanningSources } from './world-source.ts'

const workspaceId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const request = planningSourceRequestSchema.parse({ source: { workspaceId, moduleId: 'world', type: 'world.simulation-run', id: 'run' }, profile: 'einsatz', subjectIds: ['owner/subject'] })
const access = accessContextSchema.parse({ workspaceId, requestId: crypto.randomUUID(), actor: { kind: 'ai', id: 'research-assistant' } })
const basis = planningSourceBasisSchema.parse({ source: request.source, profile: request.profile, observedAt: '2026-11-08T12:00:00.000Z', simulationAt: '2026-11-08T09:00:00.000Z', sequence: 1, subjects: [{ locator: 'owner/subject', label: 'Shared subject', kind: 'unit', facts: [] }], digest: 'a'.repeat(64), qualification: { audience: 'shared-research', restrictionRevision: 0, epoch: crypto.randomUUID(), subjectIds: ['owner/subject'] } })

test('source capture forwards initiating AI identity to the exact Host capability; qualification reads no new facts', async () => {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = []
  const transport = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input), body = JSON.parse(String(init?.body))
    calls.push({ url, body })
    return Response.json({ result: url.includes('world.einsatz.planning-basis') ? basis : { allowed: true } })
  }) as typeof fetch
  const sources = createWorldPlanningSources({ hostUrl: 'http://host.internal', fetch: transport })
  expect(await sources.capture(request, access)).toEqual(basis)
  expect(await sources.qualify(basis, access, 'load-if-needed')).toEqual({ allowed: true })
  expect(calls[0]?.url).toBe(`http://host.internal/api/workspaces/${workspaceId}/capabilities/world.einsatz.planning-basis/invoke`)
  expect(calls[0]?.body).toEqual({ resource: request.source, input: { subjectIds: request.subjectIds }, actor: access.actor })
  expect(calls[1]?.body).toEqual({ resource: request.source, input: { profile: 'einsatz', qualification: basis.qualification, activation: 'load-if-needed' }, actor: access.actor })
})

test('foreign Workspace selection is rejected before transport, and owner refusal remains explicit', async () => {
  let calls = 0
  const sources = createWorldPlanningSources({ hostUrl: 'http://host.internal', fetch: (async () => { calls++; return Response.json({ error: { code: 'source_not_shared', message: 'Source is restricted' } }, { status: 403 }) }) as unknown as typeof fetch })
  await expect(sources.capture(planningSourceRequestSchema.parse({ ...request, source: { ...request.source, workspaceId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' } }), access)).rejects.toMatchObject({ code: 'source_workspace_mismatch' })
  expect(calls).toBe(0)
  await expect(sources.capture(request, access)).rejects.toMatchObject({ status: 403, code: 'source_not_shared' })
  expect(calls).toBe(1)
})

test('a mismatched owner response cannot become retained evidence', async () => {
  const sources = createWorldPlanningSources({ hostUrl: 'http://host.internal', fetch: (async () => Response.json({ result: { ...basis, source: { ...basis.source, id: 'another-run' } } })) as unknown as typeof fetch })
  await expect(sources.capture(request, access)).rejects.toMatchObject({ code: 'source_response_mismatch' })
})
