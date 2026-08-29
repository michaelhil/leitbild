import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { newWorkspaceId } from '@samsinn-leitbild/platform-contracts'
import { createLocalWorkspaceDirectory } from './directory.ts'
import { createLeitbildWorkspaceRuntimeRegistry, type LeitbildWorkspaceRuntimeRegistry } from './runtime-registry.ts'
import { createTestPackRuntimeAdapters, createTestScenarioCatalog } from '../../../tests/helpers.ts'

const temporaryDirectories: string[] = []
const registries: LeitbildWorkspaceRuntimeRegistry[] = []

afterEach(async () => {
  for (const registry of registries.splice(0)) await registry.shutdown()
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

const createRegistry = async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'leitbild-workspace-runtime-'))
  temporaryDirectories.push(dataDir)
  const registry = createLeitbildWorkspaceRuntimeRegistry({
    dataDir,
    workspaceDirectory: createLocalWorkspaceDirectory({ path: join(dataDir, 'workspace-directory.json') }),
    scenarioCatalog: createTestScenarioCatalog(),
    runtimeAdapters: createTestPackRuntimeAdapters(),
  })
  registries.push(registry)
  return { dataDir, registry }
}

describe('Microworld Workspace runtime registry', () => {
  test('accepts only a Host-supplied id and deduplicates concurrent loads', async () => {
    const { registry } = await createRegistry()
    const workspaceId = newWorkspaceId()
    const provisioned = await registry.provision(workspaceId)
    const [first, second] = await Promise.all([registry.getOrLoad(workspaceId), registry.getOrLoad(workspaceId)])
    expect(first).toBe(provisioned)
    expect(second).toBe(first)
    expect(first.simulationRuns.workspaceId).toBe(workspaceId)
    await expect(registry.getOrLoad(newWorkspaceId())).rejects.toThrow('Workspace not found')
  })

  test('isolates Scenario libraries and Simulation Runs by Workspace', async () => {
    const { registry } = await createRegistry()
    const first = await registry.provision(newWorkspaceId())
    const second = await registry.provision(newWorkspaceId())
    const firstRun = await first.simulationRuns.create()
    const secondRun = await second.simulationRuns.create()
    expect(firstRun.id).not.toBe(secondRun.id)
    expect(await first.simulationRuns.listKnown()).toHaveLength(1)
    expect(await second.simulationRuns.listKnown()).toHaveLength(1)
  })

  test('distinguishes unloading from destructive shard removal', async () => {
    const { dataDir, registry } = await createRegistry()
    const workspace = await registry.provision(newWorkspaceId())
    const simulationRun = await workspace.simulationRuns.create()
    expect(await registry.close(workspace.workspace.id)).toBe(true)
    expect((await registry.getOrLoad(workspace.workspace.id)).simulationRuns.listKnown()).resolves.toContainEqual(
      expect.objectContaining({ id: simulationRun.id }),
    )

    expect(await registry.remove(workspace.workspace.id)).toBe(true)
    expect(registry.getOrLoad(workspace.workspace.id)).rejects.toThrow('Workspace not found')
    expect(Bun.file(join(dataDir, 'workspaces', workspace.workspace.id, 'leitbild', 'simulation-runs', simulationRun.id, 'manifest.json')).exists()).resolves.toBe(false)
  })
})
