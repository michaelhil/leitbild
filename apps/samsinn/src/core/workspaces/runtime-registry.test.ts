import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWorkspaceRuntimeRegistry, type WorkspaceRuntimeRegistry } from './runtime-registry.ts'
import { createDeploymentRuntime } from '../deployment-runtime.ts'
import { workspaceModulePaths } from '../paths.ts'
import { newWorkspaceId, type WorkspaceId } from '@samsinn-leitbild/platform-contracts'
import { createSamsinnModuleState, type SamsinnModuleState } from './module-state.ts'

// Phase D registry tests use the SAMSINN_HOME env var to redirect all paths
// into a per-test tmpdir. The shared runtime is built with no providers
// (single-Ollama mode, but Ollama URL never hit) so tests are network-free.

describe('WorkspaceRuntimeRegistry', () => {
  let originalHome: string | undefined
  let homeDir: string
  let registry: WorkspaceRuntimeRegistry
  let moduleState: SamsinnModuleState

  const provision = async (id: WorkspaceId): Promise<void> => {
    await moduleState.provision(id, 'collaboration')
    await moduleState.provision(id, 'agents')
  }

  beforeEach(async () => {
    originalHome = process.env.SAMSINN_HOME
    homeDir = await mkdtemp(join(tmpdir(), 'samsinn-registry-'))
    process.env.SAMSINN_HOME = homeDir
    // PROVIDER=ollama keeps shared runtime quiet — no cloud gateways built.
    process.env.PROVIDER = 'ollama'
    // Disable first-run seeding — these tests assert empty-RoomDirectory semantics.
    process.env.SAMSINN_SEED_WORKSPACE = '0'
    const shared = createDeploymentRuntime()
    moduleState = createSamsinnModuleState()
    registry = createWorkspaceRuntimeRegistry({ deployment: shared, moduleState, idleMs: 1_000_000 })  // long idle so no auto-evict in unit tests
  })

  afterEach(async () => {
    await registry.shutdown()
    if (originalHome === undefined) delete process.env.SAMSINN_HOME
    else process.env.SAMSINN_HOME = originalHome
    delete process.env.PROVIDER
    delete process.env.SAMSINN_SEED_WORKSPACE
    await rm(homeDir, { recursive: true, force: true })
  })

  // --- Validity ---

  it('rejects invalid Workspace ids at runtime', async () => {
    await expect(registry.getOrLoad('bad' as WorkspaceId)).rejects.toThrow(/invalid Workspace id/)
    await expect(registry.getOrLoad('../etc/passwd' as WorkspaceId)).rejects.toThrow(/invalid Workspace id/)
  })

  // --- Round-trip + caching ---

  it('round-trip: same id returns same system', async () => {
    const id = newWorkspaceId()
    await provision(id)
    const a = await registry.getOrLoad(id)
    const b = await registry.getOrLoad(id)
    expect(a).toBe(b)
  })

  it('seeds only when Collaboration and Agents are composed', async () => {
    const id = newWorkspaceId()
    await provision(id)
    delete process.env.SAMSINN_SEED_WORKSPACE
    const seeded = await registry.getOrLoad(id)
    expect(seeded.rooms.listAllRooms().some(r => r.name === 'Cafe')).toBe(true)
    expect(seeded.team.listAgents().some(a => a.name === 'Aiden')).toBe(true)
  })

  it('different ids return different systems', async () => {
    const idA = newWorkspaceId()
    const idB = newWorkspaceId()
    await provision(idA)
    await provision(idB)
    const a = await registry.getOrLoad(idA)
    const b = await registry.getOrLoad(idB)
    expect(a).not.toBe(b)
  })

  // --- Concurrency ---

  it('concurrent getOrLoad on same id resolves to one system (pendingLoads dedupe)', async () => {
    const id = newWorkspaceId()
    await provision(id)
    const [a, b, c] = await Promise.all([
      registry.getOrLoad(id),
      registry.getOrLoad(id),
      registry.getOrLoad(id),
    ])
    expect(a).toBe(b)
    expect(b).toBe(c)
  })

  // --- Eviction round-trip ---

  it('evicts then lazy-reloads with state preserved', async () => {
    const id = newWorkspaceId()
    await provision(id)
    const sys1 = await registry.getOrLoad(id)
    sys1.rooms.createRoomSafe({ name: 'evict-test-room', createdBy: 'system' })
    expect(sys1.rooms.listAllRooms().some(r => r.name ==='evict-test-room')).toBe(true)

    // Snapshot file shouldn't exist yet (autosaver debounced 5 s).
    // Eviction's flush forces a save.
    await registry.evictOne(id)
    expect(registry.list().some(m => m.id === id)).toBe(false)

    // Snapshot file should exist on disk now.
    const stats = await stat(workspaceModulePaths(id).collaboration.snapshot)
    expect(stats.size).toBeGreaterThan(0)

    // Lazy reload — fresh system, but room restored from disk.
    const sys2 = await registry.getOrLoad(id)
    expect(sys2).not.toBe(sys1)
    expect(sys2.rooms.listAllRooms().some(r => r.name ==='evict-test-room')).toBe(true)
  })

  // --- Evict-while-active race ---

  it('request mid-eviction awaits the eviction then loads fresh from disk', async () => {
    const id = newWorkspaceId()
    await provision(id)
    const sys1 = await registry.getOrLoad(id)
    sys1.rooms.createRoomSafe({ name: 'race-room', createdBy: 'system' })

    // Kick off evict but don't await yet.
    const evicting = registry.evictOne(id)

    // Concurrent request — must await the eviction, then return a fresh
    // Workspace loaded from the just-flushed snapshot.
    const [, sys2] = await Promise.all([evicting, registry.getOrLoad(id)])

    expect(sys2).not.toBe(sys1)
    expect(sys2.rooms.listAllRooms().some(r => r.name ==='race-room')).toBe(true)
  })

  // --- Idempotent eviction ---

  it('evictOne is idempotent for unknown id', async () => {
    await registry.evictOne(newWorkspaceId())   // never created
    // No throw, no side effects.
    expect(registry.list().length).toBe(0)
  })

  it('two concurrent evictOne calls share a single eviction', async () => {
    const id = newWorkspaceId()
    await provision(id)
    await registry.getOrLoad(id)
    const [a, b] = await Promise.all([registry.evictOne(id), registry.evictOne(id)])
    expect(a).toBeUndefined()
    expect(b).toBeUndefined()
    expect(registry.list().some(m => m.id === id)).toBe(false)
  })

  // --- Idle eviction ---

  it('evictIdle drops Workspaces older than idleMs', async () => {
    const reg = createWorkspaceRuntimeRegistry({
      deployment: createDeploymentRuntime(),
      moduleState,
      idleMs: 50,
    })
    const idA = newWorkspaceId()
    const idB = newWorkspaceId()
    await provision(idA)
    await provision(idB)
    await reg.getOrLoad(idA)
    await new Promise(r => setTimeout(r, 80))
    await reg.getOrLoad(idB)        // freshly touched

    const evictedCount = await reg.evictIdle(Date.now())
    expect(evictedCount).toBe(1)
    expect(reg.list().some(m => m.id === idA)).toBe(false)
    expect(reg.list().some(m => m.id === idB)).toBe(true)
    await reg.shutdown()
  })

  it('enforces the loaded-Workspace capacity by evicting least-recently-used state', async () => {
    const reg = createWorkspaceRuntimeRegistry({
      deployment: createDeploymentRuntime(),
      moduleState,
      idleMs: 1_000_000,
      maxLoadedWorkspaces: 2,
    })
    const idA = newWorkspaceId()
    const idB = newWorkspaceId()
    const idC = newWorkspaceId()
    await provision(idA)
    await provision(idB)
    await provision(idC)
    const a = await reg.getOrLoad(idA)
    a.rooms.createRoomSafe({ name: 'capacity-state', createdBy: 'system' })
    await new Promise(resolve => setTimeout(resolve, 2))
    await reg.getOrLoad(idB)
    await new Promise(resolve => setTimeout(resolve, 2))
    await reg.getOrLoad(idC)

    expect(reg.list().map(meta => meta.id).sort()).toEqual([idB, idC].sort())
    expect(reg.maxLoadedWorkspaces()).toBe(2)

    const restored = await reg.getOrLoad(idA)
    expect(restored.rooms.listAllRooms().some(room => room.name === 'capacity-state')).toBe(true)
    expect(reg.list().length).toBe(2)
    await reg.shutdown()
  })

  it('keeps the capacity bound when cold loads complete concurrently', async () => {
    const reg = createWorkspaceRuntimeRegistry({
      deployment: createDeploymentRuntime(),
      moduleState,
      maxLoadedWorkspaces: 1,
    })
    const ids = [newWorkspaceId(), newWorkspaceId(), newWorkspaceId()]
    await Promise.all(ids.map(provision))

    await Promise.all(ids.map(id => reg.getOrLoad(id)))

    expect(reg.list()).toHaveLength(1)
    await reg.shutdown()
  })

  // --- exists ---

  it('exists is true after disk persistence', async () => {
    const id = newWorkspaceId()
    await provision(id)
    const sys = await registry.getOrLoad(id)
    sys.rooms.createRoomSafe({ name: 'exists-test', createdBy: 'system' })
    await registry.evictOne(id)
    expect(await registry.exists(id)).toBe(true)
  })

  it('exists is false for never-created id', async () => {
    expect(await registry.exists(newWorkspaceId())).toBe(false)
  })

  // --- Reset ---

  it('resetWorkspaceState clears Module payloads while preserving provisioned membership', async () => {
    const id = newWorkspaceId()
    await provision(id)
    const sys = await registry.getOrLoad(id)
    sys.rooms.createRoomSafe({ name: 'reset-test', createdBy: 'system' })
    await registry.evictOne(id)
    expect(await registry.exists(id)).toBe(true)

    await registry.resetWorkspaceState(id)
    expect(await registry.exists(id)).toBe(true)

    // Same id is now usable for a fresh empty RoomDirectory.
    const sys2 = await registry.getOrLoad(id)
    expect(sys2.rooms.listAllRooms().length).toBe(0)
  })

  it('rejects loading an unprovisioned Workspace', async () => {
    await expect(registry.getOrLoad(newWorkspaceId())).rejects.toThrow('no provisioned Samsinn Modules')
  })

  // --- list / meta ---

  it('list reflects current in-memory state', async () => {
    const id = newWorkspaceId()
    await provision(id)
    expect(registry.list()).toEqual([])
    await registry.getOrLoad(id)
    const meta = registry.list()
    expect(meta.length).toBe(1)
    expect(meta[0]?.id).toBe(id)
    expect(meta[0]?.state).toBe('active')
  })

  // --- Shutdown ---

  it('shutdown flushes every active Workspace', async () => {
    const idA = newWorkspaceId()
    const idB = newWorkspaceId()
    await provision(idA)
    await provision(idB)
    const sa = await registry.getOrLoad(idA)
    const sb = await registry.getOrLoad(idB)
    sa.rooms.createRoomSafe({ name: 'shut-a', createdBy: 'system' })
    sb.rooms.createRoomSafe({ name: 'shut-b', createdBy: 'system' })

    await registry.shutdown()
    expect(registry.list()).toEqual([])
    await stat(workspaceModulePaths(idA).collaboration.snapshot)
    await stat(workspaceModulePaths(idB).collaboration.snapshot)
  })

  // --- Hooks ---

  it('onWorkspaceRuntimeCreated fires once per fresh load', async () => {
    const calls: string[] = []
    const reg = createWorkspaceRuntimeRegistry({
      deployment: createDeploymentRuntime(),
      moduleState,
      onWorkspaceRuntimeCreated: (_sys, id) => { calls.push(id) },
    })
    const id = newWorkspaceId()
    await provision(id)
    await reg.getOrLoad(id)
    await reg.getOrLoad(id)        // same Workspace — no second hook
    expect(calls).toEqual([id])
    await reg.evictOne(id)
    await reg.getOrLoad(id)        // post-evict reload — second hook
    expect(calls).toEqual([id, id])
    await reg.shutdown()
  })

  it('onWorkspaceRuntimeEvicted fires before the system is dropped', async () => {
    const calls: string[] = []
    const reg = createWorkspaceRuntimeRegistry({
      deployment: createDeploymentRuntime(),
      moduleState,
      onWorkspaceRuntimeEvicted: (_sys, id) => calls.push(id),
    })
    const id = newWorkspaceId()
    await provision(id)
    await reg.getOrLoad(id)
    await reg.evictOne(id)
    expect(calls).toEqual([id])
    await reg.shutdown()
  })
})
