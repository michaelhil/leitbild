import { describe, test, expect, afterEach } from 'bun:test'
import { serializeSystem, saveSnapshot, loadSnapshot, restoreFromSnapshot, appendPendingScrub, SNAPSHOT_VERSION, createAutoSaver } from './snapshot.ts'
import { stat } from 'node:fs/promises'
import { createRoomDirectory } from '../rooms/directory.ts'
import { createBookmarkStore } from '../workspaces/bookmark-store.ts'
import { createWorkspaceSettings } from '../workspaces/settings.ts'
import { createTeam } from '../../agents/team.ts'
import type { DeliverFn } from '../types/messaging.ts'
import { unlink, mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'

const TEST_SNAPSHOT_DIR = resolve(import.meta.dir, '../../data/test')
const TEST_SNAPSHOT_PATH = resolve(TEST_SNAPSHOT_DIR, 'test-snapshot.json')

// Minimal deliver function
const noopDeliver: DeliverFn = () => {}

// Helper: create a minimal system-like object with a default room
const createTestSystem = () => {
  const team = createTeam()
  const rooms = createRoomDirectory({ deliver: noopDeliver })
  const settings = createWorkspaceSettings()
  const bookmarks = createBookmarkStore()
  // Create default room (main.ts does this in createSamsinnWorkspaceRuntime, but we're testing standalone)
  rooms.createRoom({ name: 'Introductions', createdBy: 'system' })
  return { rooms, settings, bookmarks, team }
}

describe('Snapshot', () => {
  afterEach(async () => {
    try { await unlink(TEST_SNAPSHOT_PATH) } catch { /* ignore */ }
    try { await unlink(`${TEST_SNAPSHOT_PATH}.tmp`) } catch { /* ignore */ }
  })

  describe('canonical schema rejection', () => {
    test('rejects any non-current snapshot version', async () => {
      await mkdir(TEST_SNAPSHOT_DIR, { recursive: true })
      for (const v of ['3', '6', '7']) {
        const stale = { version: v, timestamp: Date.now(), rooms: [], agents: [] }
        await Bun.write(TEST_SNAPSHOT_PATH, JSON.stringify(stale))
        const loaded = await loadSnapshot(TEST_SNAPSHOT_PATH)
        expect(loaded).toBeNull()
      }
    })

    test('rejects current-version snapshots with unknown fields', async () => {
      await mkdir(TEST_SNAPSHOT_DIR, { recursive: true })
      const invalid = {
        version: '29',
        timestamp: Date.now(),
        rooms: [],
        agents: [],
        humans: [],
        moduleBindings: [],
      }
      await Bun.write(TEST_SNAPSHOT_PATH, JSON.stringify(invalid))
      expect(await loadSnapshot(TEST_SNAPSHOT_PATH)).toBeNull()
    })

    test('rejects current-version snapshots missing canonical fields', async () => {
      await mkdir(TEST_SNAPSHOT_DIR, { recursive: true })
      const invalid = { version: '29', timestamp: Date.now(), rooms: [], agents: [] }
      await Bun.write(TEST_SNAPSHOT_PATH, JSON.stringify(invalid))
      expect(await loadSnapshot(TEST_SNAPSHOT_PATH)).toBeNull()
    })
  })

  describe('bookmarks round-trip', () => {
    test('serializes and restores bookmarks, newest-first', () => {
      const system = createTestSystem()
      const first = system.bookmarks.add('first message')
      const second = system.bookmarks.add('second message')

      const snapshot = serializeSystem(system)
      expect(snapshot.bookmarks?.length).toBe(2)
      // addBookmark prepends → second comes first in the list
      expect(snapshot.bookmarks?.[0]?.id).toBe(second.id)
      expect(snapshot.bookmarks?.[1]?.id).toBe(first.id)

      const fresh = createBookmarkStore()
      fresh.restore(snapshot.bookmarks ?? [])
      expect(fresh.list().map(b => b.content)).toEqual(['second message', 'first message'])
    })

    test('update preserves position; delete removes', () => {
      const system = createTestSystem()
      const a = system.bookmarks.add('a')
      const b = system.bookmarks.add('b')
      const c = system.bookmarks.add('c')
      // Order after adds: [c, b, a]
      expect(system.bookmarks.list().map(x => x.id)).toEqual([c.id, b.id, a.id])

      system.bookmarks.update(b.id, 'B!')
      expect(system.bookmarks.list().map(x => x.id)).toEqual([c.id, b.id, a.id])
      expect(system.bookmarks.list().find(x => x.id === b.id)?.content).toBe('B!')

      expect(system.bookmarks.remove(a.id)).toBe(true)
      expect(system.bookmarks.list().map(x => x.id)).toEqual([c.id, b.id])
    })
  })

  describe('serializeSystem', () => {
    test('serializes empty system', () => {
      const system = createTestSystem()
      const snapshot = serializeSystem(system)

      expect(snapshot.version).toBe('29')
      expect(snapshot.timestamp).toBeGreaterThan(0)
      expect(snapshot.rooms.length).toBe(1) // default Introductions room
      expect(snapshot.agents.length).toBe(0)
    })

    test('serializes rooms with messages', () => {
      const system = createTestSystem()
      const room = system.rooms.getRoom('Introductions')!

      room.post({ senderId: 'agent-1', senderName: 'Alpha', content: 'Hello', type: 'chat' })
      room.post({ senderId: 'agent-2', senderName: 'Beta', content: 'Hi there', type: 'chat' })

      const snapshot = serializeSystem(system)
      const roomSnap = snapshot.rooms[0]!

      expect(roomSnap.messages.length).toBeGreaterThanOrEqual(2)
      const chatMsgs = roomSnap.messages.filter(m => m.type === 'chat')
      expect(chatMsgs.length).toBe(2)
      expect(chatMsgs[0]!.content).toBe('Hello')
      expect(chatMsgs[1]!.content).toBe('Hi there')
    })

    test('serializes room delivery state', () => {
      const system = createTestSystem()
      const room = system.rooms.getRoom('Introductions')!

      room.addMember('agent-1')
      room.setMuted('agent-1', true)

      const snapshot = serializeSystem(system)
      const roomSnap = snapshot.rooms[0]!

      expect(roomSnap.deliveryMode).toBe('broadcast')
      expect(roomSnap.muted).toContain('agent-1')
      expect(roomSnap.members).toContain('agent-1')
    })

  })

  describe('saveSnapshot / loadSnapshot', () => {
    test('round-trips through disk', async () => {
      const system = createTestSystem()
      const room = system.rooms.getRoom('Introductions')!
      room.post({ senderId: 'agent-1', senderName: 'Alpha', content: 'Persisted', type: 'chat' })

      const snapshot = serializeSystem(system)
      await saveSnapshot(snapshot, TEST_SNAPSHOT_PATH)

      const loaded = await loadSnapshot(TEST_SNAPSHOT_PATH)
      expect(loaded).not.toBeNull()
      expect(loaded!.version).toBe('29')
      expect(loaded!.rooms.length).toBe(snapshot.rooms.length)

      const chatMsgs = loaded!.rooms[0]!.messages.filter(m => m.type === 'chat')
      expect(chatMsgs.some(m => m.content === 'Persisted')).toBe(true)
    })

    test('returns null for missing file', async () => {
      const loaded = await loadSnapshot('/nonexistent/path.json')
      expect(loaded).toBeNull()
    })

    test('returns null for invalid version', async () => {
      await mkdir(TEST_SNAPSHOT_DIR, { recursive: true })
      await Bun.write(TEST_SNAPSHOT_PATH, JSON.stringify({ version: '999', timestamp: 0, rooms: [], agents: [] }))
      const loaded = await loadSnapshot(TEST_SNAPSHOT_PATH)
      expect(loaded).toBeNull()
    })

    test('A3: empty-transition deletes the on-disk snapshot file', async () => {
      await mkdir(TEST_SNAPSHOT_DIR, { recursive: true })
      const system = createTestSystem()

      // First save: non-empty (default Introductions room exists). With a
      // bookmark added, isEmptySnapshot is false.
      system.bookmarks.add('keep me alive')
      const saver = createAutoSaver(system, TEST_SNAPSHOT_PATH, 0)
      await saver.flush()
      let exists = false
      try { await stat(TEST_SNAPSHOT_PATH); exists = true } catch { /* expected fail */ }
      expect(exists).toBe(true)

      // Now empty the system: remove default room + bookmarks. isEmptySnapshot
      // becomes true and the next save must rm the file.
      const room = system.rooms.getRoom('Introductions')!
      system.rooms.removeRoom(room.profile.id)
      // Manually clear bookmarks via the same path used in tests.
      system.bookmarks.restore([])
      await saver.flush()

      let stillExists = false
      try { await stat(TEST_SNAPSHOT_PATH); stillExists = true } catch { /* expected */ }
      expect(stillExists).toBe(false)
      saver.dispose()
    })

    test('A3: empty save when no file exists is a no-op (no error)', async () => {
      const system = createTestSystem()
      const room = system.rooms.getRoom('Introductions')!
      system.rooms.removeRoom(room.profile.id)
      // Empty system, no prior file. flush() should not throw.
      const saver = createAutoSaver(system, TEST_SNAPSHOT_PATH, 0)
      await saver.flush()
      saver.dispose()

      let exists = false
      try { await stat(TEST_SNAPSHOT_PATH); exists = true } catch { /* expected */ }
      expect(exists).toBe(false)
    })
  })

  describe('restoreFromSnapshot', () => {
    test('restores rooms with messages and state', async () => {
      // 1. Create original system and populate
      const original = createTestSystem()
      const origRoom = original.rooms.getRoom('Introductions')!
      origRoom.addMember('agent-1')
      origRoom.post({ senderId: 'agent-1', senderName: 'Alpha', content: 'Before restart', type: 'chat' })
      origRoom.setMuted('agent-1', true)

      // 2. Serialize
      const snapshot = serializeSystem(original)

      // 3. Create fresh system and restore
      const fresh = createTestSystem()
      // Remove the default intro room since restore will recreate it
      const defaultIntro = fresh.rooms.getRoom('Introductions')
      if (defaultIntro) fresh.rooms.removeRoom(defaultIntro.profile.id)

      // Minimal restorableSystem
      const restorableSystem = {
        rooms: fresh.rooms,
        settings: fresh.settings,
        bookmarks: fresh.bookmarks,
        spawnAIAgent: async () => {},
      }
      await restoreFromSnapshot(restorableSystem, snapshot)

      // 4. Verify
      const restoredRoom = fresh.rooms.getRoom('Introductions')
      expect(restoredRoom).toBeTruthy()

      const msgs = restoredRoom!.getRecent(100)
      const chatMsgs = msgs.filter(m => m.type === 'chat')
      expect(chatMsgs.some(m => m.content === 'Before restart')).toBe(true)

      expect(restoredRoom!.paused).toBe(false) // restores saved paused state (was false)
      expect(restoredRoom!.isMuted('agent-1')).toBe(true)
    })

    test('preserves room IDs', async () => {
      const original = createTestSystem()
      const origRoom = original.rooms.getRoom('Introductions')!
      const origRoomId = origRoom.profile.id

      const snapshot = serializeSystem(original)

      const fresh = createTestSystem()
      const defaultIntro = fresh.rooms.getRoom('Introductions')
      if (defaultIntro) fresh.rooms.removeRoom(defaultIntro.profile.id)

      await restoreFromSnapshot({ ...fresh, spawnAIAgent: async () => {} }, snapshot)

      const restoredRoom = fresh.rooms.getRoom(origRoomId)
      expect(restoredRoom).toBeTruthy()
      expect(restoredRoom!.profile.id).toBe(origRoomId)
    })

  })

  describe('pendingScrubs (M1: cross-Workspace pack uninstall)', () => {
    test('appendPendingScrub queues a Pack id and dedupes repeats', async () => {
      await mkdir(TEST_SNAPSHOT_DIR, { recursive: true })
      const system = createTestSystem()
      const room = system.rooms.getRoom('Introductions')!
      room.setActivePacks(['aviation', 'cafes'])
      await saveSnapshot(serializeSystem(system), TEST_SNAPSHOT_PATH)

      const r1 = await appendPendingScrub(TEST_SNAPSHOT_PATH, { packId: 'aviation', scheduledAt: '2026-05-06T00:00:00.000Z' })
      expect(r1.applied).toBe(true)

      // Repeat same Pack id — must dedupe.
      const r2 = await appendPendingScrub(TEST_SNAPSHOT_PATH, { packId: 'aviation', scheduledAt: '2026-05-06T00:01:00.000Z' })
      expect(r2.applied).toBe(false)
      expect(r2.reason).toBe('already queued')

      // Different Pack id appends.
      const r3 = await appendPendingScrub(TEST_SNAPSHOT_PATH, { packId: 'cafes', scheduledAt: '2026-05-06T00:02:00.000Z' })
      expect(r3.applied).toBe(true)

      const reloaded = await loadSnapshot(TEST_SNAPSHOT_PATH)
      expect(reloaded?.pendingScrubs?.length).toBe(2)
      expect(reloaded?.pendingScrubs?.map(p => p.packId).sort()).toEqual(['aviation', 'cafes'])
    })

    test('appendPendingScrub refuses missing snapshot file', async () => {
      const result = await appendPendingScrub(TEST_SNAPSHOT_PATH, { packId: 'x', scheduledAt: '2026-05-06T00:00:00.000Z' })
      expect(result.applied).toBe(false)
      expect(result.reason).toBe('no snapshot file')
    })

    test('appendPendingScrub refuses a non-canonical snapshot', async () => {
      await mkdir(TEST_SNAPSHOT_DIR, { recursive: true })
      await Bun.write(TEST_SNAPSHOT_PATH, JSON.stringify({ version: '7', timestamp: Date.now(), rooms: [], agents: [] }))
      const result = await appendPendingScrub(TEST_SNAPSHOT_PATH, { packId: 'x', scheduledAt: '2026-05-06T00:00:00.000Z' })
      expect(result.applied).toBe(false)
      expect(result.reason).toContain('canonical schema')
    })

    test('restoreFromSnapshot drains pendingScrubs from room.activePacks', async () => {
      await mkdir(TEST_SNAPSHOT_DIR, { recursive: true })
      const system = createTestSystem()
      const room = system.rooms.getRoom('Introductions')!
      room.setActivePacks(['aviation', 'cafes', 'maritime'])
      await saveSnapshot(serializeSystem(system), TEST_SNAPSHOT_PATH)

      // Schedule scrubs for aviation and maritime — cafes should remain.
      await appendPendingScrub(TEST_SNAPSHOT_PATH, { packId: 'aviation', scheduledAt: '2026-05-06T00:00:00.000Z' })
      await appendPendingScrub(TEST_SNAPSHOT_PATH, { packId: 'maritime', scheduledAt: '2026-05-06T00:01:00.000Z' })

      const loaded = await loadSnapshot(TEST_SNAPSHOT_PATH)
      expect(loaded).not.toBeNull()

      const fresh = createTestSystem()
      const defaultIntro = fresh.rooms.getRoom('Introductions')
      if (defaultIntro) fresh.rooms.removeRoom(defaultIntro.profile.id)
      await restoreFromSnapshot({ ...fresh, spawnAIAgent: async () => {} }, loaded!)

      const restored = fresh.rooms.getRoom(room.profile.id)!
      expect(restored.getActivePacks()).toEqual(['cafes'])

      // Re-serialise and verify pendingScrubs is gone (serializeSystem
      // never writes the field; the next save naturally drops it).
      const reSerialised = serializeSystem(fresh)
      expect(reSerialised.pendingScrubs).toBeUndefined()
    })

    test('SNAPSHOT_VERSION is current', () => {
      expect(SNAPSHOT_VERSION).toBe(29)
    })
  })

  describe('Workspace settings persistence', () => {
    test('default workspacePrompt + responseFormat are omitted from snapshot', () => {
      const system = createTestSystem()
      const snapshot = serializeSystem(system)
      expect(snapshot.workspacePrompt).toBeUndefined()
      expect(snapshot.responseFormat).toBeUndefined()
    })

    test('customised workspacePrompt round-trips through serialise + restore', async () => {
      const system = createTestSystem()
      system.settings.setPrompt('CUSTOM WORKSPACE PROMPT')
      const snapshot = serializeSystem(system)
      expect(snapshot.workspacePrompt).toBe('CUSTOM WORKSPACE PROMPT')

      const fresh = createTestSystem()
      const defaultIntro = fresh.rooms.getRoom('Introductions')
      if (defaultIntro) fresh.rooms.removeRoom(defaultIntro.profile.id)
      await restoreFromSnapshot({ ...fresh, spawnAIAgent: async () => {} }, snapshot)
      expect(fresh.settings.getPrompt()).toBe('CUSTOM WORKSPACE PROMPT')
    })

    test('customised responseFormat round-trips', async () => {
      const system = createTestSystem()
      system.settings.setResponseFormat('-- pirate-style only --')
      const snapshot = serializeSystem(system)
      expect(snapshot.responseFormat).toBe('-- pirate-style only --')

      const fresh = createTestSystem()
      const defaultIntro = fresh.rooms.getRoom('Introductions')
      if (defaultIntro) fresh.rooms.removeRoom(defaultIntro.profile.id)
      await restoreFromSnapshot({ ...fresh, spawnAIAgent: async () => {} }, snapshot)
      expect(fresh.settings.getResponseFormat()).toBe('-- pirate-style only --')
    })

    test('absent workspacePrompt leaves the in-memory default', async () => {
      const fresh = createTestSystem()
      const defaultPrompt = fresh.settings.getPrompt()
      const snapshotWithoutPrompt = { version: '29' as const, timestamp: 0, rooms: [], agents: [], humans: [] }
      await restoreFromSnapshot({ ...fresh, spawnAIAgent: async () => {} }, snapshotWithoutPrompt)
      expect(fresh.settings.getPrompt()).toBe(defaultPrompt)
    })
  })

  describe('A4: concurrent writes are serialised — no JSON corruption', () => {
    test('25 concurrent appendPendingScrub calls all land', async () => {
      // Realistic scenario: cross-Workspace uninstall fires multiple
      // appendPendingScrubs against the same evicted-Workspace snapshot
      // file. Without the write chain, two concurrent read-modify-writes
      // can lose the earlier append.
      //
      // Note: saveSnapshot vs appendPendingScrub is NOT a relevant race
      // because saveSnapshot only runs for live Workspaces and
      // appendPendingScrub only runs for EVICTED ones — the registry
      // mutex guarantees the Workspace is in exactly one state.
      await mkdir(TEST_SNAPSHOT_DIR, { recursive: true })
      const system = createTestSystem()
      await saveSnapshot(serializeSystem(system), TEST_SNAPSHOT_PATH)

      const ops: Promise<unknown>[] = []
      for (let i = 0; i < 25; i++) {
        ops.push(appendPendingScrub(TEST_SNAPSHOT_PATH, {
          packId: `ns-${i}`,
          scheduledAt: `2026-05-06T10:${String(i).padStart(2, '0')}:00.000Z`,
        }))
      }
      await Promise.all(ops)

      const loaded = await loadSnapshot(TEST_SNAPSHOT_PATH)
      expect(loaded).not.toBeNull()
      expect(loaded!.pendingScrubs?.length).toBe(25)
      const packIds = new Set(loaded!.pendingScrubs!.map(p => p.packId))
      expect(packIds.size).toBe(25)
    })

    test('concurrent saveSnapshots against the same path produce a valid final file', async () => {
      // Live-Workspace debounced saves can fire close together (e.g. M5
      // flushNow racing with the auto-saver's pending timer). The chain
      // ensures the final file is whichever save was scheduled last,
      // never a half-written interleave.
      await mkdir(TEST_SNAPSHOT_DIR, { recursive: true })
      const system = createTestSystem()
      const room = system.rooms.getRoom('Introductions')!
      const ops: Promise<unknown>[] = []
      for (let i = 0; i < 20; i++) {
        room.post({ senderId: 'agent-1', senderName: 'A', content: `msg-${i}`, type: 'chat' })
        ops.push(saveSnapshot(serializeSystem(system), TEST_SNAPSHOT_PATH))
      }
      await Promise.all(ops)

      const loaded = await loadSnapshot(TEST_SNAPSHOT_PATH)
      expect(loaded).not.toBeNull()
      // Final state contains all 20 messages (last write wins; the chain
      // guarantees the last-submitted save is the last one to rename).
      const chatMsgs = loaded!.rooms[0]!.messages.filter(m => m.type === 'chat')
      expect(chatMsgs.length).toBe(20)
    })
  })
})
