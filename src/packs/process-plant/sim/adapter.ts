import { randomUUID } from 'node:crypto'
import type { CommandEnvelope, CommandResult, DomainEvent, ObjectId, OperationalObject, SignalId, SimulationClockState } from '../../../core/model/index.ts'
import { z } from 'zod'
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
  processPlantTelemetryConfigSchema,
  processPlantProtectionConfigSchema,
  type ProcessPlantScheduleConfig,
  type ProcessPlantTelemetryConfig,
  type ProcessPlantTelemetryRecorder,
  type ProcessPlantProtectionConfig,
} from '../runtime/index.ts'
import { validateProcessPlantControlWrite } from '../control-write-validation.ts'
import { processPlantDomainId } from '../model.ts'
import { answerProcessPlantQuery, processPlantQueryKinds } from '../query.ts'
import { createProcessPlantRuntimePerformance, type ProcessPlantSystemRuntime } from '../system-runtime.ts'
import { processPlantSimAdapterId, processPlantSimProviderId } from './constants.ts'
import { resolveProcessPlantIcConfig } from '../specs/index.ts'
import {
  processPlantProviderStateSchema,
  providerStateForProcessPlantSystems,
  restoredProtectionSnapshotFor,
  restoredRuntimeSnapshotFor,
  restoredScheduleSnapshotFor,
  restoredTelemetrySnapshotFor,
  type ProcessPlantProviderState,
} from './provider-state.ts'
import {
  initialProcessPlantObjects,
  processPlantProjectionEvents,
  processPlantUnitSystemId,
  projectedInitialProcessPlantObjects,
} from './object-projection.ts'

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

const assertProviderConfigMatchesCompiledSystems = (config: {
  readonly providerConfig: ProcessPlantProviderConfig
  readonly systemIds: ReadonlySet<string>
}): void => {
  for (const configuredSystemId of Object.keys(config.providerConfig.systems)) {
    if (!config.systemIds.has(configuredSystemId)) {
      throw new Error(`process plant provider config references unknown process system: ${configuredSystemId}`)
    }
  }
}

const saveProviderState = async (
  config: SimulationConnectionConfig,
  systems: ReadonlyMap<string, ProcessPlantSystemRuntime>,
): Promise<void> => {
  if (!config.providerStateStore || systems.size === 0) return
  await config.providerStateStore.save(providerStateForProcessPlantSystems(systems))
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

const emitProviderFailure = (config: {
  readonly handlers: ReadonlySet<SimulationEventHandler>
  readonly controlInstanceId: SimulationConnectionConfig['controlInstanceId']
  readonly error: unknown
}): void => {
  const at = nowIso()
  emitSimulationEvents(config.handlers, [{
    type: 'interaction.signal',
    at,
    provenance: { source: 'simulator', adapterId: processPlantSimAdapterId },
    signal: {
      id: `process-plant-provider-failed:${randomUUID()}` as SignalId,
      controlInstanceId: config.controlInstanceId,
      at,
      source: { kind: 'simulation', id: processPlantSimProviderId },
      targets: [{ kind: 'broadcast' }],
      type: 'process-plant.provider.failed',
      severity: 'critical',
      payload: {
        providerId: processPlantSimProviderId,
        message: config.error instanceof Error ? config.error.message : String(config.error),
      },
    },
  }])
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
    assertProviderConfigMatchesCompiledSystems({
      providerConfig,
      systemIds: new Set(compiledSystems.map(system => system.id)),
    })
    const systems = new Map<string, ProcessPlantSystemRuntime>(compiledSystems.map(system => [
      system.id,
      (() => {
        const systemConfig = providerConfig.systems[system.id]
        const telemetryConfig: ProcessPlantTelemetryConfig | undefined = systemConfig?.telemetry
        const scheduleConfig: ProcessPlantScheduleConfig | undefined = systemConfig?.schedule
        const protectionConfig = protectionConfigFor(systemConfig)
        const runtime = createProcessPlantRuntime({
          system,
          ...(restoredRuntimeSnapshotFor(providerState, system.id) === undefined
            ? {}
            : { restoredSnapshot: restoredRuntimeSnapshotFor(providerState, system.id)! }),
        })
        const telemetry: ProcessPlantTelemetryRecorder | undefined = telemetryConfig === undefined
          ? undefined
          : createProcessPlantTelemetryRecorder({
              systemId: system.id,
              telemetry: telemetryConfig,
              ...(restoredTelemetrySnapshotFor(providerState, system.id) === undefined
                ? {}
                : { restoredSnapshot: restoredTelemetrySnapshotFor(providerState, system.id)! }),
            })
        telemetry?.recordDueSamples(runtime)
        const restoredSchedule = restoredScheduleSnapshotFor(providerState, system.id)
        const protection = protectionConfig === undefined
          ? undefined
          : createProcessPlantProtectionRunner({
              system,
              protection: protectionConfig,
              ...(restoredProtectionSnapshotFor(providerState, system.id) === undefined
                ? {}
                : { restoredSnapshot: restoredProtectionSnapshotFor(providerState, system.id)! }),
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
      projectedInitialProcessPlantObjects({
        objects: initialProcessPlantObjects(config),
        systems,
        at: nowIso(),
      }).map(object => [object.id, object]),
    )

    await saveProviderState(config, systems)
    let providerFailed = false

    const advance = async (): Promise<void> => {
      if (providerFailed) return
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
      events.push(...processPlantProjectionEvents({
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
        providerFailed = true
        clearInterval(interval)
        emitProviderFailure({
          handlers,
          controlInstanceId: config.controlInstanceId,
          error,
        })
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
        if (providerFailed) {
          return { ok: false, commandId: command.id, rejectedAt: acceptedAt, reason: 'process plant provider has stopped after a runtime failure' }
        }
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
        if (providerFailed) return fail(request, 'process plant provider has stopped after a runtime failure')
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
