import { describe, expect, test } from 'bun:test'
import { newWorkspaceId } from '@leitbild/contracts'
import { checkViewEnvelope, embeddedViewFor, parseViewFenceBody, viewRefFor } from './view-fence.ts'

const workspaceId = newWorkspaceId()
const run = { workspaceId, moduleId: 'world', type: 'world.simulation-run', id: 'run-1' }
const publication = { viewType: 'process-plant.display', title: 'Pressure', height: 340, state: '{"composition":{}}' }

describe('leitbild-view fences', () => {
  test('round-trip a viewRef through the fence body', () => {
    const ref = viewRefFor('call_3_1', 'sg b/level')
    expect(ref).toBe('call_3_1/sg%20b%2Flevel')
    expect(parseViewFenceBody(`view ${ref}\n`)).toEqual({ ok: true, ref: { callId: 'call_3_1', key: 'sg b/level' } })
  })

  test('reject bodies that are not a single view reference', () => {
    for (const body of ['https://evil.example', 'view /workspaces/x/world/embed/a', '{"view":"x"}', 'view call_1_0/a\nview call_1_0/b', 'view call_1_0/%E0%A4%A']) {
      expect(parseViewFenceBody(body).ok).toBe(false)
    }
  })

  test('complete a publication with the invoked Resource and reject malformed ones explicitly', () => {
    const completed = embeddedViewFor({ view: publication }, run as never)
    expect(completed).toMatchObject({ kind: 'view', envelope: { ...publication, moduleId: 'world', subject: run } })
    expect(embeddedViewFor({ shows: [] }, run as never)).toEqual({ kind: 'none' })
    expect(embeddedViewFor({ view: { ...publication, height: 9_999 } }, run as never).kind).toBe('invalid')
  })

  test('name the rule that refuses an envelope', () => {
    const envelope = { ...publication, moduleId: 'world', subject: run }
    expect(checkViewEnvelope(envelope, workspaceId).ok).toBe(true)
    expect(checkViewEnvelope(envelope, newWorkspaceId())).toMatchObject({ ok: false, code: 'view_workspace_mismatch' })
    const agentsSubject = { ...run, moduleId: 'agents', type: 'agents.room' }
    expect(checkViewEnvelope({ ...envelope, moduleId: 'agents', subject: agentsSubject }, workspaceId)).toMatchObject({ ok: false, code: 'view_module_not_embeddable' })
    expect(checkViewEnvelope({ ...envelope, url: 'https://evil.example' }, workspaceId)).toMatchObject({ ok: false, code: 'view_envelope_invalid' })
  })
})
