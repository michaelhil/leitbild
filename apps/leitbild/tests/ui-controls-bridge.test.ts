import { describe, expect, test } from 'bun:test'
import { newWorkspaceId, workspaceResourceReferenceSchema, type UiControlsOfferMessage, type WorkspaceResourceReference } from '@leitbild/contracts'
import { createUiControlsBridge } from '../src/ui/ui-controls-bridge.ts'
const subject = workspaceResourceReferenceSchema.parse({ workspaceId: newWorkspaceId(), moduleId: 'world', type: 'world.simulation-run', id: 'run-a' })
const ready = { type: 'leitbild:ui-controls-ready', subject }
const offered = (channel: string, resource = subject): UiControlsOfferMessage => ({ type: 'leitbild:ui-controls-offer', subject: resource, channel, controls: [{ id: 'opaque-pack-panel', label: 'A Pack panel', visible: false }] })
const harness = () => {
  let resource: WorkspaceResourceReference | null = subject, serial = 0
  const posts: unknown[] = [], offers: Array<UiControlsOfferMessage | null> = [], errors: string[] = []
  const bridge = createUiControlsBridge({ subject: () => resource, post: value => posts.push(value), offer: value => offers.push(value), error: value => errors.push(value), channel: () => `document-${++serial}` })
  return { bridge, posts, offers, errors, resource: (value: WorkspaceResourceReference | null) => { resource = value } }
}
describe('Host generic View controls bridge', () => {
  test('requires readiness, current document challenge and exact Run before relaying opaque choices', () => {
    const h = harness()
    h.bridge.receive(offered('unoffered')); h.bridge.set('opaque-pack-panel', true)
    expect(h.posts).toEqual([])
    h.bridge.receive(ready); h.bridge.receive(offered('document-1')); h.bridge.set('opaque-pack-panel', true)
    expect(h.posts.at(-1)).toEqual({ type: 'leitbild:ui-controls-set', subject, channel: 'document-1', id: 'opaque-pack-panel', visible: true })
    h.bridge.set('unknown', true); expect(h.posts).toHaveLength(2)
    h.resource(workspaceResourceReferenceSchema.parse({ ...subject, id: 'run-b' })); h.bridge.set('opaque-pack-panel', true)
    expect(h.posts).toHaveLength(2)
    h.bridge.receive(offered('document-1')); expect(String(h.offers.at(-1)?.subject.id)).toBe('run-a')
    h.bridge.clear(); expect(h.offers.at(-1)).toBeNull()
  })
  test('reload/handoff rotates channel and refuses stale queued offers', () => {
    const h = harness(); h.bridge.receive(ready); h.bridge.receive(offered('document-1'))
    h.bridge.clear(); h.bridge.receive(ready); h.bridge.receive(offered('document-1'))
    expect(h.offers.at(-1)).toBeNull()
    h.bridge.receive(offered('document-2')); expect(h.offers.at(-1)?.channel).toBe('document-2')
    h.bridge.receive({ ...offered('document-2'), controls: [{ id: 'opaque-pack-panel', label: 'Capture owner', visible: true, disabledReason: 'Finish operation' }] })
    h.bridge.set('opaque-pack-panel', false); expect(h.posts).toHaveLength(2)
  })
  test('unrelated protocols coexist; malformed owned messages fail without publishing partial controls', () => {
    const h = harness(); h.bridge.receive({ type: 'world:layout-inspection-sample' }); expect(h.errors).toEqual([])
    expect(h.bridge.receive({ ...ready, extra: true })).toBe(false); expect(h.posts).toEqual([]); expect(h.errors).toHaveLength(1)
    expect(h.bridge.receive(ready)).toBe(true); const message = offered('document-1')
    h.bridge.receive({ ...message, controls: [...message.controls, ...message.controls] })
    expect(h.offers.at(-1)).toBeNull(); expect(h.errors).toHaveLength(2)
  })
})
