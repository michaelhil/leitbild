import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newWorkspaceId } from '@leitbild/contracts'
import { createTeam } from '../../agents/team.ts'
import { createRoomDirectory } from '../rooms/directory.ts'
import { workspaceModulePaths } from '../paths.ts'
import { createBookmarkStore } from '../workspaces/bookmark-store.ts'
import { createWorkspaceSettings } from '../workspaces/settings.ts'
import type { Agent, AIAgentConfig } from '../types/agent.ts'
import {
  appendRoomsPendingScrub,
  loadWorkspaceModuleSnapshots,
  restoreWorkspaceModuleSnapshots,
  saveWorkspaceModuleSnapshots,
  serializeModuleSnapshots,
} from './module-snapshots.ts'

let temporaryRoot = ''

afterEach(async () => {
  if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true })
  temporaryRoot = ''
})

const fakeState: Agent['state'] = {
  get: () => 'idle',
  getContext: () => undefined,
  getStartedAt: () => undefined,
  subscribe: () => () => {},
}

const fakeAi = (id: string, config: AIAgentConfig): Agent => ({
  id,
  name: config.name,
  kind: 'ai',
  metadata: {},
  state: fakeState,
  receive: () => {},
  join: async () => {},
  leave: () => {},
  getConfig: () => config,
} as Agent)

const runtime = () => {
  const rooms = createRoomDirectory({})
  const settings = createWorkspaceSettings()
  const bookmarks = createBookmarkStore()
  const team = createTeam()
  return { rooms, settings, bookmarks, team }
}

describe('Workspace Module snapshots', () => {
  test('separates Room state from Agent Profiles inside the Agents Module', () => {
    const source = runtime()
    const room = source.rooms.createRoom({ name: 'Operations', createdBy: 'human-1' })
    room.restoreState({
      members: ['agent-1'],
      muted: [],
      mode: 'broadcast',
      paused: false,
      activePacks: ['core'],
    })
    source.team.addAgent(fakeAi('agent-1', {
      name: 'Analyst',
      model: 'test-model',
      persona: 'Analyse evidence.',
    }))
    source.bookmarks.add('Decision record')

    const snapshots = serializeModuleSnapshots(source)

    expect(snapshots.rooms.rooms).toHaveLength(1)
    expect(snapshots.rooms.bookmarks).toHaveLength(1)
    expect(snapshots.rooms).not.toHaveProperty('agents')
    expect(snapshots.agents.agents).toHaveLength(1)
    expect(snapshots.agents).not.toHaveProperty('rooms')
    expect(snapshots.agents.agents[0]).not.toHaveProperty('roomIds')
  })

  test('persists and loads Room and Agent documents independently', async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'module-snapshots-'))
    const priorHome = process.env.LEITBILD_HOME
    process.env.LEITBILD_HOME = temporaryRoot
    try {
      const workspaceId = newWorkspaceId()
      const paths = workspaceModulePaths(workspaceId)
      const source = runtime()
      source.rooms.createRoom({ name: 'Operations', createdBy: 'human-1' })
      source.team.addAgent(fakeAi('agent-1', {
        name: 'Analyst',
        model: 'test-model',
        persona: 'Analyse evidence.',
      }))
      const snapshots = serializeModuleSnapshots(source)
      await saveWorkspaceModuleSnapshots(snapshots, paths)

      const both = await loadWorkspaceModuleSnapshots(paths)
      expect(both.rooms?.rooms).toHaveLength(1)
      expect(both.agents?.agents).toHaveLength(1)

      await rm(paths.agents.snapshot, { force: true })
      const roomsOnly = await loadWorkspaceModuleSnapshots(paths)
      expect(roomsOnly.rooms?.rooms).toHaveLength(1)
      expect(roomsOnly.agents).toBeNull()
    } finally {
      if (priorHome === undefined) delete process.env.LEITBILD_HOME
      else process.env.LEITBILD_HOME = priorHome
    }
  })

  test('rejects obsolete or cross-owned fields instead of migrating them', async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'module-snapshots-invalid-'))
    const priorHome = process.env.LEITBILD_HOME
    process.env.LEITBILD_HOME = temporaryRoot
    try {
      const paths = workspaceModulePaths(newWorkspaceId())
      await Bun.write(paths.rooms.snapshot, JSON.stringify({
        schemaVersion: 29,
        savedAt: new Date().toISOString(),
        rooms: [],
        humanActors: [],
        bookmarks: [],
        agents: [],
      }))
      expect(loadWorkspaceModuleSnapshots(paths)).rejects.toThrow()
    } finally {
      if (priorHome === undefined) delete process.env.LEITBILD_HOME
      else process.env.LEITBILD_HOME = priorHome
    }
  })

  test('restores Agent Room membership across internal persistence documents', async () => {
    const source = runtime()
    const room = source.rooms.createRoom({ name: 'Operations', createdBy: 'human-1' })
    room.restoreState({
      members: ['agent-1'],
      muted: [],
      mode: 'broadcast',
      paused: false,
      activePacks: ['core'],
    })
    source.team.addAgent(fakeAi('agent-1', {
      name: 'Analyst',
      model: 'test-model',
      persona: 'Analyse evidence.',
    }))
    const snapshots = serializeModuleSnapshots(source)

    const target = runtime()
    const joined: string[] = []
    await restoreWorkspaceModuleSnapshots({
      ...target,
      spawnAIAgent: async (config, options) => {
        target.team.addAgent({
          ...fakeAi(options!.overrideId!, config),
          join: async restoredRoom => { joined.push(restoredRoom.profile.id) },
        })
      },
    }, snapshots)

    expect(joined).toEqual([room.profile.id])
    expect(target.rooms.getRoom(room.profile.id)?.getParticipantIds()).toContain('agent-1')
  })

  test('queues Pack scrubs only in Room state', async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'module-scrub-'))
    const priorHome = process.env.LEITBILD_HOME
    process.env.LEITBILD_HOME = temporaryRoot
    try {
      const paths = workspaceModulePaths(newWorkspaceId())
      const source = runtime()
      source.rooms.createRoom({ name: 'Operations', createdBy: 'human-1' }).setActivePacks(['site-survey'])
      await saveWorkspaceModuleSnapshots(serializeModuleSnapshots(source), paths)
      expect((await appendRoomsPendingScrub(paths.rooms.snapshot, {
        packId: 'site-survey',
        scheduledAt: '2026-08-29T18:00:00.000Z',
      })).applied).toBe(true)
      const loaded = await loadWorkspaceModuleSnapshots(paths)
      expect(loaded.rooms?.pendingScrubs?.[0]?.packId).toBe('site-survey')
    } finally {
      if (priorHome === undefined) delete process.env.LEITBILD_HOME
      else process.env.LEITBILD_HOME = priorHome
    }
  })
})
