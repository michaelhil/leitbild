import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { createPlanningClient, sourceUnavailable } from './api.ts'

describe('Planning Host boundary', () => {
  test('Study operations carry the exact Resource while source refresh remains Workspace scoped', async () => {
    const calls: Array<{ path: string; body: unknown }> = []
    const transport = (async (path: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ path: String(path), body: JSON.parse(String(init?.body)) })
      return Response.json({ result: { accepted: true } })
    })
    const client = createPlanningClient('workspace', transport)
    await client.invoke('planning.problem.check', {}, z.object({ accepted: z.boolean() }), 'study')
    await client.invoke('planning.sources.capture', { studyId: 'study' }, z.object({ accepted: z.boolean() }))
    expect(calls[0]).toEqual({ path: '/api/workspaces/workspace/capabilities/planning.problem.check/invoke', body: { resource: { workspaceId: 'workspace', moduleId: 'planning', type: 'planning.study', id: 'study' }, input: {}, actor: { kind: 'human' } } })
    expect(calls[1]?.body).toEqual({ input: { studyId: 'study' }, actor: { kind: 'human' } })
  })
  test('refusals and malformed success data are surfaced, not replaced by demo data', async () => {
    const refusal = createPlanningClient('workspace', (async () => Response.json({ error: { code: 'source_refused', message: 'This Run is no longer shared.' } }, { status: 403 })))
    await expect(refusal.demos()).rejects.toThrow('This Run is no longer shared.')
    const malformed = createPlanningClient('workspace', (async () => Response.json({ result: { demos: [{ id: 'invented', title: 'bad', description: 'bad' }] } })))
    await expect(malformed.demos()).rejects.toThrow()
  })
  test('known source refusals retain their code so every action can clear cached evidence', async () => {
    const client = createPlanningClient('workspace', async () => Response.json({ error: { code: 'planning_source_unavailable', message: 'The retained source is no longer qualified.' } }, { status: 403 }))
    try {
      await client.demos()
      throw new Error('Expected source refusal')
    } catch (error) {
      expect(sourceUnavailable(error)).toBe(true)
      expect(error).toMatchObject({ status: 403, code: 'planning_source_unavailable', message: 'The retained source is no longer qualified.' })
    }
    expect(sourceUnavailable(new Error('ordinary validation error'))).toBe(false)
    expect(sourceUnavailable(undefined)).toBe(false)
  })
})
