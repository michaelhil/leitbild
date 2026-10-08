import { describe, expect, test } from 'bun:test'
import { newWorkspaceId } from '@leitbild/contracts'
import { resolveViewFence } from './resolve.ts'

const workspaceId = newWorkspaceId()
const run = { workspaceId, moduleId: 'world', type: 'world.simulation-run', id: 'run-1' }
const envelope = { viewType: 'process-plant.display', title: 'Pressure', height: 340, state: '{"composition":{}}', moduleId: 'world', subject: run }
const origin = { roomId: 'room-1', turnId: 'turn-1', workspaceId }

const evidence = (results: ReadonlyArray<unknown>, tool = 'workspace_call') => ({ id: 'call_1_0', tool, arguments: {}, result: { success: true, data: { results } } })

const fetching = (status: number, body: unknown) => {
  const paths: string[] = []
  return { paths, fetchJson: async (path: string) => { paths.push(path); return { status, body } } }
}

describe('resolving leitbild-view fences', () => {
  test('reads the envelope from the answer turn evidence, never from the fence', async () => {
    const { paths, fetchJson } = fetching(200, evidence([{ key: 'display', embeddedView: envelope }]))
    const result = await resolveViewFence('view call_1_0/display', origin, fetchJson)
    expect(result).toMatchObject({ kind: 'view', envelope: { title: 'Pressure', subject: run } })
    expect(paths).toEqual(['/rooms/room-1/executions/turn-1/calls/call_1_0'])
  })

  test('names why a display cannot be shown', async () => {
    expect(await resolveViewFence('https://evil.example/', origin, fetching(200, null).fetchJson)).toMatchObject({ code: 'view_reference_invalid' })
    expect(await resolveViewFence('view call_1_0/display', origin, fetching(404, null).fetchJson)).toMatchObject({ code: 'view_evidence_unavailable' })
    expect(await resolveViewFence('view call_1_0/other', origin, fetching(200, evidence([{ key: 'display', embeddedView: envelope }])).fetchJson)).toMatchObject({ code: 'view_evidence_mismatch' })
    expect(await resolveViewFence('view call_1_0/display', origin, fetching(200, evidence([{ key: 'display', embeddedView: envelope }], 'web_fetch')).fetchJson)).toMatchObject({ code: 'view_evidence_mismatch' })
    expect(await resolveViewFence('view call_1_0/display', { ...origin, workspaceId: newWorkspaceId() }, fetching(200, evidence([{ key: 'display', embeddedView: envelope }])).fetchJson)).toMatchObject({ code: 'view_workspace_mismatch' })
  })
})
