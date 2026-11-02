import { expect, test } from 'bun:test'
import { newWorkspaceId, perspectiveViewLeaseSchema } from '@leitbild/contracts'
import { createPerspectiveViewSession, parsePerspectiveViewLease } from './perspective-view.ts'

const fixture = (expiresAt = '2030-01-01T00:01:00.000Z') => {
  const workspaceId = newWorkspaceId()
  const lease = perspectiveViewLeaseSchema.parse({ token: crypto.randomUUID(), documentId: crypto.randomUUID(), expiresAt,
    room: { workspaceId, moduleId: 'agents', type: 'agents.room', id: 'private-room' },
    perspective: { workspaceId, moduleId: 'world', type: 'world.perspective', id: 'private-perspective' } })
  const url = new URL(`https://leitbild.invalid/workspaces/${workspaceId}/agents?room=${lease.room.id}&view=focused#perspective-view=${encodeURIComponent(JSON.stringify(lease))}`)
  return { lease, url }
}

test('private browser credentials are removed from the URL before startup, remain memory-only and bind one Room/document', () => {
  const { lease, url } = fixture(), stripped: string[] = []
  const view = createPerspectiveViewSession({ url, now: () => Date.parse('2030-01-01T00:00:00Z'), stripFragment: () => { url.hash = ''; stripped.push(url.href) } })
  expect(stripped).toHaveLength(1)
  expect(stripped[0]).not.toContain(lease.token)
  expect(view.privateIntent).toBe(true)
  expect(view.status()).toBe('connecting')
  expect(view.canSubmit(lease.room.id)).toBe(false)
  view.connected(true)
  expect(view.canSubmit(lease.room.id)).toBe(true)
  expect(view.canSubmit('other-room')).toBe(false)
  const exposed = view.current()!
  exposed.room.id = 'tampered' as typeof exposed.room.id
  expect(view.current()!.room.id).toBe(lease.room.id)
})

test('expired fragment waits for exact owner renewal; another Room/document/token never revives it', async () => {
  const { lease, url } = fixture('2029-12-31T23:59:59Z')
  const view = createPerspectiveViewSession({ url, now: () => Date.parse('2030-01-01T00:00:00Z'), stripFragment: () => { url.hash = '' } })
  expect(view.status()).toBe('expired')
  expect(() => view.requireLease()).toThrow('unavailable')
  let started = false
  const startup = view.waitForLease().then(() => { started = true })
  const renewed = { ...lease, expiresAt: '2030-01-01T00:01:00Z' }
  expect(view.accept({ ...renewed, documentId: crypto.randomUUID() })).toBe(false)
  expect(view.accept({ ...renewed, token: crypto.randomUUID() })).toBe(false)
  expect(view.accept({ ...renewed, room: { ...lease.room, id: 'other-room' } })).toBe(false)
  await Promise.resolve()
  expect(started).toBe(false)
  expect(view.accept(renewed)).toBe(true)
  await startup
  expect(started).toBe(true)
  expect(view.current()!.token).toBe(lease.token)
  expect(view.status()).toBe('connecting')
  view.connected(true)
  expect(view.canSubmit(lease.room.id)).toBe(true)
})

test('malformed private intent stays locked instead of falling back to an ordinary Agent view', async () => {
  const { url, lease } = fixture()
  url.hash = 'perspective-view=not-json'
  let stripped = false
  const invalid = createPerspectiveViewSession({ url, stripFragment: () => { stripped = true; url.hash = '' } })
  expect(stripped).toBe(true)
  expect(invalid.privateIntent).toBe(true)
  expect(invalid.current()).toBeUndefined()
  expect(() => invalid.requireLease()).toThrow('unavailable')
  await expect(invalid.waitForLease()).rejects.toThrow('Invalid Perspective')
  expect(invalid.accept(lease)).toBe(false)
  const ordinary = createPerspectiveViewSession({ url: new URL('https://leitbild.invalid/'), stripFragment: () => { throw new Error('Ordinary URL must be unchanged') } })
  expect(ordinary.requireLease()).toBeUndefined()
  expect(ordinary.status()).toBe('open')
  expect(ordinary.accept(lease)).toBe(false)
})

test('browser lease parser rejects extra fields, wrong owner/Workspace and canonical Run substitution', () => {
  const { lease, url } = fixture()
  expect(parsePerspectiveViewLease(lease)).toEqual(lease)
  expect(parsePerspectiveViewLease({ ...lease, roleIds: ['controller'] })).toBeNull()
  expect(parsePerspectiveViewLease({ ...lease, perspective: { ...lease.perspective, type: 'world.simulation-run' } })).toBeNull()
  expect(parsePerspectiveViewLease({ ...lease, room: { ...lease.room, workspaceId: newWorkspaceId() } })).toBeNull()
  url.searchParams.set('room', 'other-room')
  const misplaced = createPerspectiveViewSession({ url, stripFragment: () => { url.hash = '' } })
  expect(misplaced.current()).toBeUndefined()
  expect(misplaced.status()).toBe('unavailable')
})
