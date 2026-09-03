import { semanticVersionSchema,type WorkspaceId } from '@leitbild/contracts'
import { createOperationScope, createStorageBudget, type StorageBudget } from '@leitbild/module-runtime'
import { createCaptureAdmission } from '../../features/historian/capture-admission.ts'
import { lstat,readdir,rm } from 'node:fs/promises'
import { join } from 'node:path'
import { z,ZodError } from 'zod'
import { openRunHistorian } from '../../features/historian/store.ts'
import { createProcedureSourceService,type ProcedureSourceService } from '../../features/procedures/source.ts'
import { capabilityJsonSchema } from '../../simulation/capabilities.ts'
import { worldCoreCapabilities } from '../../simulation/core-capabilities.ts'
import type { PackRuntimeAdapter, PackWorkspaceCapability } from '../../simulation/protocol.ts'
import { createRuntimeHub } from '../../simulation/runtime-hub.ts'
import type { CompiledScenario,SimulationClockState,SimulationRunEvent,SimulationRunId } from '../model/index.ts'
import {
  newSimulationRunId,
  simulationRunIdSchema,
} from '../model/index.ts'
import { createSimulationClock,nowIso } from '../model/time.ts'
import { scenarioPreviewFor,type ScenarioPreview } from '../scenarios/authoring-preview.ts'
import type { ScenarioAuthoringCatalog } from '../scenarios/authoring.ts'
import type { ScenarioDefinition } from '../scenarios/definition.ts'
import { createLocalScenarioLibrary,type ScenarioLibrary,type ScenarioRecord,type ScenarioRevision,type ScenarioRevisionId } from '../scenarios/library.ts'
import type { ScenarioRuntimeResolver } from '../scenarios/runtime-resolver.ts'
import { worldWorkspacePaths } from '../workspaces/paths.ts'
import { compiledScenarioDigest,createCompiledScenarioStore } from './compiled-scenario-store.ts'
import { readRunDisplayName,runDisplayNameSchema,writeRunDisplayName } from './display-name.ts'
import { createJsonlEventLog } from './event-log.ts'
import {
  createSimulationRunManifestStore,
  scenarioRevisionIdFromManifest,
  simulationRunManifestSchema,
  type SimulationRunManifest,
} from './manifest.ts'
import type { SimulationRunRuntimeMetricsSnapshot } from './runtime-metrics.ts'
import { defaultSimulationRunRuntimePolicy } from './runtime-persistence-policy.ts'
import { createJsonRuntimeStateStore } from './runtime-state-store.ts'
import { createAccelerationStore } from './acceleration-store.ts'
import { accelerationCheckpointWallIntervalMs, accelerationDurationInputSchema, accelerationJobStateSchema, type AccelerationJobState,type AcceleratedCopyOrigin } from './acceleration.ts'
import type { SimulationRunCapabilities } from './runtime.ts'
import { createSimulationRunRuntime,type ActiveSimulationCapability,type SimulationRunRuntime } from './runtime.ts'
import { createSimulationRunSnapshotStore } from './snapshot-store.ts'
import { createSimulationRunStateStore } from './state-store.ts'
import { createKeyedOperations } from '../storage/keyed-operations.ts'

const maxRestoredEventHistoryBytes = 8 * 1024 * 1024

export type SimulationRunLeaseKind = 'realtime' | 'api' | 'background' | 'acceleration'

export interface SimulationRunLeaseSummary {
  readonly simulationRunId: SimulationRunId
  readonly leaseCount: number
  readonly leasesByKind: Readonly<Record<SimulationRunLeaseKind, number>>
}

