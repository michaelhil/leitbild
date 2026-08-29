import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newWorkspaceId } from '@leitbild/contracts'
import { createRoomDirectory } from '../core/rooms/directory.ts'
import { createBookmarkStore } from '../core/workspaces/bookmark-store.ts'
import { createWorkspaceSettings } from '../core/workspaces/settings.ts'
import { workspaceModulePaths } from '../core/paths.ts'
import {
  appendRoomsPendingScrub,
  loadWorkspaceModuleSnapshots,
  restoreWorkspaceModuleSnapshots,
  saveWorkspaceModuleSnapshots,
  serializeModuleSnapshots,
} from '../core/storage/module-snapshots.ts'
import { SYSTEM_SENDER_ID } from '../core/types/constants.ts'

const buildRuntime = () => ({
  rooms: createRoomDirectory({}),
  settings: createWorkspaceSettings(),
  bookmarks: createBookmarkStore(),
  team: { listAgents: () => [], getAgent: () => undefined },
})

describe('evicted Room Pack scrub round-trip', () => {
  let temporaryRoot = ''
  let priorHome: string | undefined

  afterEach(async () => {
    if (priorHome === undefined) delete process.env.LEITBILD_HOME
    else process.env.LEITBILD_HOME = priorHome
    if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true })
  })

  test('drains queued Pack removals without touching Agent state', async () => {
    priorHome = process.env.LEITBILD_HOME
    temporaryRoot = await mkdtemp(join(tmpdir(), 'rooms-scrub-'))
    process.env.LEITBILD_HOME = temporaryRoot
    const paths = workspaceModulePaths(newWorkspaceId())
    const live = buildRuntime()
    const cafe = live.rooms.createRoom({ name: 'Cafe', createdBy: SYSTEM_SENDER_ID })
    const office = live.rooms.createRoom({ name: 'Office', createdBy: SYSTEM_SENDER_ID })
    cafe.setActivePacks(['aviation', 'menus'])
    office.setActivePacks(['aviation'])

    await saveWorkspaceModuleSnapshots(
      serializeModuleSnapshots(live),
      paths,
    )
    const queued = await appendRoomsPendingScrub(paths.rooms.snapshot, {
      packId: 'aviation',
      scheduledAt: '2026-08-29T18:00:00.000Z',
    })
    expect(queued.applied).toBe(true)

    const snapshots = await loadWorkspaceModuleSnapshots(paths)
    const restored = buildRuntime()
    await restoreWorkspaceModuleSnapshots({
      ...restored,
      spawnAIAgent: async () => {},
    }, snapshots)

    expect(restored.rooms.getRoom('Cafe')?.getActivePacks()).toEqual(['menus'])
    expect(restored.rooms.getRoom('Office')?.getActivePacks()).toEqual([])
    expect(snapshots.agents).toBeNull()

    const next = serializeModuleSnapshots(restored)
    expect(next.rooms.pendingScrubs).toBeUndefined()
  })
})
