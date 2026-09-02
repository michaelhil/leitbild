import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newWorkspaceId } from '@leitbild/contracts'
import { createDeploymentRuntime } from '../core/deployment-runtime.ts'
import { createAgentsModuleState } from '../core/workspaces/module-state.ts'
import { createWorkspaceRuntimeRegistry } from '../core/workspaces/runtime-registry.ts'
import { createWorkspacePackScrubber } from './workspace-pack-scrubber.ts'

describe('Workspace Pack scrubber', () => {
  let homeDir = ''

  afterEach(async () => {
    if (homeDir) await rm(homeDir, { recursive: true, force: true })
    delete process.env.LEITBILD_HOME
  })

  test('uninstall scrub survives eviction and is applied on reload', async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'leitbild-pack-scrub-'))
    process.env.LEITBILD_HOME = homeDir
    const moduleState = createAgentsModuleState()
    const registry = createWorkspaceRuntimeRegistry({
      deployment: createDeploymentRuntime(),
      moduleState,
      idleMs: 1_000_000,
    })
    const workspaceId = newWorkspaceId()
    await moduleState.provision(workspaceId)
    const runtime = await registry.getOrLoad(workspaceId)
    const room = runtime.rooms.createRoom({ name: 'Scrub me', createdBy: 'test' })
    room.setActivePacks(['site-survey', 'biometrics'])
    await registry.autoSaverFor(workspaceId)!.flush()
    await registry.evictOne(workspaceId)
    expect(registry.list()).toHaveLength(0)

    const scrub = createWorkspacePackScrubber({
      registry,
      broadcastToWorkspace: () => {},
    })
    expect(await scrub('site-survey')).toEqual([])

    const restored = await registry.getOrLoad(workspaceId)
    expect(restored.rooms.getRoom(room.profile.id)?.getActivePacks()).toEqual(['biometrics'])
    await registry.shutdown()
  })
})
