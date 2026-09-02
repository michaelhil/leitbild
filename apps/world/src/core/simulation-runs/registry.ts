import { lstat, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { z, ZodError } from 'zod'
import { semanticVersionSchema, type WorkspaceId } from '@leitbild/contracts'
import type { SimulationRunId } from '../model/index.ts'
import {
  simulationRunIdSchema,
  newSimulationRunId,
} from '../model/index.ts'
import type { PackRuntimeAdapter } from '../../simulation/protocol.ts'
import { createRuntimeHub } from '../../simulation/runtime-hub.ts'
import type { ScenarioCatalog } from '../scenarios/catalog.ts'
import type { ScenarioSource } from '../scenarios/config.ts'
import type { ScenarioDefinition } from '../model/index.ts'
import type { ScenarioAuthoringCatalog } from '../scenarios/authoring.ts'
import { createJsonlEventLog } from './event-log.ts'
import { createJsonRuntimeStateStore } from './runtime-state-store.ts'
import { createSimulationRunRuntime, type ActiveSimulationCapability, type SimulationRunRuntime } from './runtime.ts'
import type { SimulationRunCapabilities } from './runtime.ts'
import type { SimulationRunRuntimeMetricsSnapshot } from './runtime-metrics.ts'
import { defaultSimulationRunRuntimePolicy } from './runtime-persistence-policy.ts'
import { createSimulationRunSnapshotStore } from './snapshot-store.ts'
import type { SimulationClockState, SimulationRunEvent } from '../model/index.ts'
import { compiledScenarioDigest, createCompiledScenarioStore } from './compiled-scenario-store.ts'
import { worldWorkspacePaths } from '../workspaces/paths.ts'
import { createProcedureSourceService, type ProcedureSourceService } from '../../features/procedures/source.ts'
import { createLocalScenarioLibrary, type ScenarioLibrary, type ScenarioRecord, type ScenarioRevision, type ScenarioRevisionId } from '../scenarios/library.ts'
import {
  createSimulationRunManifestStore,
  scenarioRevisionIdFromManifest,
  simulationRunManifestSchema,
  type SimulationRunManifest,
} from './manifest.ts'
import { createRunHistorian } from '../../features/historian/store.ts'
import { worldCoreCapabilities } from '../../simulation/core-capabilities.ts'
import { capabilityJsonSchema } from '../../simulation/capabilities.ts'

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
  readonly activeCapabilityIds: ReadonlyArray<string>
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
  readonly scenarioAuthoringCatalog: ScenarioAuthoringCatalog
  readonly installedCapabilities: ReadonlyArray<ActiveSimulationCapability>
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
  readonly createScenario: (source: ScenarioSource) => Promise<ScenarioRevision>
  readonly previewScenario: (source: ScenarioSource) => Promise<ScenarioDefinition>
  readonly updateScenario: (source: ScenarioSource, expectedRevisionId: ScenarioRevisionId) => Promise<ScenarioRevision>
  readonly deleteScenario: (id: string, revisionId: ScenarioRevisionId) => Promise<boolean>
  readonly scenarioRevisionForRun: (id: SimulationRunId) => Promise<ScenarioRevision | undefined>
  readonly compileScenarioRevision: (revision: ScenarioRevision) => Promise<ScenarioDefinition>
  readonly defaultScenarioId: () => string
  readonly close: (id: SimulationRunId) => Promise<boolean>
}

