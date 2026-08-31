import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { newWorkspaceId } from '@leitbild/contracts'
import { createWorldModuleState } from './module-state.ts'
import { worldWorkspacePaths } from './paths.ts'
import { createWorldWorkspaceRuntimeRegistry, type WorldWorkspaceRuntimeRegistry } from './runtime-registry.ts'
import { createTestPackRuntimeAdapters, createTestScenarioCatalog, testScenarioAuthoring } from '../../../tests/helpers.ts'

const temporaryDirectories: string[] = []
const registries: WorldWorkspaceRuntimeRegistry[] = []

afterEach(async () => {
  for (const registry of registries.splice(0)) await registry.shutdown()
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

const createRegistry = async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'world-workspace-runtime-'))
  temporaryDirectories.push(dataDir)
  const registry = createWorldWorkspaceRuntimeRegistry({
    dataDir,
    moduleState: createWorldModuleState({ dataDir }),
    scenarioCatalog: createTestScenarioCatalog(),
    ...testScenarioAuthoring(),
    runtimeAdapters: createTestPackRuntimeAdapters(),
  })
  registries.push(registry)
  return { dataDir, registry }
}

describe('World Workspace runtime registry', () => {
  test('accepts only a Host-provisioned id and deduplicates concurrent loads', async () => {
    const { registry } = await createRegistry()
    const workspaceId = newWorkspaceId()
    const provisioned = await registry.provision(workspaceId)
    const [first, second] = await Promise.all([registry.getOrLoad(workspaceId), registry.getOrLoad(workspaceId)])
    expect(first).toBe(provisioned.runtime)
    expect(second).toBe(first)
    expect(first.workspaceId).toBe(workspaceId)
    await expect(registry.getOrLoad(newWorkspaceId())).rejects.toThrow('World Module not provisioned')
  })

  test('isolates Scenario libraries and Simulation Runs by Workspace', async () => {
    const { registry } = await createRegistry()
    const first = (await registry.provision(newWorkspaceId())).runtime
    const second = (await registry.provision(newWorkspaceId())).runtime
    const firstRun = await first.simulationRuns.create()
    const secondRun = await second.simulationRuns.create()
    expect(firstRun.id).not.toBe(secondRun.id)
    expect(await first.simulationRuns.listKnown()).toHaveLength(1)
    expect(await second.simulationRuns.listKnown()).toHaveLength(1)
  })

  test('distinguishes unloading from destructive Module removal', async () => {
    const { dataDir, registry } = await createRegistry()
    const workspaceId = newWorkspaceId()
    const workspace = (await registry.provision(workspaceId)).runtime
    const simulationRun = await workspace.simulationRuns.create()
    expect(await registry.close(workspaceId)).toBe(true)
    expect((await registry.getOrLoad(workspaceId)).simulationRuns.listKnown()).resolves.toContainEqual(
      expect.objectContaining({ id: simulationRun.id }),
    )

    expect(await registry.remove(workspaceId)).toBe(true)
    expect(registry.getOrLoad(workspaceId)).rejects.toThrow('World Module not provisioned')
    expect(Bun.file(join(worldWorkspacePaths(dataDir, workspaceId).simulationRuns, simulationRun.id, 'manifest.json')).exists()).resolves.toBe(false)
  })
})