export interface SimulationRunSummary {
  readonly id: SimulationRunId
  readonly name: string | null
  readonly title: string
  readonly scenarioId: string | null
  readonly scenarioTitle: string | null
  readonly scenarioRevisionId: string | null
  readonly createdAt: string | null
  readonly loaded: boolean
  readonly snapshotSeq: number | null
  readonly objectCount: number | null
  readonly clock: SimulationClockState | null
  readonly activeCapabilityIds: ReadonlyArray<string>
  readonly origin: AcceleratedCopyOrigin | null
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
  readonly workspaceCapabilities: ReadonlyArray<PackWorkspaceCapability>
  readonly create: (config: { readonly scenarioId: string; readonly scenarioRevisionId?: ScenarioRevisionId }) => Promise<SimulationRunRuntime>
  readonly createAcceleratedCopy: (sourceId: SimulationRunId, input: { readonly minutes: number; readonly name?: string }) => Promise<{ readonly runtime: SimulationRunRuntime; readonly acceleration: AccelerationJobState }>
  readonly startAcceleration: (id: SimulationRunId, input: { readonly minutes: number }) => Promise<AccelerationJobState>
  readonly pauseAcceleration: (id: SimulationRunId) => Promise<AccelerationJobState>
  readonly accelerationStatus: (id: SimulationRunId) => Promise<AccelerationJobState | null>
  readonly load: (id: SimulationRunId) => Promise<SimulationRunRuntime>
  readonly reset: (id: SimulationRunId) => Promise<SimulationRunRuntime>
  readonly delete: (id: SimulationRunId) => Promise<boolean>
  readonly rename: (id: SimulationRunId, name: string | null, expectedTitle: string) => Promise<SimulationRunSummary>
  readonly get: (id: SimulationRunId) => SimulationRunRuntime | undefined
  readonly list: () => ReadonlyArray<SimulationRunRuntime>
  readonly listKnown: () => Promise<ReadonlyArray<SimulationRunSummary>>
  readonly summary: (id: SimulationRunId) => Promise<SimulationRunSummary>
  readonly status: () => Promise<SimulationRunRegistryStatus>
  readonly acquireLease: (id: SimulationRunId, kind: SimulationRunLeaseKind) => () => void
  readonly setBackgroundExecution: (id: SimulationRunId, enabled: boolean) => Promise<SimulationRunLeaseSummary>
  readonly leaseSummary: (id: SimulationRunId) => SimulationRunLeaseSummary
  readonly listScenarios: () => Promise<ReadonlyArray<ScenarioRecord>>
  readonly currentScenario: (id: string) => Promise<ScenarioRevision | undefined>
  readonly createScenario: (source: ScenarioDefinition) => Promise<ScenarioRevision>
  readonly previewScenario: (source: ScenarioDefinition) => Promise<ScenarioPreview>
  readonly updateScenario: (source: ScenarioDefinition, expectedRevisionId: ScenarioRevisionId) => Promise<ScenarioRevision>
  readonly deleteScenario: (id: string, revisionId: ScenarioRevisionId) => Promise<boolean>
  readonly scenarioRevisionForRun: (id: SimulationRunId) => Promise<ScenarioRevision | undefined>
  readonly compileScenarioRevision: (revision: ScenarioRevision) => Promise<CompiledScenario>
  readonly compiledScenarioForRun: (id: SimulationRunId) => Promise<CompiledScenario>
  readonly shutdown: () => Promise<void>
  readonly close: (id: SimulationRunId) => Promise<boolean>
  readonly isIdle: () => boolean
}

