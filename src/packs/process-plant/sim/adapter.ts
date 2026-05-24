import { z } from 'zod'
import type { CommandEnvelope, CommandResult, DomainEvent, IsoTimestamp, ObjectId, OperationalObject, Provenance, SimulationClockState } from '../../../core/model/index.ts'
import { nowIso } from '../../../core/model/index.ts'
import type {
  SimulationAdapter,
  SimulationConnection,
  SimulationConnectionConfig,
  SimulationEvent,
  SimulationEventHandler,
} from '../../../simulation/protocol.ts'
import type { PackQueryRequest, PackQueryResponse } from '../../../core/packs/protocol.ts'
import {
  processPlantControlWriteCommandKind,
  processPlantControlWritePayloadSchema,
  processPlantIcLifecycleCommandKind,
  processPlantIcLifecyclePayloadSchema,
} from '../commands.ts'
import { compileProcessPlantSystems } from '../process-systems.ts'
import { createProcessPlantRuntime } from '../runtime/index.ts'
import {
  createProcessPlantScheduleRunner,
  createProcessPlantTelemetryRecorder,
  createProcessPlantProtectionRunner,
  processPlantScheduleConfigSchema,
  processPlantScheduleSnapshotSchema,
  processPlantTelemetryConfigSchema,
  processPlantTelemetrySnapshotSchema,
  processPlantProtectionConfigSchema,
  processPlantProtectionSnapshotSchema,
  type ProcessPlantRuntimeSnapshot,
  type ProcessPlantScheduleConfig,
  type ProcessPlantScheduleSnapshot,
  type ProcessPlantTelemetryConfig,
  type ProcessPlantTelemetryRecorder,
  type ProcessPlantTelemetrySnapshot,
  type ProcessPlantProtectionConfig,
  type ProcessPlantProtectionSnapshot,
} from '../runtime/index.ts'
import {
  processQuantitySchema,
  processEquipmentIdSchema,
  processSignalTagIdSchema,
  processVariableCapabilitySchema,
  processVariableLimitsSchema,
  processUnitSchema,
  processVariableValueSchema,
  variableKindSchema,
  variablePathSchema,
  variableDomainSchema,
} from '../graph/index.ts'
import { validateProcessPlantControlWrite } from '../control-write-validation.ts'
import { processPlantDomainId, processPlantUnitDomainDataSchema } from '../model.ts'
import { processPlantProjectionKey, projectedProcessPlantUnit } from '../projection.ts'
import { answerProcessPlantQuery, processPlantQueryKinds } from '../query.ts'
import { createProcessPlantRuntimePerformance, type ProcessPlantSystemRuntime } from '../system-runtime.ts'
import { processPlantSimAdapterId, processPlantSimProviderId } from './constants.ts'
import { resolveProcessPlantIcConfig } from '../specs/index.ts'

const processPlantVariableSnapshotSchema = z.object({
  path: variablePathSchema,
  label: z.string().min(1),
  value: processVariableValueSchema,
  canonicalValue: processVariableValueSchema,
  quantity: processQuantitySchema,
  unit: processUnitSchema,
  domain: variableDomainSchema,
  kind: variableKindSchema,
  writable: z.boolean(),
  published: z.boolean(),
  tagId: processSignalTagIdSchema.optional(),
  equipmentId: processEquipmentIdSchema.optional(),
  description: z.string().min(1).optional(),
  externalRefs: z.array(z.string().min(1)).optional(),
  capabilities: processVariableCapabilitySchema.optional(),
  limits: processVariableLimitsSchema.optional(),
})

const processPlantRuntimeSnapshotSchema = z.object({
  graphSpecId: z.string().min(1),
  variablePaths: z.array(variablePathSchema).min(1),
  elapsedMs: z.number().finite().nonnegative(),
  remainderMs: z.number().finite().nonnegative(),
  queuedCommands: z.array(z.object({
    type: z.literal('setVariable'),
    path: variablePathSchema,
    value: processVariableValueSchema,
  })),
  variables: z.array(processPlantVariableSnapshotSchema),
})

