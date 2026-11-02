import { expect, test } from 'bun:test'
import { newWorkspaceId, worldPerspectiveReferenceSchema } from '@leitbild/contracts'
import { createRoomDirectory } from '../../core/rooms/directory.ts'
import type { AgentsWorkspaceRuntime } from '../../workspace-runtime.ts'
import { roomRoutes } from './rooms.ts'
import type { RouteContext } from './types.ts'

const fixture = () => {
  const rooms = createRoomDirectory()
  let creations = 0
  // The direct route handler needs only the real Room creation owner port.
  // Other Workspace services are deliberately absent from this route fixture.
  const system: Pick<AgentsWorkspaceRuntime, 'createRoom'> = {
    createRoom: async config => { creations++; return rooms.createRoomSafe(config) },
  }
  const route = roomRoutes.find(entry => entry.method === 'POST' && entry.pattern.test('/rooms'))!
  const post = (body: unknown) => route.handler(new Request('http://agents.test/rooms', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }), '/rooms'.match(route.pattern)!, { system } as unknown as RouteContext)
  return { rooms, post, creations: () => creations }
}

test('legacy Room creation refuses any supplied scope without creating a public or private Room', async () => {
  const f = fixture()
  const perspective = worldPerspectiveReferenceSchema.parse({ workspaceId: newWorkspaceId(), moduleId: 'world', type: 'world.perspective', id: 'pending-perspective' })
  for (const scope of [{}, { kind: 'resource', resource: perspective }, { kind: 'workspace' }, null]) {
    const response = await f.post({ name: 'Must not become public', roomPrompt: 'Private intended prompt', scope })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ code: 'room_scope_unsupported' })
    expect(f.rooms.listAllRooms()).toHaveLength(0)
    expect(f.creations()).toBe(0)
  }
})

test('legacy Room creation preserves ordinary name, prompt and attributed creator', async () => {
  const f = fixture()
  const response = await f.post({ name: 'Ordinary discussion', roomPrompt: 'Keep observations separate from decisions.', createdBy: 'human:fixture' })
  expect(response.status).toBe(201)
  expect(await response.json()).toMatchObject({ value: { profile: {
    name: 'Ordinary discussion', roomPrompt: 'Keep observations separate from decisions.', createdBy: 'human:fixture', scope: { kind: 'workspace' },
  } } })
  expect(f.rooms.listAllRooms()).toHaveLength(1)
  expect(f.creations()).toBe(1)
})
