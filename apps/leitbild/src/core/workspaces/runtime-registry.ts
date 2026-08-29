import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { WorkspaceId } from '@samsinn-leitbild/platform-contracts'
import type { InteractionHandler } from '../model/index.ts'
import type { ScenarioCatalog } from '../scenarios/catalog.ts'
import type { ProcedureSourceService } from '../procedures/source.ts'
import type { PackRuntimeAdapter } from '../../simulation/protocol.ts'
import { createSimulationRunRegistry, type SimulationRunRegistry } from '../simulation-runs/registry.ts'
import type { WorkspaceDirectory, WorkspaceRecord } from './directory.ts'

export interface LeitbildWorkspaceRuntime {
  readonly workspace: WorkspaceRecord
  readonly simulationRuns: SimulationRunRegistry
}

export interface LeitbildWorkspaceRuntimeRegistry {
  readonly list: () => Promise<ReadonlyArray<WorkspaceRecord>>
  readonly provision: (id: WorkspaceId) => Promise<LeitbildWorkspaceRuntime>
  readonly getOrLoad: (id: WorkspaceId) => Promise<LeitbildWorkspaceRuntime>
  readonly getLoaded: (id: WorkspaceId) => LeitbildWorkspaceRuntime | undefined
  readonly close: (id: WorkspaceId) => Promise<boolean>
  readonly remove: (id: WorkspaceId) => Promise<boolean>
  readonly shutdown: () => Promise<void>
}

export const createLeitbildWorkspaceRuntimeRegistry = (config: {
  readonly dataDir: string
  readonly workspaceDirectory: WorkspaceDirectory
  readonly scenarioCatalog: ScenarioCatalog
  readonly runtimeAdapters: ReadonlyArray<PackRuntimeAdapter>
  readonly interactionHandlers?: ReadonlyArray<InteractionHandler>
  readonly idleRuntimeCloseDelayMs?: number
  readonly procedureSourceService?: ProcedureSourceService
}): LeitbildWorkspaceRuntimeRegistry => {
  const loaded = new Map<WorkspaceId, LeitbildWorkspaceRuntime>()
  const pendingLoads = new Map<WorkspaceId, Promise<LeitbildWorkspaceRuntime>>()

  const build = (workspace: WorkspaceRecord): LeitbildWorkspaceRuntime => ({
    workspace,
    simulationRuns: createSimulationRunRegistry({
      dataDir: config.dataDir,
      workspaceId: workspace.id,
      scenarioCatalog: config.scenarioCatalog,
      runtimeAdapters: config.runtimeAdapters,
      ...(config.interactionHandlers === undefined ? {} : { interactionHandlers: config.interactionHandlers }),
      ...(config.idleRuntimeCloseDelayMs === undefined ? {} : { idleRuntimeCloseDelayMs: config.idleRuntimeCloseDelayMs }),
      ...(config.procedureSourceService === undefined ? {} : { procedureSourceService: config.procedureSourceService }),
    }),
  })

  const getOrLoad = async (id: WorkspaceId): Promise<LeitbildWorkspaceRuntime> => {
    const current = loaded.get(id)
    if (current) return current
    const pending = pendingLoads.get(id)
    if (pending) return await pending
    const loading = (async (): Promise<LeitbildWorkspaceRuntime> => {
      const workspace = await config.workspaceDirectory.get(id)
      if (!workspace) throw new Error(`Workspace not found: ${id}`)
      const runtime = build(workspace)
      loaded.set(id, runtime)
      return runtime
    })().finally(() => {
      pendingLoads.delete(id)
    })
    pendingLoads.set(id, loading)
    return await loading
  }

  const provision = async (id: WorkspaceId): Promise<LeitbildWorkspaceRuntime> => {
    const workspace = await config.workspaceDirectory.create(id)
    const current = loaded.get(id)
    if (!current) return await getOrLoad(id)
    return current
  }

  const close = async (id: WorkspaceId): Promise<boolean> => {
    const runtime = loaded.get(id)
    if (!runtime) return false
    for (const simulationRun of runtime.simulationRuns.list()) {
      await runtime.simulationRuns.close(simulationRun.id)
    }
    loaded.delete(id)
    return true
  }

  const remove = async (id: WorkspaceId): Promise<boolean> => {
    const exists = await config.workspaceDirectory.get(id)
    if (!exists) return false
    await close(id)
    await rm(join(config.dataDir, 'workspaces', id, 'leitbild'), { recursive: true, force: true })
    return await config.workspaceDirectory.delete(id)
  }

  return {
    list: () => config.workspaceDirectory.list(),
    provision,
    getOrLoad,
    getLoaded: (id) => loaded.get(id),
    close,
    remove,
    shutdown: async () => {
      for (const id of [...loaded.keys()]) await close(id)
    },
  }
}