const processPlantProviderStateSchema = z.object({
  schemaVersion: z.literal(1),
  systems: z.array(z.object({
    systemId: z.string().min(1),
    runtime: processPlantRuntimeSnapshotSchema,
    schedule: processPlantScheduleSnapshotSchema.optional(),
    telemetry: processPlantTelemetrySnapshotSchema.optional(),
    protection: processPlantProtectionSnapshotSchema.optional(),
  })),
})

interface ProcessPlantProviderState {
  readonly schemaVersion: 1
  readonly systems: ReadonlyArray<{
    readonly systemId: string
    readonly runtime: ProcessPlantRuntimeSnapshot
    readonly schedule?: ProcessPlantScheduleSnapshot
    readonly telemetry?: ProcessPlantTelemetrySnapshot
    readonly protection?: ProcessPlantProtectionSnapshot
  }>
}

const processPlantProviderSystemConfigSchema = z.object({
  schedule: processPlantScheduleConfigSchema.optional(),
  telemetry: processPlantTelemetryConfigSchema.optional(),
  icRef: z.string().min(1).optional(),
  protection: processPlantProtectionConfigSchema.optional(),
}).strict().superRefine((system, ctx) => {
  if (system.icRef !== undefined && system.protection !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['protection'],
      message: 'process plant system config must not define both icRef and inline protection',
    })
  }
})

const processPlantProviderConfigSchema = z.object({
  systems: z.record(processPlantProviderSystemConfigSchema).default({}),
}).strict()

type ProcessPlantProviderConfig = z.infer<typeof processPlantProviderConfigSchema>

const updateIntervalMs = 1_000

const fail = (request: PackQueryRequest, reason: string): PackQueryResponse => ({
  ok: false,
  packId: request.packId,
  kind: request.kind,
  reason,
  generatedAt: nowIso(),
})

const providerStateFor = (
  systems: ReadonlyMap<string, ProcessPlantSystemRuntime>,
): ProcessPlantProviderState => ({
  schemaVersion: 1,
  systems: [...systems.values()].map(({ system, runtime, schedule, telemetry, protection }) => ({
    systemId: system.id,
    runtime: runtime.snapshot(),
    schedule: schedule.snapshot(),
    ...(telemetry === undefined ? {} : { telemetry: telemetry.snapshot() }),
    ...(protection === undefined ? {} : { protection: protection.snapshot() }),
  })),
})

const restoredSnapshotFor = (
  providerState: ProcessPlantProviderState | null,
  systemId: string,
): ProcessPlantRuntimeSnapshot | undefined => {
  const restored = providerState?.systems.find(system => system.systemId === systemId)
  return restored?.runtime
}

const restoredScheduleFor = (
  providerState: ProcessPlantProviderState | null,
  systemId: string,
): ProcessPlantScheduleSnapshot | undefined => {
  const restored = providerState?.systems.find(system => system.systemId === systemId)
  return restored?.schedule
}

const restoredTelemetryFor = (
  providerState: ProcessPlantProviderState | null,
  systemId: string,
): ProcessPlantTelemetrySnapshot | undefined => {
  const restored = providerState?.systems.find(system => system.systemId === systemId)
  return restored?.telemetry
}

const restoredProtectionFor = (
  providerState: ProcessPlantProviderState | null,
  systemId: string,
): ProcessPlantProtectionSnapshot | undefined => {
  const restored = providerState?.systems.find(system => system.systemId === systemId)
  return restored?.protection
}

const processPlantProviderConfigFor = (config: SimulationConnectionConfig): ProcessPlantProviderConfig => {
  const rawConfig = config.scenario?.providerConfigs?.[processPlantSimProviderId] ?? config.scenario?.providerConfig ?? {}
  return processPlantProviderConfigSchema.parse(rawConfig)
}

