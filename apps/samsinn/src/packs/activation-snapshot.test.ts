// M3: end-to-end test for the evict-reload-with-scrub flow.
//
// Covers the full chain used to scrub a pack from unloaded Workspaces:
//
//   1. A loaded Workspace has activePacks set in a room and persists snapshot.
//   2. Its runtime is evicted (we discard memory; the disk
//      snapshot remains).
//   3. uninstall_pack in another Workspace fires appendPendingScrub()
//      against the unloaded Workspace's snapshot file.
//   4. Reload it via loadSnapshot + restoreFromSnapshot.
//   5. Assert the scrubbed namespace is gone from room.activePacks AND
//      the next save naturally drops pendingScrubs.
//
// This is the cross-cutting test CLAUDE.md mandates for flows that touch
// >3 layers (snapshot v20 type, appendPendingScrub disk mutation,
// restore-time drain, room-state filter). Unit tests of individual layers
// pass while the chain is broken; this one is what would catch a regression.

import { describe, test, expect, afterEach } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRoomDirectory } from '../core/rooms/directory.ts'
import { createBookmarkStore } from '../core/workspaces/bookmark-store.ts'
import { createWorkspaceSettings } from '../core/workspaces/settings.ts'
import {
  serializeSystem, saveSnapshot, loadSnapshot, restoreFromSnapshot,
  appendPendingScrub,
} from '../core/storage/snapshot.ts'
import { SYSTEM_SENDER_ID } from '../core/types/constants.ts'

const buildWorkspaceRuntime = () => {
  const rooms = createRoomDirectory({})
  const settings = createWorkspaceSettings()
  const bookmarks = createBookmarkStore()
  return { rooms, settings, bookmarks, team: { listAgents: () => [], getAgent: () => undefined } }
}

describe('M3: evict-reload + cross-Workspace pack scrub round-trip', () => {
  let tmpDir: string

  afterEach(async () => {
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true })
  })

  test('scrub queued against evicted snapshot drains on reload', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'm3-evict-reload-'))
    const snapshotPath = join(tmpDir, 'snapshot.json')

    // 1. Loaded Workspace with two rooms each holding a pack we'll uninstall.
    const live = buildWorkspaceRuntime()
    const cafe = live.rooms.createRoom({ name: 'Cafe', createdBy: SYSTEM_SENDER_ID })
    const office = live.rooms.createRoom({ name: 'Office', createdBy: SYSTEM_SENDER_ID })
    cafe.setActivePacks(['aviation', 'menus'])
    office.setActivePacks(['aviation'])

    // 2. Persist + discard (simulates eviction).
    await saveSnapshot(serializeSystem(live), snapshotPath)

    // 3. uninstall_pack 'aviation' fires while this instance is evicted —
    // appendPendingScrub mutates the on-disk snapshot.
    const queued = await appendPendingScrub(snapshotPath, {
      namespace: 'aviation',
      scheduledAt: '2026-05-06T10:00:00.000Z',
    })
    expect(queued.applied).toBe(true)

    // Verify the scrub is on disk before reload.
    const onDisk = await loadSnapshot(snapshotPath)
    expect(onDisk?.pendingScrubs?.length).toBe(1)
    expect(onDisk?.pendingScrubs?.[0]?.namespace).toBe('aviation')
    // Pre-restore: rooms still record aviation as active.
    expect(onDisk?.rooms.find(r => r.profile.name === 'Cafe')?.activePacks).toContain('aviation')

    // 4. Reload into a fresh system.
    const reloaded = buildWorkspaceRuntime()
    await restoreFromSnapshot(
      { ...reloaded, spawnAIAgent: async () => {} },
      onDisk!,
    )

    // 5. activePacks is filtered: aviation gone, menus stays in Cafe,
    // Office (which only had aviation) is now empty.
    const restoredCafe = reloaded.rooms.getRoom(cafe.profile.id)!
    const restoredOffice = reloaded.rooms.getRoom(office.profile.id)!
    expect(restoredCafe.getActivePacks()).toEqual(['menus'])
    expect(restoredOffice.getActivePacks()).toEqual([])

    // 6. Next save drops pendingScrubs naturally.
    const reSerialised = serializeSystem(reloaded)
    expect(reSerialised.pendingScrubs).toBeUndefined()
    // And the rooms persist with the scrub already applied.
    const reCafe = reSerialised.rooms.find(r => r.profile.name === 'Cafe')!
    expect(reCafe.activePacks).toEqual(['menus'])
    const reOffice = reSerialised.rooms.find(r => r.profile.name === 'Office')!
    // v24: activePacks is always present in the snapshot, even when empty.
    expect(reOffice.activePacks).toEqual([])
  })

  test('multiple scrubs queued in sequence all apply on reload', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'm3-multi-scrub-'))
    const snapshotPath = join(tmpDir, 'snapshot.json')

    const live = buildWorkspaceRuntime()
    const room = live.rooms.createRoom({ name: 'Hub', createdBy: SYSTEM_SENDER_ID })
    room.setActivePacks(['a', 'b', 'c', 'd'])
    await saveSnapshot(serializeSystem(live), snapshotPath)

    // Two separate uninstall events while evicted.
    await appendPendingScrub(snapshotPath, { namespace: 'a', scheduledAt: '2026-05-06T10:00:00.000Z' })
    await appendPendingScrub(snapshotPath, { namespace: 'c', scheduledAt: '2026-05-06T10:01:00.000Z' })

    const reloaded = buildWorkspaceRuntime()
    await restoreFromSnapshot(
      { ...reloaded, spawnAIAgent: async () => {} },
      (await loadSnapshot(snapshotPath))!,
    )

    expect(reloaded.rooms.getRoom(room.profile.id)!.getActivePacks()).toEqual(['b', 'd'])
  })

  test('scrub against a never-active namespace is a no-op on restore', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'm3-noop-scrub-'))
    const snapshotPath = join(tmpDir, 'snapshot.json')

    const live = buildWorkspaceRuntime()
    const room = live.rooms.createRoom({ name: 'Hub', createdBy: SYSTEM_SENDER_ID })
    room.setActivePacks(['kept'])
    await saveSnapshot(serializeSystem(live), snapshotPath)

    await appendPendingScrub(snapshotPath, { namespace: 'never-was-active', scheduledAt: '2026-05-06T10:00:00.000Z' })

    const reloaded = buildWorkspaceRuntime()
    await restoreFromSnapshot(
      { ...reloaded, spawnAIAgent: async () => {} },
      (await loadSnapshot(snapshotPath))!,
    )

    // 'kept' survives; the scrub for an unknown namespace is harmless.
    expect(reloaded.rooms.getRoom(room.profile.id)!.getActivePacks()).toEqual(['kept'])
  })
})
