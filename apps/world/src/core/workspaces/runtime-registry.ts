import type { WorkspaceId } from '@leitbild/contracts'
import type { ProcedureSourceService } from '../../features/procedures/source.ts'
import type { PackRuntimeAdapter } from '../../simulation/protocol.ts'
import type { CompiledScenario } from '../model/index.ts'
import type { ScenarioAuthoringCatalog } from '../scenarios/authoring.ts'
import type { ScenarioDefinition } from '../scenarios/definition.ts'
import type { ScenarioRuntimeResolver } from '../scenarios/runtime-resolver.ts'
import { createSimulationRunRegistry,type SimulationRunRegistry } from '../simulation-runs/registry.ts'
import { createKeyedOperations } from '../storage/keyed-operations.ts'
import type { WorldModuleMarker,WorldModuleState } from './module-state.ts'

export interface WorldWorkspaceRuntime {
  readonly workspaceId: WorkspaceId
  readonly simulationRuns: SimulationRunRegistry
}

export interface WorldWorkspaceRuntimeRegistry {
  readonly list: () => Promise<ReadonlyArray<WorldModuleMarker>>
  readonly provision: (id: WorkspaceId) => Promise<{
    readonly runtime: WorldWorkspaceRuntime
    readonly created: boolean
  }>
  readonly getOrLoad: (id: WorkspaceId) => Promise<WorldWorkspaceRuntime>
  readonly getLoaded: (id: WorkspaceId) => WorldWorkspaceRuntime | undefined
  readonly close: (id: WorkspaceId) => Promise<boolean>
  readonly remove: (id: WorkspaceId) => Promise<boolean>
  readonly shutdown: () => Promise<void>
}

export const createWorldWorkspaceRuntimeRegistry = (config: {
  readonly dataDir: string
  readonly moduleState: WorldModuleState
  readonly scenarioRuntimeResolver: ScenarioRuntimeResolver
  readonly scenarioDefinitions: ReadonlyArray<ScenarioDefinition>
  readonly compileScenarioDefinition: (source: unknown) => Promise<CompiledScenario>
  readonly scenarioAuthoringCatalog: ScenarioAuthoringCatalog
  readonly runtimeAdapters: ReadonlyArray<PackRuntimeAdapter>
  readonly idleRuntimeCloseDelayMs?: number
  readonly procedureSourceService?: ProcedureSourceService
  readonly maxLoadedWorkspaces?: number
}): WorldWorkspaceRuntimeRegistry => {
  const loaded = new Map<WorkspaceId, WorldWorkspaceRuntime>()
  // A finite admission limit bounds idle containers and their compiled caches.
  // Do not LRU-evict a container while callers may hold its definition-write queue.
  const maxLoadedWorkspaces = config.maxLoadedWorkspaces ?? 64
  if (!Number.isSafeInteger(maxLoadedWorkspaces) || maxLoadedWorkspaces < 1) throw new Error('maxLoadedWorkspaces must be a positive integer')
  const lifecycle = createKeyedOperations<WorkspaceId>()
  let shuttingDown = false

  const build = (workspaceId: WorkspaceId): WorldWorkspaceRuntime => ({
    workspaceId,
    simulationRuns: createSimulationRunRegistry({
      dataDir: config.dataDir,
      workspaceId,
      scenarioRuntimeResolver: config.scenarioRuntimeResolver,
      scenarioDefinitions: config.scenarioDefinitions,
      compileScenarioDefinition: config.compileScenarioDefinition,
      scenarioAuthoringCatalog: config.scenarioAuthoringCatalog,
      runtimeAdapters: config.runtimeAdapters,
      ...(config.idleRuntimeCloseDelayMs === undefined ? {} : { idleRuntimeCloseDelayMs: config.idleRuntimeCloseDelayMs }),
      ...(config.procedureSourceService === undefined ? {} : { procedureSourceService: config.procedureSourceService }),
    }),
  })

  const getOrLoad = (id: WorkspaceId): Promise<WorldWorkspaceRuntime> => lifecycle.run(id, async () => {
    if (shuttingDown) throw new Error('World runtime registry is shutting down')
    const current = loaded.get(id)
    if (current) return current
    if (!await config.moduleState.get(id)) throw new Error(`World Module not provisioned: ${id}`)
    if (loaded.size >= maxLoadedWorkspaces) throw Object.assign(new Error(`World Workspace runtime capacity (${maxLoadedWorkspaces}) reached; close a Workspace runtime before loading another`), { code: 'workspace_capacity_exceeded' })
    const runtime = build(id)
    loaded.set(id, runtime)
    return runtime
  })

  const provision = async (id: WorkspaceId) => {
    const provisioned = await config.moduleState.provision(id)
    return {
      runtime: loaded.get(id) ?? await getOrLoad(id),
      created: provisioned.created,
    }
  }

  const closeLoaded = async (id: WorkspaceId): Promise<boolean> => {
    const runtime = loaded.get(id)
    if (!runtime) return false
    await runtime.simulationRuns.shutdown()
    loaded.delete(id)
    return true
  }
  const close = (id: WorkspaceId): Promise<boolean> => lifecycle.run(id, () => closeLoaded(id))

  const remove = (id: WorkspaceId): Promise<boolean> => lifecycle.run(id, async () => {
    await closeLoaded(id)
    return await config.moduleState.remove(id)
  })

  return {
    list: () => config.moduleState.list(),
    provision,
    getOrLoad,
    getLoaded: id => loaded.get(id),
    close,
    remove,
    shutdown: async () => {
      shuttingDown = true
      await lifecycle.drain()
      for (const id of [...loaded.keys()]) await close(id)
    },
  }
}