const protectionConfigFor = (
  systemConfig: z.infer<typeof processPlantProviderSystemConfigSchema> | undefined,
): ProcessPlantProtectionConfig | undefined => {
  if (systemConfig?.protection !== undefined) return systemConfig.protection
  if (systemConfig?.icRef !== undefined) return resolveProcessPlantIcConfig(systemConfig.icRef)
  return undefined
}

const saveProviderState = async (
  config: SimulationConnectionConfig,
  systems: ReadonlyMap<string, ProcessPlantSystemRuntime>,
): Promise<void> => {
  if (!config.providerStateStore || systems.size === 0) return
  await config.providerStateStore.save(providerStateFor(systems))
}

const emitSimulationEvents = (
  handlers: ReadonlySet<SimulationEventHandler>,
  events: ReadonlyArray<SimulationEvent>,
): void => {
  if (events.length === 0) return
  const emittedAt = nowIso()
  for (const handler of handlers) {
    handler({
      type: 'event.emission',
      events,
      emittedAt,
      providerId: processPlantSimProviderId,
    })
  }
}

const initialProcessPlantObjects = (
  config: SimulationConnectionConfig,
): ReadonlyArray<OperationalObject> =>
  config.initialObjects ?? config.scenario?.initialObjects ?? []

const processPlantUnitSystemId = (object: OperationalObject): string | null => {
  const parsed = processPlantUnitDomainDataSchema.safeParse(object.domainData)
  return parsed.success ? parsed.data.systemId : null
}

const projectedInitialObjects = (config: {
  readonly objects: ReadonlyArray<OperationalObject>
  readonly systems: ReadonlyMap<string, ProcessPlantSystemRuntime>
  readonly at: IsoTimestamp
}): ReadonlyArray<OperationalObject> =>
  config.objects.map(object => {
    const systemId = processPlantUnitSystemId(object)
    return systemId === null
      ? object
      : projectedProcessPlantUnit({
          object,
          system: config.systems.get(systemId),
          at: config.at,
        })
  })

const projectionEvents = (config: {
  readonly objectsById: Map<ObjectId, OperationalObject>
  readonly systems: ReadonlyMap<string, ProcessPlantSystemRuntime>
  readonly at: IsoTimestamp
  readonly provenance: Provenance
}): ReadonlyArray<SimulationEvent> => {
  const events: SimulationEvent[] = []
  for (const object of config.objectsById.values()) {
    const systemId = processPlantUnitSystemId(object)
    if (systemId === null) continue
    const next = projectedProcessPlantUnit({
      object,
      system: config.systems.get(systemId),
      at: config.at,
    })
    if (processPlantProjectionKey(object) === processPlantProjectionKey(next)) continue
    config.objectsById.set(next.id, next)
    events.push({
      type: 'object.upserted',
      object: next,
      at: config.at,
      provenance: config.provenance,
    })
  }
  return events
}

