import { lstat, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { ControlInstanceId, InteractionHandler, ScenarioDefinition } from '../model/index.ts'
import {
  controlInstanceIdSchema,
  createGeneratedScenarioRunId,
  createScenarioRunControlInstanceId,
  parseScenarioRunControlInstanceId,
} from '../model/index.ts'
import type { PackRuntimeAdapter } from '../../simulation/protocol.ts'
import { createRuntimeHub } from '../../simulation/hub.ts'
import type { ScenarioCatalog } from '../scenarios/catalog.ts'
import { createJsonlEventLog } from './event-log.ts'
import { createJsonRuntimeStateStore } from './runtime-state-store.ts'
import { createControlInstanceRuntime, type ControlInstanceRuntime } from './runtime.ts'
import type { ControlInstanceCapabilities } from './runtime.ts'
import { createControlInstanceSnapshotStore } from './snapshot-store.ts'
import type { ControlInstanceEvent } from '../model/index.ts'

export interface ControlInstanceSummary {
  readonly id: ControlInstanceId
  readonly scenarioId: string | null
  readonly runId: string | null
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
  readonly delete: (id: ControlInstanceId) => Promise<boolean>
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
  readonly simulationAdapters: ReadonlyArray<PackRuntimeAdapter>
  readonly scenarioCatalog: ScenarioCatalog
  readonly interactionHandlers?: ReadonlyArray<InteractionHandler>
}): ControlInstanceRegistry => {
  const controlInstances = new Map<ControlInstanceId, ControlInstanceRuntime>()
  const creatingControlInstances = new Map<ControlInstanceId, Promise<ControlInstanceRuntime>>()
  const controlInstanceRoot = join(config.dataDir, 'control-instances')

  const capabilitiesFor = (scenarioRuntime: ReturnType<ScenarioCatalog['runtimeFor']>): Omit<ControlInstanceCapabilities, 'controlInstanceId'> => {
    if (!scenarioRuntime) {
      return {
        scenarioId: null,
        activePackIds: [],
        acceptedCommandKinds: [],
        queryKinds: {},
        wikiRefs: [],
      }
    }
    const activeRuntimeIds = new Set(scenarioRuntime.runtimes.map(runtime => runtime.runtimeId))
    const activeAdapters = config.simulationAdapters.filter(adapter => activeRuntimeIds.has(adapter.id))
    const queryKinds = Object.fromEntries(
      scenarioRuntime.scenario.packs.map(packId => [
        packId,
        [...new Set(activeAdapters
          .filter(adapter => adapter.packId === packId)
          .flatMap(adapter => adapter.queryKinds ?? []))]
          .sort(),
      ]),
    )
    return {
      scenarioId: scenarioRuntime.scenarioId,
      activePackIds: [...scenarioRuntime.scenario.packs],
      acceptedCommandKinds: [...new Set(activeAdapters.flatMap(adapter => adapter.acceptedCommandKinds))].sort(),
      queryKinds,
      wikiRefs: scenarioRuntime.packs.flatMap(pack => pack.wikiRefs ?? []),
    }
  }

  const validateRestoredEvents = (id: ControlInstanceId, events: ReadonlyArray<ControlInstanceEvent>): void => {
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

  const createRuntime = async (createConfig: {
    readonly id: ControlInstanceId
    readonly scenarioId: string
    readonly initialSeq?: number
  }): Promise<ControlInstanceRuntime> => {
    const requestedScenarioId = createConfig.scenarioId
    const id = createConfig.id
    const instanceDir = join(controlInstanceRoot, id)
    const eventLog = createJsonlEventLog(join(instanceDir, 'events.jsonl'))
    const snapshotStore = createControlInstanceSnapshotStore({
      controlInstanceId: id,
      path: join(instanceDir, 'snapshot.json'),
    })
    const runtimeStateStores = Object.fromEntries(config.simulationAdapters.map(adapter => [
      adapter.id,
      createJsonRuntimeStateStore({
        runtimeId: adapter.id,
        path: join(instanceDir, 'runtimes', `${adapter.id}.json`),
      }),
    ]))
    let restoredSnapshot = await snapshotStore.load()
    let restoredEvents: ReadonlyArray<ControlInstanceEvent> = []
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
      : requestedScenarioId
    const scenarioRuntime = scenarioId === undefined ? undefined : config.scenarioCatalog.runtimeFor(scenarioId)
    if (scenarioId !== undefined && !scenarioRuntime) throw new Error(`unknown scenario: ${scenarioId}`)
    const simulation = await createRuntimeHub(config.simulationAdapters).connect({
      controlInstanceId: id,
      ...(scenarioRuntime
        ? {
            scenario: {
              scenarioId: scenarioRuntime.scenarioId,
              runtimeIds: scenarioRuntime.runtimes.map(runtime => runtime.runtimeId),
              world: scenarioRuntime.scenario.world,
              initialObjects: scenarioRuntime.initialObjects,
              processSystems: scenarioRuntime.scenario.processSystems,
              runtimeConfigs: scenarioRuntime.runtimeConfigs,
              runtimeConfig: {},
            },
          }
        : {}),
      ...(restoredSnapshot ? { initialObjects: restoredSnapshot.objects } : {}),
      runtimeStateStores,
    })
    const runtime = await createControlInstanceRuntime({
      id,
      simulation,
      eventLog,
      snapshotStore,
      ...(config.interactionHandlers ? { interactionHandlers: config.interactionHandlers } : {}),
      ...(restoredSnapshot ? { restoredSnapshot } : {}),
      ...(restoredEvents.length === 0 ? {} : { restoredEvents }),
      ...(createConfig?.initialSeq === undefined ? {} : { initialSeq: createConfig.initialSeq }),
      ...(scenarioRuntime === undefined
        ? {}
        : {
            scenario: {
              id: scenarioRuntime.scenarioId,
              ...(scenarioRuntime.scenario.world.startsAt === undefined ? {} : { startsAt: scenarioRuntime.scenario.world.startsAt }),
              ...(scenarioRuntime.scenario.script === undefined ? {} : { script: scenarioRuntime.scenario.script }),
            },
          }),
      capabilities: capabilitiesFor(scenarioRuntime),
    })
    controlInstances.set(id, runtime)
    return runtime
  }

  const create = async (createConfig?: { readonly id?: ControlInstanceId; readonly scenarioId?: string; readonly initialSeq?: number }): Promise<ControlInstanceRuntime> => {
    const requestedScenarioId = createConfig?.scenarioId ?? config.scenarioCatalog.defaultScenarioId()
    if (!config.scenarioCatalog.runtimeFor(requestedScenarioId)) throw new Error(`unknown scenario: ${requestedScenarioId}`)
    const id = createConfig?.id ?? createScenarioRunControlInstanceId({
      scenarioId: requestedScenarioId,
      runId: createGeneratedScenarioRunId(),
    })
    if (controlInstances.has(id) || creatingControlInstances.has(id)) throw new Error(`control instance already exists: ${id}`)
    const creating = createRuntime({
      id,
      scenarioId: requestedScenarioId,
      ...(createConfig?.initialSeq === undefined ? {} : { initialSeq: createConfig.initialSeq }),
    }).finally(() => {
      creatingControlInstances.delete(id)
    })
    creatingControlInstances.set(id, creating)
    return await creating
  }

  const ensure = async (id: ControlInstanceId, ensureConfig?: { readonly scenarioId?: string }): Promise<ControlInstanceRuntime> => {
    const existing = controlInstances.get(id)
    if (existing) {
      if (ensureConfig?.scenarioId !== undefined && existing.snapshot().scenario?.scenarioId !== ensureConfig.scenarioId) {
        return await reset(id, { scenarioId: ensureConfig.scenarioId })
      }
      return existing
    }
    const creating = creatingControlInstances.get(id)
    if (creating) {
      const runtime = await creating
      if (ensureConfig?.scenarioId !== undefined && runtime.snapshot().scenario?.scenarioId !== ensureConfig.scenarioId) {
        return await reset(id, { scenarioId: ensureConfig.scenarioId })
      }
      return runtime
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
    const existing = controlInstances.get(id)
    const resetEvent = existing
      ? await existing.publishResetBoundary({
          scenarioId: resetConfig?.scenarioId ?? config.scenarioCatalog.defaultScenarioId(),
        })
      : undefined
    await close(id)
    await rm(join(controlInstanceRoot, id), { recursive: true, force: true })
    return create({
      id,
      ...(resetConfig?.scenarioId === undefined ? {} : { scenarioId: resetConfig.scenarioId }),
      ...(resetEvent === undefined ? {} : { initialSeq: resetEvent.seq + 1 }),
    })
  }

  const deleteControlInstance = async (id: ControlInstanceId): Promise<boolean> => {
    const wasLoaded = await close(id)
    const instanceDir = join(controlInstanceRoot, id)
    let existedOnDisk = true
    try {
      await lstat(instanceDir)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
      existedOnDisk = false
    }
    if (existedOnDisk) await rm(instanceDir, { recursive: true, force: true })
    return wasLoaded || existedOnDisk
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
      const scenarioRun = parseScenarioRunControlInstanceId(id, snapshot.scenario?.scenarioId)
      return {
        id,
        ...scenarioRun,
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
    const scenarioRun = parseScenarioRunControlInstanceId(id, snapshot?.scenario?.scenarioId)
    return {
      id,
      ...scenarioRun,
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
    delete: deleteControlInstance,
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
