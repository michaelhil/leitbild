import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newWorkspaceId, workspaceRoomScopeSchema } from '@leitbild/contracts'
import { createRoomDirectory } from '../rooms/directory.ts'
import { createWorkspaceSettings } from '../workspaces/settings.ts'
import { createBookmarkStore } from '../workspaces/bookmark-store.ts'
import { createTeam } from '../../agents/team.ts'
import { workspaceModulePaths } from '../paths.ts'
import { loadWorkspaceModuleSnapshots, restoreWorkspaceModuleSnapshots, saveWorkspaceModuleSnapshots, serializeModuleSnapshots, type WorkspaceModuleSnapshots } from './module-snapshots.ts'
import type { Message, PostParams, RoomProfile } from '../types/messaging.ts'

let root: string | undefined
afterEach(async () => { if (root !== undefined) await rm(root, { recursive: true, force: true }); root = undefined })

const fixture = () => {
  const state = { rooms: createRoomDirectory(), team: createTeam(), settings: createWorkspaceSettings(), bookmarks: createBookmarkStore() }
  const room = state.rooms.createRoom({ name: 'Ordinary', createdBy: 'human' })
  room.post({ senderId: 'human', type: 'chat', content: 'Retain ordinary history' })
  return { state, room, snapshots: serializeModuleSnapshots(state) }
}
const retiredScope = () => workspaceRoomScopeSchema.parse({ kind: 'resource', resource: { workspaceId: newWorkspaceId(), moduleId: 'world', type: 'world.perspective', id: 'retired' } })

test('retired private scope and provenance cannot be created, applied, posted or injected as ordinary data', () => {
  const { state, room } = fixture(), before = room.getRetainedMessages()
  expect(() => state.rooms.createRoom({ name: 'Retired', createdBy: 'human', scope: retiredScope() })).toThrow('Retired private')
  expect(() => room.setScope(retiredScope(), 0)).toThrow('Retired private')
  expect(room.profile.scope).toEqual({ kind: 'workspace' })
  expect(room.profile.scopeRevision).toBe(0)
  expect(() => createRoomDirectory().restoreRoom({ ...room.profile, perspective: {} } as RoomProfile)).toThrow('provenance')
  expect(() => room.post({ senderId: 'human', type: 'chat', content: 'Private', perspective: {} } as PostParams)).toThrow('provenance')
  expect(() => room.injectMessages([{ ...before[0]!, perspective: {} } as Message])).toThrow('provenance')
  expect(room.getRetainedMessages()).toEqual(before)
  expect(state.rooms.listAllRooms()).toHaveLength(1)
})

test('unsupported snapshot imports reject before any Room, Agent or settings mutation', async () => {
  const { snapshots } = fixture()
  const variants = [
    { ...snapshots, rooms: { ...snapshots.rooms, rooms: [{ ...snapshots.rooms.rooms[0]!, profile: { ...snapshots.rooms.rooms[0]!.profile, scope: retiredScope() } }] } },
    { ...snapshots, rooms: { ...snapshots.rooms, rooms: [{ ...snapshots.rooms.rooms[0]!, profile: { ...snapshots.rooms.rooms[0]!.profile, perspective: {} } }] } },
    { ...snapshots, rooms: { ...snapshots.rooms, rooms: [{ ...snapshots.rooms.rooms[0]!, messages: [{ ...snapshots.rooms.rooms[0]!.messages[0]!, perspective: {} }] }] } },
    { ...snapshots, agents: { ...snapshots.agents, agents: [{ id: 'orphan-private-agent', config: { name: 'Orphan', model: 'fixture', persona: 'Private', ownerRoomId: 'missing' } }] } },
    { ...snapshots, inspections: { ...snapshots.inspections, rooms: [{ roomId: 'missing', records: [] }] } },
  ]
  for (const variant of variants) {
    const target = { rooms: createRoomDirectory(), settings: createWorkspaceSettings(), bookmarks: createBookmarkStore(), spawnAIAgent: async () => { throw new Error('must not spawn') } }
    await expect(restoreWorkspaceModuleSnapshots(target, variant as WorkspaceModuleSnapshots)).rejects.toThrow()
    expect(target.rooms.listAllRooms()).toEqual([])
  }
})

test('raw files and atomic commit records reject retired scope and orphan ownership without rewriting source data', async () => {
  root = await mkdtemp(join(tmpdir(), 'retired-agent-state-'))
  // Keep the path factory independent of the process-wide storage setting.
  const workspaceId = newWorkspaceId(), standard = workspaceModulePaths(workspaceId)
  const paths = { ...standard, agents: { ...standard.agents, root: join(root, 'agents'), snapshot: join(root, 'agents.json'), inspections: join(root, 'inspections.json') }, rooms: { ...standard.rooms, snapshot: join(root, 'rooms.json') } }
  const { snapshots } = fixture()
  await saveWorkspaceModuleSnapshots(snapshots, paths)
  expect((await loadWorkspaceModuleSnapshots(paths)).rooms?.rooms[0]?.messages[0]?.content).toBe('Retain ordinary history')
  const raw = { ...snapshots.rooms, rooms: [{ ...snapshots.rooms.rooms[0]!, profile: { ...snapshots.rooms.rooms[0]!.profile, scope: retiredScope() } }] }
  const encoded = JSON.stringify(raw)
  await Bun.write(paths.rooms.snapshot, encoded)
  await expect(loadWorkspaceModuleSnapshots(paths)).rejects.toThrow('Retired private')
  expect(await Bun.file(paths.rooms.snapshot).text()).toBe(encoded)
  await Bun.write(paths.rooms.snapshot, JSON.stringify(snapshots.rooms))
  const orphan = { ...snapshots, agents: { ...snapshots.agents, agents: [{ id: 'orphan', config: { name: 'Orphan', model: 'fixture', persona: '', ownerRoomId: 'missing' } }] } }
  await mkdir(paths.agents.root, { recursive: true })
  const commit = join(paths.agents.root, 'snapshot-commit.json'), committed = JSON.stringify(orphan)
  await Bun.write(commit, committed)
  await expect(loadWorkspaceModuleSnapshots(paths)).rejects.toThrow('orphan state')
  expect(await Bun.file(commit).text()).toBe(committed)
})