export const createLocalProcessPlantSimulationAdapter = (): SimulationAdapter => ({
  id: processPlantSimProviderId,
  packId: 'process-plant',
  domain: processPlantDomainId,
  acceptedCommandKinds: [processPlantControlWriteCommandKind, processPlantIcLifecycleCommandKind],
  queryKinds: processPlantQueryKinds,
  connect: async (config: SimulationConnectionConfig): Promise<SimulationConnection> => {
    const handlers = new Set<SimulationEventHandler>()
    const rawProviderState = await config.providerStateStore?.load()
    const providerState = rawProviderState === undefined || rawProviderState === null
      ? null
      : processPlantProviderStateSchema.parse(rawProviderState) as ProcessPlantProviderState
    const providerConfig = processPlantProviderConfigFor(config)
    const compiledSystems = compileProcessPlantSystems(config.scenario?.processSystems ?? [])
    const systems = new Map<string, ProcessPlantSystemRuntime>(compiledSystems.map(system => [
      system.id,
      (() => {
        const systemConfig = providerConfig.systems[system.id]
        const telemetryConfig: ProcessPlantTelemetryConfig | undefined = systemConfig?.telemetry
        const scheduleConfig: ProcessPlantScheduleConfig | undefined = systemConfig?.schedule
        const protectionConfig = protectionConfigFor(systemConfig)
        const runtime = createProcessPlantRuntime({
          system,
          ...(restoredSnapshotFor(providerState, system.id) === undefined
            ? {}
            : { restoredSnapshot: restoredSnapshotFor(providerState, system.id)! }),
        })
        const telemetry: ProcessPlantTelemetryRecorder | undefined = telemetryConfig === undefined
          ? undefined
          : createProcessPlantTelemetryRecorder({
              systemId: system.id,
              telemetry: telemetryConfig,
              ...(restoredTelemetryFor(providerState, system.id) === undefined
                ? {}
                : { restoredSnapshot: restoredTelemetryFor(providerState, system.id)! }),
            })
        telemetry?.recordDueSamples(runtime)
        const restoredSchedule = restoredScheduleFor(providerState, system.id)
        const protection = protectionConfig === undefined
          ? undefined
          : createProcessPlantProtectionRunner({
              system,
              protection: protectionConfig,
              ...(restoredProtectionFor(providerState, system.id) === undefined
                ? {}
                : { restoredSnapshot: restoredProtectionFor(providerState, system.id)! }),
            })
        return {
          system,
          runtime,
          schedule: createProcessPlantScheduleRunner({
            system,
            ...(scheduleConfig === undefined ? {} : { schedule: scheduleConfig }),
            ...(restoredSchedule === undefined ? {} : { restoredSnapshot: restoredSchedule }),
          }),
          ...(telemetry === undefined ? {} : { telemetry }),
          ...(protection === undefined ? {} : { protection }),
          performance: createProcessPlantRuntimePerformance(),
        }
      })(),
    ]))
    let clock: SimulationClockState = {
      currentTime: config.scenario?.world.startsAt ?? nowIso(),
      updatedAt: nowIso(),
      paused: false,
      speed: 1,
    }
    let lastTickWallMs = Date.now()
    const objectsById = new Map<ObjectId, OperationalObject>(
      projectedInitialObjects({
        objects: initialProcessPlantObjects(config),
        systems,
        at: nowIso(),
      }).map(object => [object.id, object]),
    )

    await saveProviderState(config, systems)

    const advance = async (): Promise<void> => {
      const nowWallMs = Date.now()
      const elapsedMs = clock.paused ? 0 : Math.round((nowWallMs - lastTickWallMs) * clock.speed)
      lastTickWallMs = nowWallMs
      if (elapsedMs <= 0 || systems.size === 0) return
      const events: SimulationEvent[] = []
      for (const { runtime, schedule, telemetry, protection, performance: runtimePerformance } of systems.values()) {
        const startedAt = performance.now()
        schedule.applyDueActions(runtime, runtime.elapsedMs() + elapsedMs)
        const tick = runtime.tick(elapsedMs)
        events.push(...(protection?.evaluate({
          runtime,
          elapsedMs: runtime.elapsedMs(),
          controlInstanceId: config.controlInstanceId,
          sourceProviderId: processPlantSimProviderId,
        }) ?? []))
        telemetry?.recordDueSamples(runtime)
        runtimePerformance.record({
          wallMs: performance.now() - startedAt,
          simulatedMs: tick.simulatedMs,
        })
      }
      events.push(...projectionEvents({
        objectsById,
        systems,
        at: nowIso(),
        provenance: {
          source: 'simulator',
          adapterId: processPlantSimAdapterId,
        },
      }))
      emitSimulationEvents(handlers, events)
      await saveProviderState(config, systems)
    }

    const interval = setInterval(() => {
      void advance().catch(error => {
        console.error(error)
      })
    }, updateIntervalMs)

    return {
      getSnapshot: async () => ({
        controlInstanceId: config.controlInstanceId,
        objects: [...objectsById.values()],
        capturedAt: nowIso(),
      }),
      subscribe: (handler: SimulationEventHandler): (() => void) => {
        handlers.add(handler)
        return () => {
          handlers.delete(handler)
        }
      },
      sendCommand: async (command: CommandEnvelope): Promise<CommandResult> => {
        const acceptedAt = nowIso()
        if (command.kind === processPlantIcLifecycleCommandKind) {
          const payload = processPlantIcLifecyclePayloadSchema.safeParse(command.payload)
          if (!payload.success) return { ok: false, commandId: command.id, rejectedAt: acceptedAt, reason: payload.error.message }
          const system = systems.get(payload.data.systemId)
          if (!system) return { ok: false, commandId: command.id, rejectedAt: acceptedAt, reason: `process plant system not found: ${payload.data.systemId}` }
          if (!system.protection) return { ok: false, commandId: command.id, rejectedAt: acceptedAt, reason: `process plant I&C is not configured for system: ${payload.data.systemId}` }
          try {
            const events = system.protection.applyLifecycleAction({
              id: payload.data.lifecycleId,
              action: payload.data.action,
              elapsedMs: system.runtime.elapsedMs(),
              controlInstanceId: config.controlInstanceId,
              sourceProviderId: processPlantSimProviderId,
              actorId: command.actorId,
              ...(command.clientId === undefined ? {} : { clientId: command.clientId }),
              ...(payload.data.reason === undefined ? {} : { reason: payload.data.reason }),
              ...(payload.data.shelveDurationMs === undefined ? {} : { shelveDurationMs: payload.data.shelveDurationMs }),
            })
            emitSimulationEvents(handlers, events)
            await saveProviderState(config, systems)
            return { ok: true, commandId: command.id, acceptedAt }
          } catch (err) {
            return {
              ok: false,
              commandId: command.id,
              rejectedAt: acceptedAt,
              reason: err instanceof Error ? err.message : String(err),
            }
          }
        }
        if (command.kind !== processPlantControlWriteCommandKind) {
          return {
            ok: false,
            commandId: command.id,
            rejectedAt: acceptedAt,
            reason: `process plant provider does not accept command kind: ${command.kind}`,
          }
        }
        const payload = processPlantControlWritePayloadSchema.safeParse(command.payload)
        if (!payload.success) return { ok: false, commandId: command.id, rejectedAt: acceptedAt, reason: payload.error.message }
        const system = systems.get(payload.data.systemId)
        if (!system) return { ok: false, commandId: command.id, rejectedAt: acceptedAt, reason: `process plant system not found: ${payload.data.systemId}` }
        try {
          const validation = validateProcessPlantControlWrite({
            system: system.system,
            runtime: system.runtime,
            ...(system.protection === undefined ? {} : { protection: system.protection }),
            payload: payload.data,
          })
          if (!validation.accepted) return { ok: false, commandId: command.id, rejectedAt: acceptedAt, reason: validation.reason }
          system.runtime.writeCommand({
            type: 'setVariable',
            path: validation.targetPath,
            value: payload.data.value,
          })
          await saveProviderState(config, systems)
          return { ok: true, commandId: command.id, acceptedAt }
        } catch (err) {
          return {
            ok: false,
            commandId: command.id,
            rejectedAt: acceptedAt,
            reason: err instanceof Error ? err.message : String(err),
          }
        }
      },
      query: async (request: PackQueryRequest): Promise<PackQueryResponse> => {
        if (systems.size === 0) return fail(request, 'process plant provider is not active for this scenario')
        return answerProcessPlantQuery({
          request,
          systems,
          at: nowIso(),
        })
      },
      observeCommittedEvents: async (events: ReadonlyArray<DomainEvent>): Promise<void> => {
        for (const event of events) {
          if (event.type === 'object.upserted' && processPlantUnitSystemId(event.object) !== null) {
            objectsById.set(event.object.id, event.object)
          }
          if (event.type === 'object.deleted') objectsById.delete(event.objectId)
        }
      },
      setClock: async (nextClock: SimulationClockState): Promise<void> => {
        clock = nextClock
        lastTickWallMs = Date.now()
      },
      close: async (): Promise<void> => {
        clearInterval(interval)
        await saveProviderState(config, systems)
        handlers.clear()
      },
    }
  },
})