export const createSimulationRunRegistry = (config: {
  readonly dataDir: string
  readonly workspaceId: WorkspaceId
  readonly runtimeAdapters: ReadonlyArray<PackRuntimeAdapter>
  readonly scenarioRuntimeResolver: ScenarioRuntimeResolver
  readonly scenarioDefinitions: ReadonlyArray<ScenarioDefinition>
  readonly compileScenarioDefinition: (source: unknown) => Promise<CompiledScenario>
  readonly scenarioAuthoringCatalog: ScenarioAuthoringCatalog
  readonly scenarioLibrary?: ScenarioLibrary
  readonly storageBudget?: StorageBudget
  readonly idleRuntimeCloseDelayMs?: number
  readonly procedureSourceService?: ProcedureSourceService
  readonly acquireAccelerationAdmission?: (runId: string) => () => void
}): SimulationRunRegistry => {
  const simulationRuns = new Map<SimulationRunId, SimulationRunRuntime>()
  const lifecycle = createKeyedOperations<SimulationRunId>()
  let shuttingDown = false
  const definitionOperations = createOperationScope('World scenario library')
  const procedureSourceService = config.procedureSourceService ?? createProcedureSourceService()
  const creatingSimulationRuns = new Map<SimulationRunId, Promise<SimulationRunRuntime>>()
  const leasesBySimulationRun = new Map<SimulationRunId, Map<string, SimulationRunLeaseKind>>()
  const backgroundReleases = new Map<SimulationRunId, () => void>()
  const accelerationJobs = new Map<SimulationRunId, { pauseRequested: boolean; done?: Promise<void> }>()
  const accelerationStates = new Map<SimulationRunId, AccelerationJobState>()
  const idleRuntimeCloseTimers = new Map<SimulationRunId, ReturnType<typeof setTimeout>>()
  const idleRuntimeCloseDelayMs = config.idleRuntimeCloseDelayMs ?? defaultSimulationRunRuntimePolicy.idleRuntimeCloseDelayMs
  let nextLeaseNumber = 0
  const workspacePaths = worldWorkspacePaths(config.dataDir, config.workspaceId)
  const workspaceRoot = workspacePaths.root
  const storageBudget = config.storageBudget ?? createStorageBudget({ root: config.dataDir })
  const simulationRunRoot = workspacePaths.simulationRuns
  const scenarioLibrary = config.scenarioLibrary ?? createLocalScenarioLibrary({
    workspaceId: config.workspaceId,
    rootDir: workspacePaths.scenarios,
  })
  let scenarioLibraryReady: Promise<void> | null = null
  const compiledScenarios = new Map<ScenarioRevisionId, Promise<CompiledScenario>>()
  const pinnedTitles = new Map<string, string>()
  const installedCapabilities: ReadonlyArray<ActiveSimulationCapability> = [
    ...worldCoreCapabilities.map(capability => ({ packId: 'world', runtimeId: 'world.core', capability })),
    ...config.runtimeAdapters.flatMap(adapter =>
      adapter.capabilities.map(capability => ({ packId: adapter.packId, runtimeId: adapter.id, capability }))),
  ]

  const compileValidatedDefinition = async (source: unknown): Promise<CompiledScenario> => {
    let compiled: CompiledScenario
    try { compiled = await config.compileScenarioDefinition(source) }
    catch (error) {
      if (error instanceof z.ZodError) throw error
      throw new z.ZodError([{ code: 'custom', path: [], message: error instanceof Error ? error.message : String(error) }])
    }
    const resolved = config.scenarioRuntimeResolver.resolve(compiled)
    const runtimeIds = new Set(resolved.runtimes.map(runtime => runtime.runtimeId))
    const available = new Map(installedCapabilities.filter(entry => entry.runtimeId === 'world.core' || runtimeIds.has(entry.runtimeId)).map(entry => [entry.capability.id, entry.capability]))
    for (const runtime of resolved.runtimes) {
      const adapter = config.runtimeAdapters.find(adapter => adapter.id === runtime.runtimeId)!
      for (const queryId of adapter.requiredQueries?.(resolved.runtimeConfigByRuntimeId[runtime.runtimeId]) ?? []) {
        if (available.get(queryId)?.kind !== 'query') throw new z.ZodError([{ code: 'custom', path: ['packs', runtime.packId, 'config'], message: `${runtime.packId} requires an active query provider: ${queryId}` }])
      }
    }
    for (const [index, cue] of (compiled.timeline?.cues ?? []).entries()) {
      for (const [actionIndex, action] of cue.actions.entries()) {
        if (action.type !== 'invoke_capability') continue
        const capability = available.get(action.capabilityId)
        const path = ['timeline', 'cues', index, 'actions', actionIndex]
        if (!capability || capability.kind !== 'command' || capability.schedulable !== true) {
          throw new z.ZodError([{ code: 'custom', path, message: `Capability ${action.capabilityId} is not an active schedulable command` }])
        }
        const input = capability.input.safeParse(action.input)
        if (!input.success) throw new z.ZodError(input.error.issues.map(issue => ({ ...issue, path: [...path, 'input', ...issue.path] })))
      }
    }
    return compiled
  }

  const capabilityIdsForRuntimeIds = (runtimeIds: ReadonlyArray<string>): ReadonlyArray<string> => {
    const activeRuntimeIds = new Set(runtimeIds)
    return [...new Set(installedCapabilities
      .filter(entry => entry.runtimeId === 'world.core' || activeRuntimeIds.has(entry.runtimeId))
      .map(entry => entry.capability.id))].sort()
  }

  const ensureScenarioLibrary = (): Promise<void> => {
    scenarioLibraryReady ??= scenarioLibrary.seed(config.scenarioDefinitions)
    return scenarioLibraryReady
  }

  const compileRevision = (revision: ScenarioRevision): Promise<CompiledScenario> => {
    const existing = compiledScenarios.get(revision.id)
    if (existing) return existing
    const compiling = compileValidatedDefinition(revision.document)
    compiledScenarios.set(revision.id, compiling)
    // Revisions are immutable; keep only a small working set, not every edit forever.
    if (compiledScenarios.size > 32) compiledScenarios.delete(compiledScenarios.keys().next().value!)
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
      acceleration: 0,
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
          await lifecycle.run(id, async () => {
            if (leaseCountFor(id) === 0) await closeLoaded(id)
          })
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
    if (shuttingDown) throw new Error('Simulation Run registry is shutting down')
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
    scenarioRuntime: ReturnType<ScenarioRuntimeResolver['resolve']>,
    scenarioRevisionId: ScenarioRevision['id'],
  ): Omit<SimulationRunCapabilities, 'simulationRunId'> => {
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

  const unreadableSnapshotMessage = (err: unknown): string => {
    const message = err instanceof Error ? err.message : 'snapshot could not be read'
    return message.length <= 2_000 ? message : `${message.slice(0, 1_997)}...`
  }

  const manifestStoreFor = (id: SimulationRunId) =>
    createSimulationRunManifestStore(join(simulationRunRoot, id, 'manifest.json'))

  const accelerationStoreFor = (id: SimulationRunId) =>
    createAccelerationStore(join(simulationRunRoot, id, 'acceleration.json'))

  const resolveManifest = async (manifest: SimulationRunManifest): Promise<{
    readonly revision: ScenarioRevision
    readonly scenarioRuntime: NonNullable<ReturnType<ScenarioRuntimeResolver['resolve']>>
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
    const scenarioRuntime = config.scenarioRuntimeResolver.resolve(compiledScenario)
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
    readonly compiledScenario: CompiledScenario
  }> => {
    await ensureScenarioLibrary()
    const revision = scenarioRevisionId === undefined
      ? await scenarioLibrary.currentRevision(scenarioId)
      : await scenarioLibrary.getRevision(scenarioRevisionId)
    if (!revision) throw new Error(`unknown Scenario: ${scenarioId}`)
    if (revision.definitionId !== scenarioId) throw new Error(`Scenario Revision does not belong to Scenario: ${scenarioId}`)
    const compiledScenario = await compileRevision(revision)
    const scenarioRuntime = config.scenarioRuntimeResolver.resolve(compiledScenario)
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
    const runtimeStateStores = Object.fromEntries(scenarioRuntime.runtimes.map(runtime => [
      runtime.runtimeId,
      createJsonRuntimeStateStore({
        runtimeId: runtime.runtimeId,
        path: join(runDir, 'runtimes', `${runtime.runtimeId}.json`),
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
      : openRunHistorian(join(runDir, 'history.sqlite'), { captureAdmission: await createCaptureAdmission(storageBudget, workspaceRoot) })
    let runtimeConnection
    const runClock = createSimulationClock({
      currentTime: restoredSnapshot?.clock?.currentTime ?? scenarioRuntime.scenario.world.startsAt,
      updatedAt: nowIso(), paused: true, speed: restoredSnapshot?.clock?.speed ?? 1,
    })
    // The compiled artifact is deterministic authored startup, not an actual
    // observation. Stamp fresh shared objects when their Run is instantiated.
    const observedAt = nowIso()
    const initialObjects = scenarioRuntime.initialObjects.map(object => ({
      ...object,
      timestamps: { createdAt: observedAt, updatedAt: observedAt },
      spatial: { ...object.spatial, ...(object.spatial.position ? { position: { ...object.spatial.position, observedAt } } : {}) },
    }))
    // Runtime readers share the actual Run projection, not the Hub's delayed
    // observation mirror. A deletion is visible even while its journal flush
    // is awaiting I/O, so late route preparation cannot resurrect that object.
    const stateStore = createSimulationRunStateStore()
    stateStore.hydrate(restoredSnapshot ?? { objects: initialObjects, seq: createConfig.initialSeq ?? 0 })
    try {
      runtimeConnection = await createRuntimeHub(config.runtimeAdapters.filter(adapter => scenarioRuntime.runtimes.some(runtime => runtime.runtimeId === adapter.id))).connect({
        simulationRunId: id,
        workspace: { id: config.workspaceId, dataDir: workspaceRoot, storageBudget },
        runClock,
        objectById: stateStore.getObject,
        scenario: {
          scenarioId: scenarioRuntime.scenarioId,
          runtimeIds: scenarioRuntime.runtimes.map(runtime => runtime.runtimeId),
          world: scenarioRuntime.scenario.world,
          initialObjects,
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
        stateStore,
        runClock,
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
        runtimeStateLoaders: Object.fromEntries(Object.entries(runtimeStateStores).map(([runtimeId, store]) => [runtimeId, store.load])),
        ...(historian === undefined ? {} : { historian }),
      })
    } catch (error) {
      await runtimeConnection.close()
      historian?.close()
      throw error
    }
    simulationRuns.set(id, runtime)
    const priorAcceleration = await accelerationStoreFor(id).load()
    if (priorAcceleration) accelerationStates.set(id, priorAcceleration)
    if (priorAcceleration?.status === 'failed') runtime.failStop(priorAcceleration.error ?? 'accelerated execution failed')
    scheduleIdleRuntimeCloseIfUnleased(id)
    return runtime
  }

  const create = async (createConfig: { readonly scenarioId: string; readonly scenarioRevisionId?: ScenarioRevisionId }): Promise<SimulationRunRuntime> => {
    if (shuttingDown) throw new Error('Workspace runtime is closing')
    const requestedScenarioId = z.string().min(1).parse(createConfig.scenarioId)
    const id = newSimulationRunId()
    if (simulationRuns.has(id) || creatingSimulationRuns.has(id)) throw new Error(`simulation run already exists: ${id}`)
    // Conservative admission reservation for initial graphs/checkpoints; ongoing
    // observation growth is checked separately and never blocks control commands.
    const creating = storageBudget.withGrowth(workspaceRoot, 16 * 1024 * 1024, async () => {
      const { manifest, compiledScenario } = await createManifest(id, requestedScenarioId, createConfig?.scenarioRevisionId)
      await manifestStoreFor(id).create(manifest)
      await createCompiledScenarioStore(join(simulationRunRoot, id, 'compiled-scenario.json')).create(compiledScenario)
      return await createRuntime({ manifest })
    }).finally(() => {
      creatingSimulationRuns.delete(id)
      scheduleIdleRuntimeCloseIfUnleased(id)
    })
    creatingSimulationRuns.set(id, creating)
    return await creating
  }

  const accelerationStatus = async (id: SimulationRunId): Promise<AccelerationJobState | null> => {
    const cached = accelerationStates.get(id)
    if (cached) return cached
    const loaded = await accelerationStoreFor(id).load()
    if (loaded) accelerationStates.set(id, loaded)
    return loaded
  }

  const startAcceleration = async (id: SimulationRunId, rawInput: { readonly minutes: number }, reservedAdmission?: () => void): Promise<AccelerationJobState> => {
    const input = accelerationDurationInputSchema.omit({ name: true }).parse(rawInput)
    if (accelerationJobs.has(id)) throw Object.assign(new Error('Accelerated execution is already active for this Run'), { code: 'simulation_run_busy' })
    const runtime = await load(id)
    const currentClock = runtime.snapshot().clock
    if (!currentClock) throw new Error('Simulation Run clock is not initialized')
    if (!currentClock.paused) throw new Error('Pause the Simulation Run before starting accelerated execution')
    const manifest = await manifestStoreFor(id).load()
    if (!manifest) throw new Error(`Simulation Run not found: ${id}`)
    const liveRuntimes = manifest.runtimes.filter(candidate => candidate.clock === 'live')
    if (liveRuntimes.length > 0) throw Object.assign(new Error(`Accelerated execution cannot synthesize future live observations: ${liveRuntimes.map(candidate => candidate.id).join(', ')}`), { code: 'acceleration_unsupported' })
    const releaseAdmission = reservedAdmission ?? config.acquireAccelerationAdmission?.(id) ?? (() => {})
    const releaseLease = acquireLease(id, 'acceleration')
    const controller: { pauseRequested: boolean; done?: Promise<void> } = { pauseRequested: false }
    accelerationJobs.set(id, controller)
    const startedAt = nowIso()
    const startedMs = Date.parse(currentClock.currentTime)
    const target = new Date(startedMs + input.minutes * 60_000).toISOString()
    let state = accelerationJobStateSchema.parse({
      status: 'running', startedSimulationTime: currentClock.currentTime,
      targetSimulationTime: target, currentSimulationTime: currentClock.currentTime,
      startedAt, updatedAt: startedAt, activeWallMs: 0, simulatedMs: 0, measuredSpeed: 0,
    })
    accelerationStates.set(id, state)
    try { await accelerationStoreFor(id).save(state) }
    catch (error) {
      accelerationJobs.delete(id)
      accelerationStates.delete(id)
      releaseLease()
      releaseAdmission()
      throw error
    }
    const wallStart = performance.now()
    let lastPersistedAt = wallStart
    const work = runtime.advancePausedTo(state.targetSimulationTime, {
      shouldPause: () => controller.pauseRequested,
      onProgress: async currentSimulationTime => {
        const wallNow = performance.now()
        const activeWallMs = wallNow - wallStart
        const simulatedMs = Date.parse(currentSimulationTime) - startedMs
        state = accelerationJobStateSchema.parse({ ...state, currentSimulationTime, updatedAt: nowIso(), activeWallMs, simulatedMs, measuredSpeed: activeWallMs > 0 ? simulatedMs / activeWallMs : 0 })
        accelerationStates.set(id, state)
        if (wallNow - lastPersistedAt >= accelerationCheckpointWallIntervalMs) { lastPersistedAt = wallNow; await accelerationStoreFor(id).save(state) }
      },
    }).then(async result => {
      state = accelerationJobStateSchema.parse({ ...state, status: result.pausedEarly ? 'paused' : 'completed', currentSimulationTime: result.currentSimulationTime, updatedAt: nowIso() })
      accelerationStates.set(id, state)
      await accelerationStoreFor(id).save(state)
    }).catch(async error => {
      const reason = error instanceof Error ? error.message : String(error)
      runtime.failStop(reason)
      state = accelerationJobStateSchema.parse({ ...state, status: 'failed', currentSimulationTime: runtime.snapshot().clock?.currentTime ?? state.currentSimulationTime, updatedAt: nowIso(), error: reason })
      accelerationStates.set(id, state)
      await accelerationStoreFor(id).save(state).catch(() => undefined)
    }).finally(() => {
      accelerationJobs.delete(id)
      releaseLease()
      releaseAdmission()
    })
    controller.done = work
    void work
    return state
  }

  const createAcceleratedCopy = async (sourceId: SimulationRunId, rawInput: { readonly minutes: number; readonly name?: string }) => {
    const input = accelerationDurationInputSchema.parse(rawInput)
    const releaseAdmission = config.acquireAccelerationAdmission?.(`copy-of-${sourceId}`) ?? (() => {})
    let admissionTransferred = false
    try {
      const sourceManifest = await manifestStoreFor(sourceId).load()
      if (!sourceManifest) throw new Error(`Simulation Run not found: ${sourceId}`)
      const liveRuntimes = sourceManifest.runtimes.filter(candidate => candidate.clock === 'live')
      if (liveRuntimes.length > 0) throw Object.assign(new Error(`Accelerated copies require simulated evidence; active live runtimes: ${liveRuntimes.map(candidate => candidate.id).join(', ')}`), { code: 'acceleration_unsupported' })
      const source = await load(sourceId)
      const checkpoint = await source.checkpointForFork()
      const id = newSimulationRunId()
      const forkedAt = nowIso()
      const manifest = simulationRunManifestSchema.parse({ ...sourceManifest, id, createdAt: forkedAt, origin: { kind: 'accelerated-copy', sourceRunId: sourceId, sourceSequence: checkpoint.snapshot.seq, forkedAt } })
      const compiledScenario = await createCompiledScenarioStore(join(simulationRunRoot, sourceId, 'compiled-scenario.json')).load()
      await storageBudget.withGrowth(workspaceRoot, 32 * 1024 * 1024, async () => {
        await manifestStoreFor(id).create(manifest)
        await createCompiledScenarioStore(join(simulationRunRoot, id, 'compiled-scenario.json')).create(compiledScenario)
        await createSimulationRunSnapshotStore({ simulationRunId: id, path: join(simulationRunRoot, id, 'snapshot.json') }).save({
          ...checkpoint.snapshot,
          seq: 0,
          ...(checkpoint.snapshot.clock ? { clock: { ...checkpoint.snapshot.clock, paused: true, speed: 1 } } : {}),
        })
        for (const [runtimeId, runtimeState] of Object.entries(checkpoint.runtimeStates)) {
          await createJsonRuntimeStateStore({ runtimeId, path: join(simulationRunRoot, id, 'runtimes', `${runtimeId}.json`) }).save(runtimeState)
        }
        const sourceTitle = (await summaryFor(sourceId)).title
        await writeRunDisplayName(join(simulationRunRoot, id, 'display-name.json'), input.name ?? `${sourceTitle} — accelerated copy`)
      })
      const runtime = await createRuntime({ manifest })
      const acceleration = await startAcceleration(id, { minutes: input.minutes }, releaseAdmission)
      admissionTransferred = true
      return { runtime, acceleration }
    } finally {
      if (!admissionTransferred) releaseAdmission()
    }
  }

  const pauseAcceleration = async (id: SimulationRunId): Promise<AccelerationJobState> => {
    const controller = accelerationJobs.get(id)
    if (!controller) {
      const state = await accelerationStatus(id)
      if (!state) throw new Error(`Simulation Run has no accelerated execution: ${id}`)
      return state
    }
    controller.pauseRequested = true
    return accelerationStates.get(id)!
  }

  const load = (id: SimulationRunId): Promise<SimulationRunRuntime> => lifecycle.run(id, async () => {
    if (shuttingDown) throw new Error('Workspace runtime is closing')
    const existing = simulationRuns.get(id)
    if (existing) {
      scheduleIdleRuntimeCloseIfUnleased(id)
      return existing
    }
    const creating = creatingSimulationRuns.get(id)
    if (creating) return await creating
    const loading = (async (): Promise<SimulationRunRuntime> => {
      const manifest = await manifestStoreFor(id).load()
      if (!manifest) throw new Error(`Simulation Run not found: ${id}`)
      return await createRuntime({ manifest })
    })().finally(() => {
      creatingSimulationRuns.delete(id)
      scheduleIdleRuntimeCloseIfUnleased(id)
    })
    creatingSimulationRuns.set(id, loading)
    return await loading
  })

  const closeLoaded = async (id: SimulationRunId): Promise<boolean> => {
    // A failed construction has already released its resources; close still succeeds as a no-op.
    await creatingSimulationRuns.get(id)?.catch(() => undefined)
    const runtime = simulationRuns.get(id)
    if (!runtime) return false
    const leases = leaseSummary(id).leasesByKind
    if (!shuttingDown && leases.api > 0) throw Object.assign(new Error('Simulation Run has active requests; retry after they complete'), { code: 'simulation_run_busy' })
    if (!shuttingDown && leases.acceleration > 0) throw Object.assign(new Error('Simulation Run has active accelerated execution; pause it before closing'), { code: 'simulation_run_busy' })
    backgroundReleases.get(id)?.()
    backgroundReleases.delete(id)
    clearIdleRuntimeCloseTimer(id)
    leasesBySimulationRun.delete(id)
    await runtime.close()
    simulationRuns.delete(id)
    return true
  }
  const close = (id: SimulationRunId): Promise<boolean> => lifecycle.run(id, () => closeLoaded(id))

  const reset = (id: SimulationRunId): Promise<SimulationRunRuntime> => lifecycle.run(id, async () => {
    const leases = leaseSummary(id).leasesByKind
    if (leases.api > 0) throw Object.assign(new Error('Simulation Run has active requests; retry after they complete'), { code: 'simulation_run_busy' })
    if (leases.acceleration > 0) throw Object.assign(new Error('Simulation Run has active accelerated execution; pause it before resetting'), { code: 'simulation_run_busy' })
    const manifest = await manifestStoreFor(id).load()
    if (!manifest) throw new Error(`Simulation Run not found: ${id}`)
    const existing = simulationRuns.get(id)
    const resetEvent = existing
      ? await existing.publishResetBoundary({ scenarioId: manifest.scenario.id })
      : undefined
    await closeLoaded(id)
    const runDir = join(simulationRunRoot, id)
    await Promise.all([
      rm(join(runDir, 'snapshot.json'), { force: true }),
      rm(join(runDir, 'events.jsonl'), { force: true }),
      rm(join(runDir, 'runtimes'), { recursive: true, force: true }),
      rm(join(runDir, 'history.sqlite'), { force: true }),
      rm(join(runDir, 'history.sqlite-wal'), { force: true }),
      rm(join(runDir, 'history.sqlite-shm'), { force: true }),
      rm(join(runDir, 'acceleration.json'), { force: true }),
    ])
    return createRuntime({
      manifest,
      ...(resetEvent === undefined ? {} : { initialSeq: resetEvent.seq + 1 }),
    })
  })

  const deleteSimulationRun = (id: SimulationRunId): Promise<boolean> => lifecycle.run(id, async () => {
    const wasLoaded = await closeLoaded(id)
    pinnedTitles.delete(id)
    accelerationStates.delete(id)
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
  })

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

  const unavailableSummary = (id: SimulationRunId, loadError: string): SimulationRunSummary => ({
    id, name: null, title: id, scenarioId: null, scenarioTitle: null,
    scenarioRevisionId: null, createdAt: null, loaded: false,
    snapshotSeq: null, objectCount: null, clock: null, activeCapabilityIds: [], origin: null, loadError,
  })

  const readSummary = async (id: SimulationRunId): Promise<SimulationRunSummary> => {
    const manifest = await manifestStoreFor(id).load()
    if (!manifest) return unavailableSummary(id, 'Simulation Run Manifest is missing')
    const loaded = simulationRuns.get(id)
    // Names must not follow a mutable or deleted catalog entry. Read the pinned
    // compiled artifact independently of the authored revision.
    let scenarioTitle = pinnedTitles.get(id)
    if (scenarioTitle === undefined) {
      const scenario = await createCompiledScenarioStore(join(simulationRunRoot, id, 'compiled-scenario.json')).load()
      scenarioTitle = scenario.title
      pinnedTitles.set(id, scenarioTitle)
    }
    const name = await readRunDisplayName(join(simulationRunRoot, id, 'display-name.json'))
    const title = name ?? scenarioTitle
    if (loaded) {
      const snapshot = loaded.snapshot()
      return {
        id,
        name,
        title,
        scenarioId: manifest.scenario.id,
        scenarioTitle,
        scenarioRevisionId: manifest.scenario.revisionId,
        createdAt: manifest.createdAt,
        loaded: true,
        snapshotSeq: snapshot.seq,
        objectCount: snapshot.objects.length,
        clock: snapshot.clock ?? null,
        activeCapabilityIds: capabilityIdsForRuntimeIds(manifest.runtimes.map(runtime => runtime.id)),
        origin: manifest.origin ?? null,
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
      name,
      title,
      scenarioId: manifest.scenario.id,
      scenarioTitle,
      scenarioRevisionId: manifest.scenario.revisionId,
      createdAt: manifest.createdAt,
      loaded: false,
      snapshotSeq: snapshot?.seq ?? null,
      objectCount: snapshot?.objects.length ?? null,
      clock: snapshot?.clock ?? null,
      activeCapabilityIds: capabilityIdsForRuntimeIds(manifest.runtimes.map(runtime => runtime.id)),
      origin: manifest.origin ?? null,
      ...(loadError === undefined ? {} : { loadError }),
    }
  }

  const summaryFor = async (id: SimulationRunId): Promise<SimulationRunSummary> => {
    try { return await readSummary(id) }
    catch (error) {
      // One damaged/unsupported retained resource must not hide the workspace.
      // Its state remains untouched, and loading still rejects the real error.
      const reason = error instanceof ZodError
        ? error.issues.slice(0, 3).map(issue => `${issue.path.join('.') || 'state'}: ${issue.message}`).join('; ')
        : error instanceof Error ? error.message : String(error)
      return unavailableSummary(id, `Simulation Run is unreadable: ${reason}`)
    }
  }

  const listKnown = async (): Promise<ReadonlyArray<SimulationRunSummary>> => {
    const ids = new Set<SimulationRunId>([...simulationRuns.keys(), ...await listPersistedIds()])
    const summaries: SimulationRunSummary[] = []
    for (const id of [...ids].sort()) summaries.push(await summaryFor(id))
    return summaries
  }

  const renameRun = (id: SimulationRunId, name: string | null, expectedTitle: string): Promise<SimulationRunSummary> => {
    return lifecycle.run(id, async () => {
      runDisplayNameSchema.parse(name)
      const current = await summaryFor(id)
      if (current.scenarioId === null) throw new Error(`Simulation Run not found: ${id}`)
      if (current.title !== expectedTitle) throw Object.assign(new Error('Simulation Run name changed; refresh before renaming'), { code: 'simulation_run_name_changed' })
      await writeRunDisplayName(join(simulationRunRoot, id, 'display-name.json'), name)
      return await summaryFor(id)
    })
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
    scenarioAuthoringCatalog: {
      ...config.scenarioAuthoringCatalog,
      commands: installedCapabilities.filter(entry => entry.capability.kind === 'command' && entry.capability.schedulable).map(entry => ({
        id: entry.capability.id, title: entry.capability.title, description: entry.capability.description,
        packId: entry.packId, runtimeId: entry.runtimeId, inputSchema: z.toJSONSchema(entry.capability.input, { io: 'input' }),
      })),
    },
    installedCapabilities,
    workspaceCapabilities: config.runtimeAdapters.flatMap(adapter => adapter.workspaceCapabilities ?? []),
    create,
    createAcceleratedCopy,
    startAcceleration,
    pauseAcceleration,
    accelerationStatus,
    load,
    reset,
    delete: deleteSimulationRun,
    rename: renameRun,
    get: (id: SimulationRunId) => simulationRuns.get(id),
    list: () => [...simulationRuns.values()],
    listKnown,
    summary: summaryFor,
    status,
    acquireLease,
    compiledScenarioForRun: async id => {
      const stored = await createCompiledScenarioStore(join(simulationRunRoot, id, 'compiled-scenario.json')).load()
      const manifest = await manifestStoreFor(id).load()
      if (!manifest || manifest.workspaceId !== config.workspaceId || stored.id !== manifest.scenario.id || compiledScenarioDigest(stored) !== manifest.scenario.compiledDigest) throw new Error(`Compiled Scenario integrity mismatch: ${id}`)
      return stored
    },
    setBackgroundExecution: async (id, enabled) => {
      await load(id)
      return lifecycle.run(id, async () => {
        if (!simulationRuns.has(id)) throw new Error(`Simulation Run not loaded: ${id}`)
        if (enabled && !backgroundReleases.has(id)) backgroundReleases.set(id, acquireLease(id, 'background'))
        if (!enabled) { backgroundReleases.get(id)?.(); backgroundReleases.delete(id) }
        return leaseSummary(id)
      })
    },
    shutdown: async () => {
      shuttingDown = true
      for (const job of accelerationJobs.values()) job.pauseRequested = true
      await Promise.allSettled([...accelerationJobs.values()].flatMap(job => job.done ? [job.done] : []))
      await definitionOperations.close()
      await Promise.allSettled([...creatingSimulationRuns.values()])
      await lifecycle.drain()
      const results = await Promise.allSettled([...simulationRuns.keys()].map(close))
      compiledScenarios.clear()
      pinnedTitles.clear()
      const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Simulation Run shutdown failed')
    },
    leaseSummary,
    isIdle: () => simulationRuns.size === 0 && creatingSimulationRuns.size === 0 && definitionOperations.activeCount() === 0 && leasesBySimulationRun.size === 0,
    listScenarios: () => definitionOperations.run(async () => {
      await ensureScenarioLibrary()
      return await scenarioLibrary.list()
    }),
    currentScenario: (id: string) => definitionOperations.run(async () => {
      await ensureScenarioLibrary()
      return await scenarioLibrary.currentRevision(id)
    }),
    createScenario: source => definitionOperations.run(async () => {
      await ensureScenarioLibrary()
      await compileValidatedDefinition(source)
      return await storageBudget.withGrowth(workspaceRoot, Buffer.byteLength(JSON.stringify(source)) * 2, () => scenarioLibrary.create(source))
    }),
    previewScenario: source => definitionOperations.run(async () => {
      const compiled = await compileValidatedDefinition(source)
      return scenarioPreviewFor(compiled, config.scenarioRuntimeResolver.resolve(compiled).packs)
    }),
    updateScenario: (source, expectedRevisionId) => definitionOperations.run(async () => {
      await ensureScenarioLibrary()
      await compileValidatedDefinition(source)
      return await storageBudget.withGrowth(workspaceRoot, Buffer.byteLength(JSON.stringify(source)) * 2, () => scenarioLibrary.update(source, expectedRevisionId))
    }),
    deleteScenario: (id: string, revisionId: ScenarioRevisionId) => definitionOperations.run(async () => {
      await ensureScenarioLibrary()
      const current = await scenarioLibrary.currentRevision(id)
      if (!current || current.id !== revisionId) return false
      return await scenarioLibrary.delete(id, revisionId)
    }),
    scenarioRevisionForRun,
    compileScenarioRevision: compileRevision,
    close,
  }
}
