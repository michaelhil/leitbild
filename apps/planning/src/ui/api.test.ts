// The screen reaches Planning and World only through Host's invoke route, with the plan Resource or
// the Definition as the target and the revision in the envelope. Refusals keep their code.
import { describe, expect, test } from 'bun:test'
import { createPlanningClient, isRequestError, refusalText } from './api.ts'

const workspace = '0b4b9a52-2f7e-4c1a-9d3e-00000000000a'
const plan = '0b4b9a52-2f7e-4c1a-9d3e-0000000000aa'
const write = { plan: { id: plan, title: 'Week 47', revision: 4 }, target: { kind: 'resource', ref: { workspaceId: workspace, moduleId: 'planning', type: 'planning.plan', id: plan } }, changed: [], attention: [], problems: [] }

const recording = (answer: unknown, status = 200) => {
  const calls: Array<{ path: string; body: Record<string, unknown> | null; signal: boolean }> = []
  const client = createPlanningClient(workspace, async (path, init) => {
    calls.push({ path: String(path), body: init?.body === undefined ? null : JSON.parse(String(init.body)), signal: init?.signal !== undefined })
    return Response.json(answer, { status })
  })
  return { client, calls }
}

describe('refusals in planner words', () => {
  test('each refusal the Module gives reads in planner words, with names for keys and no ids', async () => {
    const refused = async (code: string, message: string, details?: Record<string, unknown>) => {
      const client = createPlanningClient(workspace, async () => Response.json({ error: { code, message, ...(details === undefined ? {} : { details }) } }, { status: 409 }))
      return refusalText(await client.generate(plan, 3, {}).catch((cause: unknown) => cause), key => ({ 'SWA-RTS': 'Restore SW A', R1: 'Train B is never touched' })[key] ?? 'an item')
    }
    expect(await refused('generate_running', 'Generate is already working')).toBe('Generate is already working on this plan. Wait for it to finish; its options then appear here.')
    expect(await refused('baseline_limit', 'This plan already keeps 32 baselines', { maxBaselines: 32 })).toBe('This plan already keeps as many baselines as a plan may keep, so no more can be saved.')
    expect(await refused('plan_too_large', 'This change would make the plan 3.1 MB', { bytes: 3_100_000, limit: 2_000_000 })).toBe('This change would make the plan larger than a plan may hold. Nothing was saved; remove what the plan does not need.')
    expect(await refused('world_read_limit', 'This plan names 40 Einsatz items')).toBe('This plan names more World items than can be read together (at most 32). Remove the items the plan does not need; nothing was read.')
    expect(await refused('below_minimum', 'SWA-RTS would run shorter', { about: ['SWA-RTS'] })).toBe('Restore SW A would run shorter than its declared minimum. Name the person who agreed and their reason. Ask them; never fill this in yourself.')
    expect(await refused('needs_authority', 'Edit 1 weakens (rule: R1)', { about: ['R1'], weakens: ['R1'] })).toBe('This weakens a hard rule\'s coverage (Train B is never touched). Name the person who agreed and their reason. Ask them; never fill this in yourself.')
    expect(await refused('invalid_request', 'The plan would not be valid: x at rules.0', { issues: [{ path: ['rules', '0'], message: 'A due time lies inside the plan window' }] })).toBe('This change is not valid: A due time lies inside the plan window.')
  })
})

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
    expect(refusalText(error, key => key === 'R1' ? '“Train B is never touched”' : key)).toBe('This weakens a hard rule\'s coverage (“Train B is never touched”). Name the person who agreed and their reason. Ask them; never fill this in yourself.')
    const busy = recording({ error: { code: 'planning_busy', message: 'busy' } }, 503)
    expect(refusalText(await busy.client.generate(plan, 3, {}).catch((cause: unknown) => cause))).toBe('Planning is busy with other plans. Try again in a moment.')
    const malformed = recording({ result: { plan: { id: plan }, changed: [] } })
    await expect(malformed.client.edit(plan, 3, { edits: [{ edit: 'plan', title: 'x' }] })).rejects.toThrow()
  })
})
