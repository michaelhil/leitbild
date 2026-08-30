import { lstat, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { ZodError } from 'zod'
import { semanticVersionSchema, type WorkspaceId } from '@leitbild/contracts'
import type { SimulationRunId, InteractionHandler } from '../model/index.ts'
import {
  simulationRunIdSchema,
  newSimulationRunId,
  deleteObjectCommandKind,
  procedureCommandKindSchema,
} from '../model/index.ts'
import type { PackRuntimeAdapter } from '../../simulation/protocol.ts'
import { createRuntimeHub } from '../../simulation/runtime-hub.ts'
import type { ScenarioCatalog } from '../scenarios/catalog.ts'
import { createJsonlEventLog } from './event-log.ts'
import { createJsonRuntimeStateStore } from './runtime-state-store.ts'
import { createSimulationRunRuntime, type SimulationRunRuntime } from './runtime.ts'
import type { SimulationRunCapabilities } from './runtime.ts'
import type { SimulationRunRuntimeMetricsSnapshot } from './runtime-metrics.ts'
import { defaultSimulationRunRuntimePolicy } from './runtime-persistence-policy.ts'
import { createSimulationRunSnapshotStore } from './snapshot-store.ts'
import type { SimulationClockState, SimulationRunEvent } from '../model/index.ts'
import { worldWorkspacePaths } from '../workspaces/paths.ts'
import { createProcedureSourceService, type ProcedureSourceService } from '../procedures/source.ts'
import { createLocalScenarioLibrary, type ScenarioLibrary, type ScenarioRecord, type ScenarioRevision, type ScenarioRevisionId } from '../scenarios/library.ts'
import {
  createSimulationRunManifestStore,
  scenarioRevisionIdFromManifest,
  simulationRunManifestSchema,
  type SimulationRunManifest,
} from './manifest.ts'

const maxRestoredEventHistoryBytes = 8 * 1024 * 1024

export type SimulationRunLeaseKind = 'realtime' | 'api' | 'background'

export interface SimulationRunLeaseSummary {
  readonly simulationRunId: SimulationRunId
  readonly leaseCount: number
  readonly leasesByKind: Readonly<Record<SimulationRunLeaseKind, number>>
}

export interface SimulationRunSummary {
  readonly id: SimulationRunId
  readonly scenarioId: string | null
  readonly scenarioTitle: string | null
  readonly scenarioRevisionId: string | null
  readonly createdAt: string | null
  readonly loaded: boolean
  readonly snapshotSeq: number | null
  readonly objectCount: number | null
  readonly clock: SimulationClockState | null
  readonly loadError?: string
}

export interface SimulationRunRegistryStatus {
  readonly dataDir: string
  readonly storage: {
    readonly totalBytes: number
    readonly fileCount: number
    readonly directoryCount: number
  }
  readonly simulationRuns: ReadonlyArray<SimulationRunSummary>
  readonly loadedRuntimeMetrics: ReadonlyArray<SimulationRunRuntimeMetricsSnapshot>
  readonly leases: ReadonlyArray<SimulationRunLeaseSummary>
}

export interface SimulationRunRegistry {
  readonly workspaceId: WorkspaceId
  readonly create: (config?: { readonly scenarioId?: string; readonly scenarioRevisionId?: ScenarioRevisionId }) => Promise<SimulationRunRuntime>
  readonly load: (id: SimulationRunId) => Promise<SimulationRunRuntime>
  readonly reset: (id: SimulationRunId) => Promise<SimulationRunRuntime>
  readonly delete: (id: SimulationRunId) => Promise<boolean>
  readonly get: (id: SimulationRunId) => SimulationRunRuntime | undefined
  readonly list: () => ReadonlyArray<SimulationRunRuntime>
  readonly listKnown: () => Promise<ReadonlyArray<SimulationRunSummary>>
  readonly status: () => Promise<SimulationRunRegistryStatus>
  readonly acquireLease: (id: SimulationRunId, kind: SimulationRunLeaseKind) => () => void
  readonly leaseSummary: (id: SimulationRunId) => SimulationRunLeaseSummary
  readonly listScenarios: () => Promise<ReadonlyArray<ScenarioRecord>>
  readonly currentScenario: (id: string) => Promise<ScenarioRevision | undefined>
  readonly deleteScenario: (id: string, revisionId: ScenarioRevisionId) => Promise<boolean>
  readonly scenarioRevisionForRun: (id: SimulationRunId) => Promise<ScenarioRevision | undefined>
  readonly defaultScenarioId: () => string
  readonly close: (id: SimulationRunId) => Promise<boolean>
}

export const createSimulationRunRegistry = (config: {
  readonly dataDir: string
  readonly workspaceId: WorkspaceId
  readonly runtimeAdapters: ReadonlyArray<PackRuntimeAdapter>
  readonly scenarioCatalog: ScenarioCatalog
  readonly scenarioLibrary?: ScenarioLibrary
  readonly interactionHandlers?: ReadonlyArray<InteractionHandler>
  readonly idleRuntimeCloseDelayMs?: number
  readonly procedureSourceService?: ProcedureSourceService
}): SimulationRunRegistry => {
  const simulationRuns = new Map<SimulationRunId, SimulationRunRuntime>()
  const procedureSourceService = config.procedureSourceService ?? createProcedureSourceService()
  const creatingSimulationRuns = new Map<SimulationRunId, Promise<SimulationRunRuntime>>()
  const leasesBySimulationRun = new Map<SimulationRunId, Map<string, SimulationRunLeaseKind>>()
  const idleRuntimeCloseTimers = new Map<SimulationRunId, ReturnType<typeof setTimeout>>()
  const idleRuntimeCloseDelayMs = config.idleRuntimeCloseDelayMs ?? defaultSimulationRunRuntimePolicy.idleRuntimeCloseDelayMs
  let nextLeaseNumber = 0
  const workspacePaths = worldWorkspacePaths(config.dataDir, config.workspaceId)
  const workspaceRoot = workspacePaths.root
  const simulationRunRoot = workspacePaths.simulationRuns
  const scenarioLibrary = config.scenarioLibrary ?? createLocalScenarioLibrary({
    workspaceId: config.workspaceId,
    rootDir: workspacePaths.scenarios,
  })
  let scenarioLibraryReady: Promise<void> | null = null

  const ensureScenarioLibrary = (): Promise<void> => {
    scenarioLibraryReady ??= scenarioLibrary.materializeTemplates(config.scenarioCatalog.listScenarios())
    return scenarioLibraryReady
  }

  const clearIdleRuntimeCloseTimer = (id: SimulationRunId): void => {
    const timer = idleRuntimeCloseTimers.get(id)
    if (!timer) return
    clearTimeout(timer)
    idleRuntimeCloseTimers.delete(id)
  }

  const leaseCountFor = (id: SimulationRunId): number =>
    leasesBySimulationRun.get(id)?.size ?? 0

  const leaseSummary = (id: SimulationRunId): SimulationRunLeaseSummary => {
    const leasesByKind: Record<SimulationRunLeaseKind, number> = {
      realtime: 0,
      api: 0,
      background: 0,
    }
    const leases = leasesBySimulationRun.get(id)
    if (leases) for (const kind of leases.values()) leasesByKind[kind] += 1
    return { simulationRunId: id, leaseCount: leases?.size ?? 0, leasesByKind }
  }

  const scheduleIdleRuntimeCloseIfUnleased = (id: SimulationRunId): void => {
    clearIdleRuntimeCloseTimer(id)
    if (idleRuntimeCloseDelayMs < 0) return
    if (!simulationRuns.has(id)) return
    if (creatingSimulationRuns.has(id)) return
    if (leaseCountFor(id) > 0) return
    const timer = setTimeout(() => {
      idleRuntimeCloseTimers.delete(id)
      if (leaseCountFor(id) > 0) return
      if (!simulationRuns.has(id)) return
      const closeIdleRuntime = async (): Promise<void> => {
        try {
          await close(id)
        } catch (err) {
          console.error(`idle simulation run close failed for ${id}:`, err)
        }
      }
      void closeIdleRuntime()
    }, idleRuntimeCloseDelayMs)
    timer.unref?.()
    idleRuntimeCloseTimers.set(id, timer)
  }

  const leaseSummaries = (): ReadonlyArray<SimulationRunLeaseSummary> =>
    [...leasesBySimulationRun.keys()]
      .map(leaseSummary)
      .sort((left, right) => left.simulationRunId.localeCompare(right.simulationRunId))

  const acquireLease = (id: SimulationRunId, kind: SimulationRunLeaseKind): (() => void) => {
    clearIdleRuntimeCloseTimer(id)
    const leaseId = `${kind}:${++nextLeaseNumber}`
    const leases = leasesBySimulationRun.get(id) ?? new Map<string, SimulationRunLeaseKind>()
    leases.set(leaseId, kind)
    leasesBySimulationRun.set(id, leases)
    let released = false
    return () => {
      if (released) return
      released = true
      const current = leasesBySimulationRun.get(id)
      if (!current) return
      current.delete(leaseId)
      if (current.size === 0) leasesBySimulationRun.delete(id)
      scheduleIdleRuntimeCloseIfUnleased(id)
    }
  }

  const capabilitiesFor = (
    scenarioRuntime: ReturnType<ScenarioCatalog['runtimeFor']>,
    scenarioRevisionId: ScenarioRevision['id'],
  ): Omit<SimulationRunCapabilities, 'simulationRunId'> => {
    if (!scenarioRuntime) {
      return {
        workspaceId: config.workspaceId,
        scenarioId: null,
        scenarioRevisionId,
        activePackIds: [],
        acceptedCommandKinds: [],
        queryKinds: {},
        wikiRefs: [],
      }
    }
    const activeRuntimeIds = new Set(scenarioRuntime.runtimes.map(runtime => runtime.runtimeId))
    const activeAdapters = config.runtimeAdapters.filter(adapter => activeRuntimeIds.has(adapter.id))
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
      workspaceId: config.workspaceId,
      scenarioId: scenarioRuntime.scenarioId,
      scenarioRevisionId,
      activePackIds: [...scenarioRuntime.scenario.packs],
      acceptedCommandKinds: [...new Set([
        deleteObjectCommandKind,
        ...procedureCommandKindSchema.options,
        ...activeAdapters.flatMap(adapter => adapter.acceptedCommandKinds),
      ])].sort(),
      queryKinds,
      wikiRefs: scenarioRuntime.packs.flatMap(pack => pack.knowledge?.wikiRefs ?? []),
    }
  }

  const validateRestoredEvents = (id: SimulationRunId, events: ReadonlyArray<SimulationRunEvent>): void => {
    let previousSeq = 0
    for (const event of events) {
      if (event.simulationRunId !== id) {
        throw new Error(`event log simulation run mismatch: expected ${id}, got ${event.simulationRunId}`)
      }
      if (event.seq <= previousSeq) {
        throw new Error(`event log sequence regression for ${id}: ${event.seq} after ${previousSeq}`)
      }
      previousSeq = event.seq
    }
  }

  const validateRestoredEventTail = (id: SimulationRunId, event: SimulationRunEvent | null): void => {
    if (event === null) return
    if (event.simulationRunId !== id) {
      throw new Error(`event log simulation run mismatch: expected ${id}, got ${event.simulationRunId}`)
    }
  }

  const isUnreadableSnapshotError = (err: unknown): boolean =>
    err instanceof SyntaxError || err instanceof ZodError

  const unreadableSnapshotMessage = (err: unknown): string =>
    err instanceof Error ? err.message : 'snapshot could not be read'

  const manifestStoreFor = (id: SimulationRunId) =>
    createSimulationRunManifestStore(join(simulationRunRoot, id, 'manifest.json'))

  const resolveManifest = async (manifest: SimulationRunManifest): Promise<{
    readonly revision: ScenarioRevision
    readonly scenarioRuntime: NonNullable<ReturnType<ScenarioCatalog['runtimeForDefinition']>>
  }> => {
    if (manifest.workspaceId !== config.workspaceId) {
      throw new Error(`Simulation Run Workspace mismatch: expected ${config.workspaceId}, got ${manifest.workspaceId}`)
    }
    const revision = await scenarioLibrary.getRevision(scenarioRevisionIdFromManifest(manifest))
    if (!revision) throw new Error(`Scenario Revision not found: ${manifest.scenario.revisionId}`)
    if (revision.scenarioId !== manifest.scenario.id || revision.digest !== manifest.scenario.digest) {
      throw new Error(`Simulation Run Scenario Revision mismatch: ${manifest.id}`)
    }
    const scenarioRuntime = config.scenarioCatalog.runtimeForDefinition(revision.definition)
    const packVersions = new Map(scenarioRuntime.packs.map(pack => [pack.descriptor.id, pack.descriptor.version]))
    const adapterVersions = new Map(config.runtimeAdapters.map(adapter => [adapter.id, adapter.version]))
    for (const pack of manifest.packs) {
      if (packVersions.get(pack.id) !== pack.version) {
        throw new Error(`Simulation Run Pack version mismatch for ${pack.id}: expected ${pack.version}, installed ${packVersions.get(pack.id) ?? 'missing'}`)
      }
    }
    for (const runtime of manifest.runtimes) {
      if (adapterVersions.get(runtime.id) !== runtime.version) {
        throw new Error(`Simulation Run runtime version mismatch for ${runtime.id}: expected ${runtime.version}, installed ${adapterVersions.get(runtime.id) ?? 'missing'}`)
      }
    }
    return { revision, scenarioRuntime }
  }

  const createManifest = async (id: SimulationRunId, scenarioId: string, scenarioRevisionId?: ScenarioRevisionId): Promise<SimulationRunManifest> => {
    await ensureScenarioLibrary()
    const revision = scenarioRevisionId === undefined
      ? await scenarioLibrary.currentRevision(scenarioId)
      : await scenarioLibrary.getRevision(scenarioRevisionId)
    if (!revision) throw new Error(`unknown Scenario: ${scenarioId}`)
    if (revision.scenarioId !== scenarioId) throw new Error(`Scenario Revision does not belong to Scenario: ${scenarioId}`)
    const scenarioRuntime = config.scenarioCatalog.runtimeForDefinition(revision.definition)
    const adaptersById = new Map(config.runtimeAdapters.map(adapter => [adapter.id, adapter]))
    return simulationRunManifestSchema.parse({
      schemaVersion: 1,
      id,
      workspaceId: config.workspaceId,
      scenario: {
        id: revision.scenarioId,
        revisionId: revision.id,
        digest: revision.digest,
      },
      packs: scenarioRuntime.packs.map(pack => ({
        id: pack.descriptor.id,
        version: semanticVersionSchema.parse(pack.descriptor.version),
      })),
      runtimes: scenarioRuntime.runtimes.map(runtime => {
        const adapter = adaptersById.get(runtime.runtimeId)
        if (!adapter) throw new Error(`missing Pack Runtime: ${runtime.runtimeId}`)
        return {
          id: runtime.runtimeId,
          version: semanticVersionSchema.parse(adapter.version),
          packId: runtime.packId,
        }
      }),
      createdAt: new Date().toISOString(),
    })
  }

  const createRuntime = async (createConfig: {
    readonly manifest: SimulationRunManifest
    readonly initialSeq?: number
  }): Promise<SimulationRunRuntime> => {
    await ensureScenarioLibrary()
    const { scenarioRuntime } = await resolveManifest(createConfig.manifest)
    const id = createConfig.manifest.id
    const runDir = join(simulationRunRoot, id)
    const eventLog = createJsonlEventLog(join(runDir, 'events.jsonl'))
    const snapshotStore = createSimulationRunSnapshotStore({
      simulationRunId: id,
      path: join(runDir, 'snapshot.json'),
    })
    const runtimeStateStores = Object.fromEntries(config.runtimeAdapters.map(adapter => [
      adapter.id,
      createJsonRuntimeStateStore({
        runtimeId: adapter.id,
        path: join(runDir, 'runtimes', `${adapter.id}.json`),
      }),
    ]))
    let restoredSnapshot
    try {
      restoredSnapshot = await snapshotStore.load()
    } catch (err) {
      throw new Error(`Simulation Run snapshot is unreadable for ${id}: ${unreadableSnapshotMessage(err)}`, { cause: err })
    }
    let restoredEvents: ReadonlyArray<SimulationRunEvent> = []
    let maxEventSeq = 0
    if (restoredSnapshot?.scenario?.scenarioId !== undefined && restoredSnapshot.scenario.scenarioId !== createConfig.manifest.scenario.id) {
      throw new Error(`Simulation Run snapshot Scenario mismatch for ${id}: expected ${createConfig.manifest.scenario.id}, got ${restoredSnapshot.scenario.scenarioId}`)
    }
    const eventLogBytes = await eventLog.sizeBytes()
    if (eventLogBytes <= maxRestoredEventHistoryBytes) {
      restoredEvents = await eventLog.readAll()
      validateRestoredEvents(id, restoredEvents)
      maxEventSeq = restoredEvents.at(-1)?.seq ?? 0
    } else {
      const lastEvent = await eventLog.readLast()
      validateRestoredEventTail(id, lastEvent)
      maxEventSeq = lastEvent?.seq ?? 0
      console.warn(`simulation run ${id} has a ${eventLogBytes} byte durable event log; restoring current state from snapshot without preloading full event history`)
    }
    if (restoredSnapshot && restoredSnapshot.seq < maxEventSeq) {
      throw new Error(`snapshot sequence ${restoredSnapshot.seq} is behind event log sequence ${maxEventSeq} for ${id}`)
    }
    const runtimeConnection = await createRuntimeHub(config.runtimeAdapters).connect({
      simulationRunId: id,
      scenario: {
        scenarioId: scenarioRuntime.scenarioId,
        runtimeIds: scenarioRuntime.runtimes.map(runtime => runtime.runtimeId),
        world: scenarioRuntime.scenario.world,
        initialObjects: scenarioRuntime.initialObjects,
        processSystems: scenarioRuntime.scenario.processSystems,
        runtimeConfigs: scenarioRuntime.runtimeConfigs,
        runtimeConfig: {},
      },
      ...(restoredSnapshot ? { initialObjects: restoredSnapshot.objects } : {}),
      runtimeStateStores,
    })
    const runtime = await createSimulationRunRuntime({
      id,
      runtimeConnection,
      eventLog,
      snapshotStore,
      ...(config.interactionHandlers ? { interactionHandlers: config.interactionHandlers } : {}),
      ...(restoredSnapshot ? { restoredSnapshot } : {}),
      ...(restoredEvents.length === 0 ? {} : { restoredEvents }),
      ...(createConfig?.initialSeq === undefined && maxEventSeq === 0 ? {} : { initialSeq: Math.max(createConfig.initialSeq ?? 0, maxEventSeq) }),
      scenario: {
        id: scenarioRuntime.scenarioId,
        ...(scenarioRuntime.scenario.world.startsAt === undefined ? {} : { startsAt: scenarioRuntime.scenario.world.startsAt }),
        ...(scenarioRuntime.scenario.timeline === undefined ? {} : { timeline: scenarioRuntime.scenario.timeline }),
      },
      capabilities: capabilitiesFor(scenarioRuntime, scenarioRevisionIdFromManifest(createConfig.manifest)),
      procedureSourceService,
    })
    simulationRuns.set(id, runtime)
    scheduleIdleRuntimeCloseIfUnleased(id)
    return runtime
  }

  const create = async (createConfig?: { readonly scenarioId?: string; readonly scenarioRevisionId?: ScenarioRevisionId }): Promise<SimulationRunRuntime> => {
    const requestedScenarioId = createConfig?.scenarioId ?? config.scenarioCatalog.defaultScenarioId()
    const id = newSimulationRunId()
    if (simulationRuns.has(id) || creatingSimulationRuns.has(id)) throw new Error(`simulation run already exists: ${id}`)
    const manifest = await createManifest(id, requestedScenarioId, createConfig?.scenarioRevisionId)
    await manifestStoreFor(id).create(manifest)
    const creating = createRuntime({
      manifest,
    }).finally(() => {
      creatingSimulationRuns.delete(id)
    })
    creatingSimulationRuns.set(id, creating)
    return await creating
  }

  const load = async (id: SimulationRunId): Promise<SimulationRunRuntime> => {
    const existing = simulationRuns.get(id)
    if (existing) return existing
    const creating = creatingSimulationRuns.get(id)
    if (creating) return await creating
    const loading = (async (): Promise<SimulationRunRuntime> => {
      const manifest = await manifestStoreFor(id).load()
      if (!manifest) throw new Error(`Simulation Run not found: ${id}`)
      return await createRuntime({ manifest })
    })().finally(() => {
      creatingSimulationRuns.delete(id)
    })
    creatingSimulationRuns.set(id, loading)
    return await loading
  }

  const close = async (id: SimulationRunId): Promise<boolean> => {
    const runtime = simulationRuns.get(id)
    if (!runtime) return false
    clearIdleRuntimeCloseTimer(id)
    leasesBySimulationRun.delete(id)
    await runtime.close()
    simulationRuns.delete(id)
    return true
  }

  const reset = async (id: SimulationRunId): Promise<SimulationRunRuntime> => {
    const manifest = await manifestStoreFor(id).load()
    if (!manifest) throw new Error(`Simulation Run not found: ${id}`)
    const existing = simulationRuns.get(id)
    const resetEvent = existing
      ? await existing.publishResetBoundary({ scenarioId: manifest.scenario.id })
      : undefined
    await close(id)
    const runDir = join(simulationRunRoot, id)
    await Promise.all([
      rm(join(runDir, 'snapshot.json'), { force: true }),
      rm(join(runDir, 'events.jsonl'), { force: true }),
      rm(join(runDir, 'runtimes'), { recursive: true, force: true }),
    ])
    return createRuntime({
      manifest,
      ...(resetEvent === undefined ? {} : { initialSeq: resetEvent.seq + 1 }),
    })
  }

  const deleteSimulationRun = async (id: SimulationRunId): Promise<boolean> => {
    const wasLoaded = await close(id)
    const runDir = join(simulationRunRoot, id)
    let existedOnDisk = true
    try {
      await lstat(runDir)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
      existedOnDisk = false
    }
    if (existedOnDisk) await rm(runDir, { recursive: true, force: true })
    return wasLoaded || existedOnDisk
  }

  const listPersistedIds = async (): Promise<ReadonlyArray<SimulationRunId>> => {
    let entries: ReadonlyArray<{ readonly isDirectory: () => boolean; readonly name: string }>
    try {
      entries = await readdir(simulationRunRoot, { withFileTypes: true })
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw err
    }
    return entries
      .filter(entry => entry.isDirectory())
      .map(entry => simulationRunIdSchema.safeParse(entry.name))
      .filter((result): result is { readonly success: true; readonly data: SimulationRunId } => result.success)
      .map(result => result.data)
      .sort()
  }

  const summaryFor = async (id: SimulationRunId): Promise<SimulationRunSummary> => {
    const manifest = await manifestStoreFor(id).load()
    if (!manifest) {
      return {
        id,
        scenarioId: null,
        scenarioTitle: null,
        scenarioRevisionId: null,
        createdAt: null,
        loaded: false,
        snapshotSeq: null,
        objectCount: null,
        clock: null,
        loadError: 'Simulation Run Manifest is missing',
      }
    }
    const loaded = simulationRuns.get(id)
    await ensureScenarioLibrary()
    const revision = await scenarioLibrary.getRevision(scenarioRevisionIdFromManifest(manifest))
    const scenarioTitle = revision?.definition.title ?? null
    if (loaded) {
      const snapshot = loaded.snapshot()
      return {
        id,
        scenarioId: manifest.scenario.id,
        scenarioTitle,
        scenarioRevisionId: manifest.scenario.revisionId,
        createdAt: manifest.createdAt,
        loaded: true,
        snapshotSeq: snapshot.seq,
        objectCount: snapshot.objects.length,
        clock: snapshot.clock ?? null,
      }
    }
    const snapshotStore = createSimulationRunSnapshotStore({
      simulationRunId: id,
      path: join(simulationRunRoot, id, 'snapshot.json'),
    })
    let snapshot
    let loadError: string | undefined
    try {
      snapshot = await snapshotStore.load()
    } catch (err) {
      if (!isUnreadableSnapshotError(err)) throw err
      loadError = unreadableSnapshotMessage(err)
      snapshot = null
    }
    return {
      id,
      scenarioId: manifest.scenario.id,
      scenarioTitle,
      scenarioRevisionId: manifest.scenario.revisionId,
      createdAt: manifest.createdAt,
      loaded: false,
      snapshotSeq: snapshot?.seq ?? null,
      objectCount: snapshot?.objects.length ?? null,
      clock: snapshot?.clock ?? null,
      ...(loadError === undefined ? {} : { loadError }),
    }
  }

  const listKnown = async (): Promise<ReadonlyArray<SimulationRunSummary>> => {
    const ids = new Set<SimulationRunId>([...simulationRuns.keys(), ...await listPersistedIds()])
    const summaries: SimulationRunSummary[] = []
    for (const id of [...ids].sort()) summaries.push(await summaryFor(id))
    return summaries
  }

  const scenarioRevisionForRun = async (id: SimulationRunId): Promise<ScenarioRevision | undefined> => {
    await ensureScenarioLibrary()
    const manifest = await manifestStoreFor(id).load()
    if (!manifest) return undefined
    return await scenarioLibrary.getRevision(scenarioRevisionIdFromManifest(manifest))
  }

  const measureDirectory = async (path: string): Promise<SimulationRunRegistryStatus['storage']> => {
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
    await visit(workspaceRoot)
    return { totalBytes, fileCount, directoryCount }
  }

  const status = async (): Promise<SimulationRunRegistryStatus> => ({
    dataDir: workspaceRoot,
    storage: await measureDirectory(workspaceRoot),
    simulationRuns: await listKnown(),
    loadedRuntimeMetrics: [...simulationRuns.values()].map(runtime => runtime.metrics()),
    leases: leaseSummaries(),
  })

  return {
    workspaceId: config.workspaceId,
    create,
    load,
    reset,
    delete: deleteSimulationRun,
    get: (id: SimulationRunId) => simulationRuns.get(id),
    list: () => [...simulationRuns.values()],
    listKnown,
    status,
    acquireLease,
    leaseSummary,
    listScenarios: async () => {
      await ensureScenarioLibrary()
      return await scenarioLibrary.list()
    },
    currentScenario: async (id: string) => {
      await ensureScenarioLibrary()
      return await scenarioLibrary.currentRevision(id)
    },
    deleteScenario: async (id: string, revisionId: ScenarioRevisionId) => {
      await ensureScenarioLibrary()
      const current = await scenarioLibrary.currentRevision(id)
      if (!current || current.id !== revisionId) return false
      return await scenarioLibrary.delete(id)
    },
    scenarioRevisionForRun,
    defaultScenarioId: () => config.scenarioCatalog.defaultScenarioId(),
    close,
  }
}
