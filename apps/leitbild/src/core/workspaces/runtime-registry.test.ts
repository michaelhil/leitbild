import { describe, expect, test } from 'bun:test'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { newWorkspaceId } from '@samsinn-leitbild/platform-contracts'
import { createLocalWorkspaceDirectory } from './directory.ts'
import { createLeitbildWorkspaceRuntimeRegistry } from './runtime-registry.ts'
import { createTestPackRuntimeAdapters, createTestScenarioCatalog } from '../../../tests/helpers.ts'

const createRegistry = async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'leitbild-workspace-runtime-'))
  const workspaceDirectory = createLocalWorkspaceDirectory({
    path: join(dataDir, 'workspace-directory.json'),
    defaultDisplayName: 'Default Leitbild Workspace',
  })
  return {
    dataDir,
    registry: createLeitbildWorkspaceRuntimeRegistry({
      dataDir,
      workspaceDirectory,
      scenarioCatalog: createTestScenarioCatalog(),
      runtimeAdapters: createTestPackRuntimeAdapters(),
    }),
  }
}

describe('Leitbild Workspace runtime registry', () => {
  test('deduplicates concurrent loads and keeps deployment resources out of Workspace identity', async () => {
    const { registry } = await createRegistry()
    const workspace = await registry.defaultWorkspace()
    const [first, second] = await Promise.all([
      registry.getOrLoad(workspace.id),
      registry.getOrLoad(workspace.id),
    ])
    expect(second).toBe(first)
    expect(first.workspace).toEqual(workspace)
    expect(first.simulationRuns.workspaceId).toBe(workspace.id)
    await registry.shutdown()
  })

  test('isolates Scenario libraries and Simulation Runs by Workspace', async () => {
    const { dataDir, registry } = await createRegistry()
    const first = await registry.provision({ displayName: 'Exercise Alpha' })
    const second = await registry.provision({ displayName: 'Exercise Bravo' })
    const firstRun = await first.simulationRuns.create()
    const secondRun = await second.simulationRuns.create()
    try {
      expect(first.workspace.id).not.toBe(second.workspace.id)
      expect(firstRun.id).not.toBe(secondRun.id)
      expect(await first.simulationRuns.listKnown()).toHaveLength(1)
      expect(await second.simulationRuns.listKnown()).toHaveLength(1)
      expect(first.simulationRuns.status().then(status => status.dataDir)).resolves.toContain(
        join('workspaces', first.workspace.id, 'leitbild'),
      )
      expect(second.simulationRuns.status().then(status => status.dataDir)).resolves.toContain(
        join('workspaces', second.workspace.id, 'leitbild'),
      )
      expect(dataDir.length).toBeGreaterThan(0)
    } finally {
      await registry.shutdown()
    }
  })

  test('provisions a suite-supplied canonical Workspace id and rejects unknown ids', async () => {
    const { registry } = await createRegistry()
    const suppliedId = newWorkspaceId()
    const provisioned = await registry.provision({ id: suppliedId, displayName: 'Combined Workspace' })
    expect(provisioned.workspace.id).toBe(suppliedId)
    expect((await registry.list()).map(workspace => workspace.id)).toContain(suppliedId)

    await expect(registry.getOrLoad(newWorkspaceId())).rejects.toThrow('Workspace not found')
    await registry.shutdown()
  })

  test('closes loaded run runtimes without deleting Workspace state', async () => {
    const { registry } = await createRegistry()
    const workspaceRuntime = await registry.provision({ displayName: 'Persistent Workspace' })
    const simulationRun = await workspaceRuntime.simulationRuns.create()
    expect(await registry.close(workspaceRuntime.workspace.id)).toBe(true)
    expect(registry.getLoaded(workspaceRuntime.workspace.id)).toBeUndefined()

    const reloaded = await registry.getOrLoad(workspaceRuntime.workspace.id)
    expect((await reloaded.simulationRuns.listKnown()).map(summary => summary.id)).toEqual([simulationRun.id])
    await registry.shutdown()
  })
})
