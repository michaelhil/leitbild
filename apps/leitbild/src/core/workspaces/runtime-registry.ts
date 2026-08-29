import type { WorkspaceId } from '@samsinn-leitbild/platform-contracts'
import type { InteractionHandler } from '../model/index.ts'
import type { ScenarioCatalog } from '../scenarios/catalog.ts'
import type { ProcedureSourceService } from '../procedures/source.ts'
import type { PackRuntimeAdapter } from '../../simulation/protocol.ts'
import { createSimulationRunRegistry, type SimulationRunRegistry } from '../simulation-runs/registry.ts'
import type { MicroworldModuleMarker, MicroworldModuleState } from './module-state.ts'

export interface MicroworldWorkspaceRuntime {
  readonly workspaceId: WorkspaceId
  readonly simulationRuns: SimulationRunRegistry
}

export interface MicroworldWorkspaceRuntimeRegistry {
  readonly list: () => Promise<ReadonlyArray<MicroworldModuleMarker>>
  readonly provision: (id: WorkspaceId) => Promise<{
    readonly runtime: MicroworldWorkspaceRuntime
    readonly created: boolean
  }>
  readonly getOrLoad: (id: WorkspaceId) => Promise<MicroworldWorkspaceRuntime>
  readonly getLoaded: (id: WorkspaceId) => MicroworldWorkspaceRuntime | undefined
  readonly close: (id: WorkspaceId) => Promise<boolean>
  readonly remove: (id: WorkspaceId) => Promise<boolean>
  readonly shutdown: () => Promise<void>
}

export const createMicroworldWorkspaceRuntimeRegistry = (config: {
  readonly dataDir: string
  readonly moduleState: MicroworldModuleState
  readonly scenarioCatalog: ScenarioCatalog
  readonly runtimeAdapters: ReadonlyArray<PackRuntimeAdapter>
  readonly interactionHandlers?: ReadonlyArray<InteractionHandler>
  readonly idleRuntimeCloseDelayMs?: number
  readonly procedureSourceService?: ProcedureSourceService
}): MicroworldWorkspaceRuntimeRegistry => {
  const loaded = new Map<WorkspaceId, MicroworldWorkspaceRuntime>()
  const pendingLoads = new Map<WorkspaceId, Promise<MicroworldWorkspaceRuntime>>()

  const build = (workspaceId: WorkspaceId): MicroworldWorkspaceRuntime => ({
    workspaceId,
    simulationRuns: createSimulationRunRegistry({
      dataDir: config.dataDir,
      workspaceId,
      scenarioCatalog: config.scenarioCatalog,
      runtimeAdapters: config.runtimeAdapters,
      ...(config.interactionHandlers === undefined ? {} : { interactionHandlers: config.interactionHandlers }),
      ...(config.idleRuntimeCloseDelayMs === undefined ? {} : { idleRuntimeCloseDelayMs: config.idleRuntimeCloseDelayMs }),
      ...(config.procedureSourceService === undefined ? {} : { procedureSourceService: config.procedureSourceService }),
    }),
  })

  const getOrLoad = async (id: WorkspaceId): Promise<MicroworldWorkspaceRuntime> => {
    const current = loaded.get(id)
    if (current) return current
    const pending = pendingLoads.get(id)
    if (pending) return await pending
    const loading = (async (): Promise<MicroworldWorkspaceRuntime> => {
      if (!await config.moduleState.get(id)) throw new Error(`Microworld Module not provisioned: ${id}`)
      const runtime = build(id)
      loaded.set(id, runtime)
      return runtime
    })().finally(() => {
      pendingLoads.delete(id)
    })
    pendingLoads.set(id, loading)
    return await loading
  }

  const provision = async (id: WorkspaceId) => {
    const provisioned = await config.moduleState.provision(id)
    return {
      runtime: loaded.get(id) ?? await getOrLoad(id),
      created: provisioned.created,
    }
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
    await close(id)
    return await config.moduleState.remove(id)
  }

  return {
    list: () => config.moduleState.list(),
    provision,
    getOrLoad,
    getLoaded: id => loaded.get(id),
    close,
    remove,
    shutdown: async () => {
      for (const id of [...loaded.keys()]) await close(id)
    },
  }
}
