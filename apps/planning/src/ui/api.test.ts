// The screen reaches Planning and World only through Host's invoke route, with the plan Resource or
// the Definition as the target and the revision in the envelope. Refusals keep their code.
import { describe, expect, test } from 'bun:test'
import { createPlanningClient, isRequestError, refusalText } from './api.ts'

const workspace = '0b4b9a52-2f7e-4c1a-9d3e-00000000000a'
const plan = '0b4b9a52-2f7e-4c1a-9d3e-0000000000aa'
const write = { plan: { id: plan, title: 'Week 47', revision: 4 }, changed: [], attention: [], problems: [] }

const recording = (answer: unknown, status = 200) => {
  const calls: Array<{ path: string; body: Record<string, unknown> | null; signal: boolean }> = []
  const client = createPlanningClient(workspace, async (path, init) => {
    calls.push({ path: String(path), body: init?.body === undefined ? null : JSON.parse(String(init.body)), signal: init?.signal !== undefined })
    return Response.json(answer, { status })
  })
  return { client, calls }
}

describe('the Host boundary', () => {
  test('plan operations name the plan Resource and send the revision in the envelope', async () => {
    const { client, calls } = recording({ result: write })
    await client.edit(plan, 3, { edits: [{ edit: 'plan', title: 'Week 47' }], preview: true })
    expect(calls[0]).toEqual({
      path: `/api/workspaces/${workspace}/capabilities/planning.plan.edit/invoke`, signal: false,
      body: { resource: { workspaceId: workspace, moduleId: 'planning', type: 'planning.plan', id: plan }, expectedRevision: 3, input: { edits: [{ edit: 'plan', title: 'Week 47' }], preview: true }, actor: { kind: 'human' } },
    })
  })

  test('create goes through the Definition revision; refresh is Workspace scoped with the plan in its input; facts read the Run', async () => {
    const { client, calls } = recording({ result: write, createdResources: [{ workspaceId: workspace, moduleId: 'planning', type: 'planning.plan', id: plan }] })
    const definition = {
      ref: { workspaceId: workspace, moduleId: 'planning', type: 'planning.plan-definition', id: 'blank' }, title: 'New plan', currentRevisionId: '0123456789abcdef',
      capabilityIds: ['planning.plan.create'], primaryCapabilityId: 'planning.plan.create',
    } as const
    await client.create(definition as never, [{ edit: 'plan', title: 'Week 47' }])
    await client.refresh(plan, 4)
    expect(calls[0]!.body).toEqual({ definition: { ...definition.ref, revisionId: '0123456789abcdef' }, input: { edits: [{ edit: 'plan', title: 'Week 47' }] }, actor: { kind: 'human' } })
    expect(calls[1]!.body).toEqual({ expectedRevision: 4, input: { plan }, actor: { kind: 'human' } })

    const facts = recording({ result: { run: { workspaceId: workspace, moduleId: 'world', type: 'world.simulation-run', id: 'run-1' }, observedAt: '2026-11-12T09:00:00Z', items: [] } })
    await facts.client.facts('run-1', { text: 'pump', limit: 10 })
    expect(facts.calls[0]!.path).toBe(`/api/workspaces/${workspace}/capabilities/world.simulation-run.planning-facts/invoke`)
    expect(facts.calls[0]!.body!.resource).toEqual({ workspaceId: workspace, moduleId: 'world', type: 'world.simulation-run', id: 'run-1' })
  })

  test('Generate can be cancelled: the abort signal reaches the request', async () => {
    const { client, calls } = recording({ result: { plan: { id: plan, revision: 4 }, options: [], text: 'No options.' } })
    await client.generate(plan, 4, {}, new AbortController().signal)
    expect(calls[0]!.signal).toBe(true)
  })

  test('a refusal keeps its code and details; a malformed answer is refused, never replaced', async () => {
    const refused = recording({ error: { code: 'needs_authority', message: 'Removing SW B from the protected rule needs someone\'s agreement.', details: { weakens: ['R1'] } } }, 409)
    const error = await refused.client.edit(plan, 3, { edits: [{ edit: 'plan', title: 'x' }] }).catch((cause: unknown) => cause)
    expect(isRequestError(error) && [error.status, error.code, error.details]).toEqual([409, 'needs_authority', { weakens: ['R1'] }])
    expect(refusalText(error)).toBe('Removing SW B from the protected rule needs someone\'s agreement.')
    const busy = recording({ error: { code: 'planning_busy', message: 'busy' } }, 503)
    expect(refusalText(await busy.client.generate(plan, 3, {}).catch((cause: unknown) => cause))).toBe('Planning is busy with other plans. Try again in a moment.')
    const malformed = recording({ result: { plan: { id: plan }, changed: [] } })
    await expect(malformed.client.edit(plan, 3, { edits: [{ edit: 'plan', title: 'x' }] })).rejects.toThrow()
  })
})