export const createSimulationRunRegistry = (config: {
  readonly dataDir: string
  readonly workspaceId: WorkspaceId
  readonly runtimeAdapters: ReadonlyArray<PackRuntimeAdapter>
  readonly scenarioCatalog: ScenarioCatalog
  readonly scenarioSources: ReadonlyArray<ScenarioSource>
  readonly compileScenarioSource: (source: unknown) => Promise<ScenarioDefinition>
  readonly scenarioAuthoringCatalog: ScenarioAuthoringCatalog
  readonly scenarioLibrary?: ScenarioLibrary
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
  const compiledScenarios = new Map<ScenarioRevisionId, Promise<ScenarioDefinition>>()
  const installedCapabilities: ReadonlyArray<ActiveSimulationCapability> = [
    ...worldCoreCapabilities.map(capability => ({ packId: 'world', runtimeId: 'world.core', capability })),
    ...config.runtimeAdapters.flatMap(adapter =>
      adapter.capabilities.map(capability => ({ packId: adapter.packId, runtimeId: adapter.id, capability }))),
  ]

  const capabilityIdsForRuntimeIds = (runtimeIds: ReadonlyArray<string>): ReadonlyArray<string> => {
    const activeRuntimeIds = new Set(runtimeIds)
    return [...new Set(installedCapabilities
      .filter(entry => entry.runtimeId === 'world.core' || activeRuntimeIds.has(entry.runtimeId))
      .map(entry => entry.capability.id))].sort()
  }

  const ensureScenarioLibrary = (): Promise<void> => {
    scenarioLibraryReady ??= scenarioLibrary.seed(config.scenarioSources)
    return scenarioLibraryReady
  }

  const compileRevision = (revision: ScenarioRevision): Promise<ScenarioDefinition> => {
    const existing = compiledScenarios.get(revision.id)
    if (existing) return existing
    const compiling = config.compileScenarioSource(revision.document)
    compiledScenarios.set(revision.id, compiling)
    void compiling.catch(() => {
      if (compiledScenarios.get(revision.id) === compiling) compiledScenarios.delete(revision.id)
    })
    return compiling
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
        runtimes: [],
        capabilities: [],
        wikiRefs: [],
        recording: { selections: [], profiles: [] },
      }
    }
    const activeRuntimeIds = new Set(scenarioRuntime.runtimes.map(runtime => runtime.runtimeId))
    const activeAdapters = config.runtimeAdapters.filter(adapter => activeRuntimeIds.has(adapter.id))
    const capabilities = [
      ...worldCoreCapabilities.map(capability => ({
        id: capability.id,
        kind: capability.kind,
        title: capability.title,
        description: capability.description,
        risk: capability.risk,
        idempotent: capability.idempotent,
        ...(capability.schedulable === undefined ? {} : { schedulable: capability.schedulable }),
        inputSchema: capabilityJsonSchema(capability.input),
        outputSchema: capabilityJsonSchema(capability.output),
        packId: 'world',
        runtimeId: 'world.core',
      })),
      ...activeAdapters.flatMap(adapter => adapter.capabilities.map(capability => ({
        id: capability.id,
        kind: capability.kind,
        title: capability.title,
        description: capability.description,
        risk: capability.risk,
        idempotent: capability.idempotent,
        ...(capability.schedulable === undefined ? {} : { schedulable: capability.schedulable }),
        inputSchema: z.toJSONSchema(capability.input, { unrepresentable: 'any' }),
        outputSchema: z.toJSONSchema(capability.output, { unrepresentable: 'any' }),
        packId: adapter.packId,
        runtimeId: adapter.id,
      }))),
    ].sort((left, right) => left.id.localeCompare(right.id) || left.runtimeId.localeCompare(right.runtimeId))
    return {
      workspaceId: config.workspaceId,
      scenarioId: scenarioRuntime.scenarioId,
      scenarioRevisionId,
      activePackIds: [...scenarioRuntime.scenario.packs],
      runtimes: activeAdapters.map(adapter => ({
        id: adapter.id,
        packId: adapter.packId,
        clock: adapter.clock,
      })).sort((left, right) => left.id.localeCompare(right.id)),
      capabilities,
      wikiRefs: scenarioRuntime.packs.flatMap(pack => pack.knowledge?.wikiRefs ?? []),
      recording: {
        selections: scenarioRuntime.scenario.recording,
        profiles: scenarioRuntime.packs.flatMap(pack => {
          const runtimeId = scenarioRuntime.runtimes.find(runtime => runtime.packId === pack.descriptor.id)?.runtimeId
          if (runtimeId === undefined) return []
          return (pack.recording?.profiles ?? []).map(profile => ({
            ...profile,
            packId: pack.descriptor.id,
            runtimeId,
          }))
        }),
      },
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
    if (revision.definitionId !== manifest.scenario.id || revision.digest !== manifest.scenario.digest) {
      throw new Error(`Simulation Run Scenario Revision mismatch: ${manifest.id}`)
    }
    const compiledScenario = await createCompiledScenarioStore(join(simulationRunRoot, manifest.id, 'compiled-scenario.json')).load()
    if (compiledScenario.id !== revision.definitionId) {
      throw new Error(`Simulation Run Compiled Scenario mismatch for ${manifest.id}: expected ${revision.definitionId}, got ${compiledScenario.id}`)
    }
    if (compiledScenarioDigest(compiledScenario) !== manifest.scenario.compiledDigest) {
      throw new Error(`Simulation Run Compiled Scenario integrity mismatch: ${manifest.id}`)
    }
    const scenarioRuntime = config.scenarioCatalog.runtimeForDefinition(compiledScenario)
    const packVersions = new Map(scenarioRuntime.packs.map(pack => [pack.descriptor.id, pack.descriptor.version]))
    const installedAdapters = new Map(config.runtimeAdapters.map(adapter => [adapter.id, adapter]))
    const expectedPackIds = manifest.packs.map(pack => pack.id).sort()
    const resolvedPackIds = scenarioRuntime.packs.map(pack => pack.descriptor.id).sort()
    if (JSON.stringify(expectedPackIds) !== JSON.stringify(resolvedPackIds)) {
      throw new Error(`Simulation Run resolved Pack set mismatch: ${manifest.id}`)
    }
    const expectedRuntimeIds = manifest.runtimes.map(runtime => runtime.id).sort()
    const resolvedRuntimeIds = scenarioRuntime.runtimes.map(runtime => runtime.runtimeId).sort()
    if (JSON.stringify(expectedRuntimeIds) !== JSON.stringify(resolvedRuntimeIds)) {
      throw new Error(`Simulation Run resolved Pack Runtime set mismatch: ${manifest.id}`)
    }
    for (const pack of manifest.packs) {
      if (packVersions.get(pack.id) !== pack.version) {
        throw new Error(`Simulation Run Pack version mismatch for ${pack.id}: expected ${pack.version}, installed ${packVersions.get(pack.id) ?? 'missing'}`)
      }
    }
    for (const runtime of manifest.runtimes) {
      const installed = installedAdapters.get(runtime.id)
      if (installed?.version !== runtime.version) {
        throw new Error(`Simulation Run runtime version mismatch for ${runtime.id}: expected ${runtime.version}, installed ${installed?.version ?? 'missing'}`)
      }
      if (installed.packId !== runtime.packId || installed.clock !== runtime.clock) {
        throw new Error(`Simulation Run Pack Runtime contract mismatch for ${runtime.id}`)
      }
    }
    return { revision, scenarioRuntime }
  }

  const createManifest = async (id: SimulationRunId, scenarioId: string, scenarioRevisionId?: ScenarioRevisionId): Promise<{
    readonly manifest: SimulationRunManifest
    readonly compiledScenario: ScenarioDefinition
  }> => {
    await ensureScenarioLibrary()
    const revision = scenarioRevisionId === undefined
      ? await scenarioLibrary.currentRevision(scenarioId)
      : await scenarioLibrary.getRevision(scenarioRevisionId)
    if (!revision) throw new Error(`unknown Scenario: ${scenarioId}`)
    if (revision.definitionId !== scenarioId) throw new Error(`Scenario Revision does not belong to Scenario: ${scenarioId}`)
    const compiledScenario = await compileRevision(revision)
    const scenarioRuntime = config.scenarioCatalog.runtimeForDefinition(compiledScenario)
    const adaptersById = new Map(config.runtimeAdapters.map(adapter => [adapter.id, adapter]))
    const manifest = simulationRunManifestSchema.parse({
      schemaVersion: 1,
      id,
      workspaceId: config.workspaceId,
      scenario: {
        id: revision.definitionId,
        revisionId: revision.id,
        digest: revision.digest,
        compiledDigest: compiledScenarioDigest(compiledScenario),
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
          clock: adapter.clock,
        }
      }),
      createdAt: new Date().toISOString(),
    })
    return { manifest, compiledScenario }
  }

  const createRuntime = async (createConfig: {
    readonly manifest: SimulationRunManifest
    readonly initialSeq?: number
  }): Promise<SimulationRunRuntime> => {
    await ensureScenarioLibrary()
    const { scenarioRuntime } = await resolveManifest(createConfig.manifest)
    const interactionHandlers = scenarioRuntime.packs.flatMap(pack => pack.interactions?.handlers ?? [])
    const interactionHandlerIds = new Set<string>()
    for (const handler of interactionHandlers) {
      if (interactionHandlerIds.has(handler.id)) throw new Error(`duplicate active interaction handler id: ${handler.id}`)
      interactionHandlerIds.add(handler.id)
    }
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
    const recordingByRuntimeId = Object.fromEntries(scenarioRuntime.scenario.recording.map(selection => {
      const runtime = scenarioRuntime.runtimes.find(candidate => candidate.packId === selection.packId)
      if (!runtime) throw new Error(`recording selection has no active Pack Runtime: ${selection.packId}`)
      return [runtime.runtimeId, selection]
    }))
    const historian = scenarioRuntime.scenario.recording.length === 0
      ? undefined
      : createRunHistorian(join(runDir, 'history.sqlite'))
    let runtimeConnection
    try {
      runtimeConnection = await createRuntimeHub(config.runtimeAdapters).connect({
        simulationRunId: id,
        scenario: {
          scenarioId: scenarioRuntime.scenarioId,
          runtimeIds: scenarioRuntime.runtimes.map(runtime => runtime.runtimeId),
          world: scenarioRuntime.scenario.world,
          initialObjects: scenarioRuntime.initialObjects,
          connections: scenarioRuntime.scenario.connections,
          runtimeConfigByRuntimeId: scenarioRuntime.runtimeConfigByRuntimeId,
          runtimeConfig: {},
        },
        ...(restoredSnapshot ? { initialObjects: restoredSnapshot.objects } : {}),
        runtimeStateStores,
        recordingByRuntimeId,
      })
    } catch (error) {
      historian?.close()
      throw error
    }
    let runtime
    try {
      runtime = await createSimulationRunRuntime({
        id,
        runtimeConnection,
        eventLog,
        snapshotStore,
        ...(interactionHandlers.length === 0 ? {} : { interactionHandlers }),
        ...(restoredSnapshot ? { restoredSnapshot } : {}),
        ...(restoredEvents.length === 0 ? {} : { restoredEvents }),
        ...(createConfig?.initialSeq === undefined && maxEventSeq === 0 ? {} : { initialSeq: Math.max(createConfig.initialSeq ?? 0, maxEventSeq) }),
        scenario: {
          id: scenarioRuntime.scenarioId,
          startsAt: scenarioRuntime.scenario.world.startsAt,
          ...(scenarioRuntime.scenario.timeline === undefined ? {} : { timeline: scenarioRuntime.scenario.timeline }),
        },
        capabilities: capabilitiesFor(scenarioRuntime, scenarioRevisionIdFromManifest(createConfig.manifest)),
        runtimeCapabilities: installedCapabilities.filter(entry =>
          entry.runtimeId === 'world.core'
          || scenarioRuntime.runtimes.some(runtime => runtime.runtimeId === entry.runtimeId)),
        procedureSourceService,
        ...(historian === undefined ? {} : { historian }),
      })
    } catch (error) {
      await runtimeConnection.close()
      historian?.close()
      throw error
    }
    simulationRuns.set(id, runtime)
    scheduleIdleRuntimeCloseIfUnleased(id)
    return runtime
  }

  const create = async (createConfig?: { readonly scenarioId?: string; readonly scenarioRevisionId?: ScenarioRevisionId }): Promise<SimulationRunRuntime> => {
    const requestedScenarioId = createConfig?.scenarioId ?? config.scenarioCatalog.defaultScenarioId()
    const id = newSimulationRunId()
    if (simulationRuns.has(id) || creatingSimulationRuns.has(id)) throw new Error(`simulation run already exists: ${id}`)
    const { manifest, compiledScenario } = await createManifest(id, requestedScenarioId, createConfig?.scenarioRevisionId)
    await manifestStoreFor(id).create(manifest)
    await createCompiledScenarioStore(join(simulationRunRoot, id, 'compiled-scenario.json')).create(compiledScenario)
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
      rm(join(runDir, 'history.sqlite'), { force: true }),
      rm(join(runDir, 'history.sqlite-wal'), { force: true }),
      rm(join(runDir, 'history.sqlite-shm'), { force: true }),
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
        activeCapabilityIds: [],
        loadError: 'Simulation Run Manifest is missing',
      }
    }
    const loaded = simulationRuns.get(id)
    await ensureScenarioLibrary()
    const revision = await scenarioLibrary.getRevision(scenarioRevisionIdFromManifest(manifest))
    const scenarioTitle = revision?.document.title ?? null
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
        activeCapabilityIds: capabilityIdsForRuntimeIds(manifest.runtimes.map(runtime => runtime.id)),
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
      activeCapabilityIds: capabilityIdsForRuntimeIds(manifest.runtimes.map(runtime => runtime.id)),
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
    scenarioAuthoringCatalog: config.scenarioAuthoringCatalog,
    installedCapabilities,
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
    createScenario: async source => {
      await ensureScenarioLibrary()
      await config.compileScenarioSource(source)
      return await scenarioLibrary.create(source)
    },
    previewScenario: async source => await config.compileScenarioSource(source),
    updateScenario: async (source, expectedRevisionId) => {
      await ensureScenarioLibrary()
      await config.compileScenarioSource(source)
      return await scenarioLibrary.update(source, expectedRevisionId)
    },
    deleteScenario: async (id: string, revisionId: ScenarioRevisionId) => {
      await ensureScenarioLibrary()
      const current = await scenarioLibrary.currentRevision(id)
      if (!current || current.id !== revisionId) return false
      return await scenarioLibrary.delete(id, revisionId)
    },
    scenarioRevisionForRun,
    compileScenarioRevision: compileRevision,
    defaultScenarioId: () => config.scenarioCatalog.defaultScenarioId(),
    close,
  }
}
