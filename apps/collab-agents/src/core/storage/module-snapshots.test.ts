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
  appendCollabPendingScrub,
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
  test('separates Collab state from Agent Profiles', () => {
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

    expect(snapshots.collab.rooms).toHaveLength(1)
    expect(snapshots.collab.bookmarks).toHaveLength(1)
    expect(snapshots.collab).not.toHaveProperty('agents')
    expect(snapshots.agents.agents).toHaveLength(1)
    expect(snapshots.agents).not.toHaveProperty('rooms')
    expect(snapshots.agents.agents[0]).not.toHaveProperty('roomIds')
  })

  test('persists, loads, and removes Module state independently', async () => {
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
      await saveWorkspaceModuleSnapshots(snapshots, paths, new Set(['collab', 'agents']))

      const both = await loadWorkspaceModuleSnapshots(paths, new Set(['collab', 'agents']))
      expect(both.collab?.rooms).toHaveLength(1)
      expect(both.agents?.agents).toHaveLength(1)

      await rm(paths.agents.root, { recursive: true, force: true })
      const collabOnly = await loadWorkspaceModuleSnapshots(paths, new Set(['collab']))
      expect(collabOnly.collab?.rooms).toHaveLength(1)
      expect(collabOnly.agents).toBeNull()
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
      await Bun.write(paths.collab.snapshot, JSON.stringify({
        schemaVersion: 29,
        savedAt: new Date().toISOString(),
        rooms: [],
        humanActors: [],
        bookmarks: [],
        agents: [],
      }))
      expect(loadWorkspaceModuleSnapshots(paths, new Set(['collab']))).rejects.toThrow()
    } finally {
      if (priorHome === undefined) delete process.env.LEITBILD_HOME
      else process.env.LEITBILD_HOME = priorHome
    }
  })

  test('restores Agent Room membership from Collab ownership', async () => {
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

  test('queues Pack scrubs only in Collab state', async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'module-scrub-'))
    const priorHome = process.env.LEITBILD_HOME
    process.env.LEITBILD_HOME = temporaryRoot
    try {
      const paths = workspaceModulePaths(newWorkspaceId())
      const source = runtime()
      source.rooms.createRoom({ name: 'Operations', createdBy: 'human-1' }).setActivePacks(['aviation'])
      await saveWorkspaceModuleSnapshots(serializeModuleSnapshots(source), paths, new Set(['collab']))
      expect((await appendCollabPendingScrub(paths.collab.snapshot, {
        packId: 'aviation',
        scheduledAt: '2026-08-29T18:00:00.000Z',
      })).applied).toBe(true)
      const loaded = await loadWorkspaceModuleSnapshots(paths, new Set(['collab']))
      expect(loaded.collab?.pendingScrubs?.[0]?.packId).toBe('aviation')
    } finally {
      if (priorHome === undefined) delete process.env.LEITBILD_HOME
      else process.env.LEITBILD_HOME = priorHome
    }
  })
})
