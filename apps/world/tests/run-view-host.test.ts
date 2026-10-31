import { describe, expect, test } from 'bun:test'
import { newWorkspaceId, workspaceResourceReferenceSchema, type UiControl, type WorkspaceResourceReference } from '@leitbild/contracts'
import { createRunViewHost } from '../src/ui/run-view-host.ts'
const subject = workspaceResourceReferenceSchema.parse({ workspaceId: newWorkspaceId(), moduleId: 'world', type: 'world.simulation-run', id: 'run-a' })
const challenge = { type: 'leitbild:ui-controls-host', subject, channel: 'fresh-document' }
const set = { type: 'leitbild:ui-controls-set', subject, channel: 'fresh-document', id: 'panel:ops', visible: false }
describe('World client-only View controls host', () => {
  test('publishes complete state/count; no command until exact scope/channel and currently enabled control', () => {
    const posts: unknown[] = [], changes: unknown[] = [], errors: string[] = []
    let controls: UiControl[] = [{ id: 'panel:ops', label: 'Operations', visible: true }]
    const host = createRunViewHost({ subject, post: value => posts.push(value), controls: () => controls, notification: () => ({ count: 17, label: '17 unacknowledged alarms' }), set: (id, visible) => changes.push({ id, visible }), error: reason => errors.push(reason) })
    host.receive(set); expect(changes).toEqual([])
    host.ready(); expect(posts[0]).toEqual({ type: 'leitbild:ui-controls-ready', subject })
    host.receive(challenge); expect(posts.at(-1)).toEqual({ type: 'leitbild:ui-controls-offer', subject, channel: 'fresh-document', controls, notification: { count: 17, label: '17 unacknowledged alarms' } })
    host.receive({ ...set, channel: 'old-document' }); host.receive({ ...set, subject: { ...subject, id: 'run-b' } }); expect(changes).toEqual([])
    host.receive(set); expect(changes).toEqual([{ id: 'panel:ops', visible: false }])
    controls = [{ ...controls[0]!, disabledReason: 'Finish or cancel targeting' }]
    host.receive(set); host.receive({ ...set, id: 'unknown' }); expect(changes).toHaveLength(1)
    host.close(); host.receive(set); expect(changes).toHaveLength(1)
    expect(errors).toEqual([])
  })
  test('owned malformed channels are refused, unrelated messages ignored, new host readiness supersedes old', () => {
    const errors: string[] = [], changes: string[] = []
    const host = createRunViewHost({ subject, post: () => {}, controls: () => [{ id: 'panel:ops', label: 'Operations', visible: true }], notification: () => undefined, set: id => changes.push(id), error: value => errors.push(value) })
    host.receive({ type: 'leitbild:view-host' }); expect(errors).toEqual([])
    host.receive({ ...challenge, unexpected: true }); expect(errors).toHaveLength(1)
    host.receive(challenge); host.receive({ ...challenge, channel: 'new-document' }); host.receive(set); expect(changes).toEqual([])
    host.receive({ ...set, channel: 'new-document' }); expect(changes).toEqual(['panel:ops'])
  })
})
