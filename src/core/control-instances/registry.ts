import { randomUUID } from 'node:crypto'
import { lstat, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { ControlInstanceId, InteractionHandler, ScenarioDefinition } from '../model/index.ts'
import { controlInstanceIdSchema } from '../model/index.ts'
import type { SimulationAdapter } from '../../simulation/protocol.ts'
import { createSimulationHub } from '../../simulation/hub.ts'
import type { ScenarioCatalog } from '../scenarios/catalog.ts'
import { createJsonlEventLog } from './event-log.ts'
import { createControlInstanceRuntime, type ControlInstanceRuntime } from './runtime.ts'
import { createControlInstanceSnapshotStore } from './snapshot-store.ts'
import type { DomainEvent } from '../model/index.ts'

export interface ControlInstanceSummary {
  readonly id: ControlInstanceId
  readonly loaded: boolean
  readonly snapshotSeq: number | null
  readonly objectCount: number | null
}

export interface ControlInstanceRegistryStatus {
  readonly dataDir: string
  readonly storage: {
    readonly totalBytes: number
    readonly fileCount: number
    readonly directoryCount: number
  }
  readonly controlInstances: ReadonlyArray<ControlInstanceSummary>
}

export interface ControlInstanceRegistry {
  readonly create: (config?: { readonly id?: ControlInstanceId; readonly scenarioId?: string }) => Promise<ControlInstanceRuntime>
  readonly ensure: (id: ControlInstanceId, config?: { readonly scenarioId?: string }) => Promise<ControlInstanceRuntime>
  readonly reset: (id: ControlInstanceId, config?: { readonly scenarioId?: string }) => Promise<ControlInstanceRuntime>
  readonly get: (id: ControlInstanceId) => ControlInstanceRuntime | undefined
  readonly list: () => ReadonlyArray<ControlInstanceRuntime>
  readonly listKnown: () => Promise<ReadonlyArray<ControlInstanceSummary>>
  readonly status: () => Promise<ControlInstanceRegistryStatus>
  readonly scenarios: () => ReadonlyArray<ScenarioDefinition>
  readonly scenario: (id: string) => ScenarioDefinition | undefined
  readonly defaultScenarioId: () => string
  readonly close: (id: ControlInstanceId) => Promise<boolean>
}

export const createControlInstanceRegistry = (config: {
  readonly dataDir: string
  readonly simulationAdapters: ReadonlyArray<SimulationAdapter>
  readonly scenarioCatalog: ScenarioCatalog
  readonly interactionHandlers?: ReadonlyArray<InteractionHandler>
}): ControlInstanceRegistry => {
  const controlInstances = new Map<ControlInstanceId, ControlInstanceRuntime>()
  const controlInstanceRoot = join(config.dataDir, 'control-instances')

  const validateRestoredEvents = (id: ControlInstanceId, events: ReadonlyArray<DomainEvent>): void => {
    let previousSeq = 0
    for (const event of events) {
      if (event.controlInstanceId !== id) {
        throw new Error(`event log control instance mismatch: expected ${id}, got ${event.controlInstanceId}`)
      }
      if (event.seq <= previousSeq) {
        throw new Error(`event log sequence regression for ${id}: ${event.seq} after ${previousSeq}`)
      }
      previousSeq = event.seq
    }
  }

  const create = async (createConfig?: { readonly id?: ControlInstanceId; readonly scenarioId?: string }): Promise<ControlInstanceRuntime> => {
    const id = createConfig?.id ?? `control-instance:${randomUUID()}` as ControlInstanceId
    if (controlInstances.has(id)) throw new Error(`control instance already exists: ${id}`)
    const instanceDir = join(controlInstanceRoot, id)
    const eventLog = createJsonlEventLog(join(instanceDir, 'events.jsonl'))
    const snapshotStore = createControlInstanceSnapshotStore({
      controlInstanceId: id,
      path: join(instanceDir, 'snapshot.json'),
    })
    let restoredSnapshot = await snapshotStore.load()
    let restoredEvents: ReadonlyArray<DomainEvent> = []
    if (
      restoredSnapshot
      && createConfig?.scenarioId !== undefined
      && restoredSnapshot.scenario?.scenarioId !== createConfig.scenarioId
    ) {
      await rm(instanceDir, { recursive: true, force: true })
      restoredSnapshot = null
    } else {
      restoredEvents = await eventLog.readAll()
      validateRestoredEvents(id, restoredEvents)
    }
    const maxEventSeq = restoredEvents.at(-1)?.seq ?? 0
    if (restoredSnapshot && restoredSnapshot.seq < maxEventSeq) {
      throw new Error(`snapshot sequence ${restoredSnapshot.seq} is behind event log sequence ${maxEventSeq} for ${id}`)
    }
    const scenarioId = restoredSnapshot
      ? restoredSnapshot.scenario?.scenarioId
      : createConfig?.scenarioId ?? config.scenarioCatalog.defaultScenarioId()
    const scenarioRuntime = scenarioId === undefined ? undefined : config.scenarioCatalog.runtimeFor(scenarioId)
    if (scenarioId !== undefined && !scenarioRuntime) throw new Error(`unknown scenario: ${scenarioId}`)
    const simulation = await createSimulationHub(config.simulationAdapters).connect({
      controlInstanceId: id,
      ...(!restoredSnapshot && scenarioRuntime
        ? {
            scenario: {
              scenarioId: scenarioRuntime.scenarioId,
              providerIds: scenarioRuntime.providers.map(provider => provider.providerId),
              world: scenarioRuntime.scenario.world,
              initialObjects: scenarioRuntime.initialObjects,
              providerConfigs: scenarioRuntime.providerConfigs,
              providerConfig: {},
            },
          }
        : {}),
      ...(restoredSnapshot ? { initialObjects: restoredSnapshot.objects } : {}),
    })
    const runtime = await createControlInstanceRuntime({
      id,
      simulation,
      eventLog,
      snapshotStore,
      ...(config.interactionHandlers ? { interactionHandlers: config.interactionHandlers } : {}),
      ...(restoredSnapshot ? { restoredSnapshot } : {}),
      ...(restoredEvents.length === 0 ? {} : { restoredEvents }),
      ...(scenarioRuntime === undefined
        ? {}
        : {
            scenario: {
              id: scenarioRuntime.scenarioId,
              ...(scenarioRuntime.scenario.world.startsAt === undefined ? {} : { startsAt: scenarioRuntime.scenario.world.startsAt }),
              ...(scenarioRuntime.scenario.script === undefined ? {} : { script: scenarioRuntime.scenario.script }),
            },
          }),
    })
    controlInstances.set(id, runtime)
    return runtime
  }

  const ensure = async (id: ControlInstanceId, ensureConfig?: { readonly scenarioId?: string }): Promise<ControlInstanceRuntime> => {
    const existing = controlInstances.get(id)
    if (existing) {
      if (ensureConfig?.scenarioId !== undefined && existing.snapshot().scenario?.scenarioId !== ensureConfig.scenarioId) {
        return await reset(id, { scenarioId: ensureConfig.scenarioId })
      }
      return existing
    }
    return create({
      id,
      ...(ensureConfig?.scenarioId === undefined ? {} : { scenarioId: ensureConfig.scenarioId }),
    })
  }

  const close = async (id: ControlInstanceId): Promise<boolean> => {
    const runtime = controlInstances.get(id)
    if (!runtime) return false
    await runtime.close()
    controlInstances.delete(id)
    return true
  }

  const reset = async (id: ControlInstanceId, resetConfig?: { readonly scenarioId?: string }): Promise<ControlInstanceRuntime> => {
    await close(id)
    await rm(join(controlInstanceRoot, id), { recursive: true, force: true })
    return create({
      id,
      ...(resetConfig?.scenarioId === undefined ? {} : { scenarioId: resetConfig.scenarioId }),
    })
  }

  const listPersistedIds = async (): Promise<ReadonlyArray<ControlInstanceId>> => {
    let entries: ReadonlyArray<{ readonly isDirectory: () => boolean; readonly name: string }>
    try {
      entries = await readdir(controlInstanceRoot, { withFileTypes: true })
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw err
    }
    return entries
      .filter(entry => entry.isDirectory())
      .map(entry => controlInstanceIdSchema.safeParse(entry.name))
      .filter((result): result is { readonly success: true; readonly data: ControlInstanceId } => result.success)
      .map(result => result.data)
      .sort()
  }

  const summaryFor = async (id: ControlInstanceId): Promise<ControlInstanceSummary> => {
    const loaded = controlInstances.get(id)
    if (loaded) {
      const snapshot = loaded.snapshot()
      return {
        id,
        loaded: true,
        snapshotSeq: snapshot.seq,
        objectCount: snapshot.objects.length,
      }
    }
    const snapshotStore = createControlInstanceSnapshotStore({
      controlInstanceId: id,
      path: join(controlInstanceRoot, id, 'snapshot.json'),
    })
    const snapshot = await snapshotStore.load()
    return {
      id,
      loaded: false,
      snapshotSeq: snapshot?.seq ?? null,
      objectCount: snapshot?.objects.length ?? null,
    }
  }

  const listKnown = async (): Promise<ReadonlyArray<ControlInstanceSummary>> => {
    const ids = new Set<ControlInstanceId>([...controlInstances.keys(), ...await listPersistedIds()])
    const summaries: ControlInstanceSummary[] = []
    for (const id of [...ids].sort()) summaries.push(await summaryFor(id))
    return summaries
  }

  const measureDirectory = async (path: string): Promise<ControlInstanceRegistryStatus['storage']> => {
    let totalBytes = 0
    let fileCount = 0
    let directoryCount = 0
    const visit = async (entryPath: string): Promise<void> => {
      let entryStats
      try {
        entryStats = await lstat(entryPath)
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
        throw err
      }
      if (entryStats.isDirectory()) {
        directoryCount += 1
        for (const entry of await readdir(entryPath)) await visit(join(entryPath, entry))
        return
      }
      if (entryStats.isFile()) {
        fileCount += 1
        totalBytes += entryStats.size
      }
    }
    await visit(config.dataDir)
    return { totalBytes, fileCount, directoryCount }
  }

  const status = async (): Promise<ControlInstanceRegistryStatus> => ({
    dataDir: config.dataDir,
    storage: await measureDirectory(config.dataDir),
    controlInstances: await listKnown(),
  })

  return {
    create,
    ensure,
    reset,
    get: (id: ControlInstanceId) => controlInstances.get(id),
    list: () => [...controlInstances.values()],
    listKnown,
    status,
    scenarios: () => config.scenarioCatalog.listScenarios(),
    scenario: (id: string) => config.scenarioCatalog.getScenario(id),
    defaultScenarioId: () => config.scenarioCatalog.defaultScenarioId(),
    close,
  }
}
