import type { WorkspaceId } from '@leitbild/contracts'
import type { ProcedureSourceService } from '../../features/procedures/source.ts'
import type { PackRuntimeAdapter } from '../../simulation/protocol.ts'
import type { CompiledScenario } from '../model/index.ts'
import type { ScenarioAuthoringCatalog } from '../scenarios/authoring.ts'
import type { ScenarioDefinition } from '../scenarios/definition.ts'
import type { ScenarioRuntimeResolver } from '../scenarios/runtime-resolver.ts'
import { createSimulationRunRegistry,type SimulationRunRegistry } from '../simulation-runs/registry.ts'
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
}): WorldWorkspaceRuntimeRegistry => {
  const loaded = new Map<WorkspaceId, WorldWorkspaceRuntime>()
  const pendingLoads = new Map<WorkspaceId, Promise<WorldWorkspaceRuntime>>()

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

  const getOrLoad = async (id: WorkspaceId): Promise<WorldWorkspaceRuntime> => {
    const current = loaded.get(id)
    if (current) return current
    const pending = pendingLoads.get(id)
    if (pending) return await pending
    const loading = (async (): Promise<WorldWorkspaceRuntime> => {
      if (!await config.moduleState.get(id)) throw new Error(`World Module not provisioned: ${id}`)
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
