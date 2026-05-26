import { randomUUID } from 'node:crypto'
import type { CommandEnvelope, CommandResult, DomainEvent, ObjectId, OperationalObject, SignalId, SimulationClockState } from '../../../core/model/index.ts'
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
import { validateProcessPlantControlWrite } from '../control-write-validation.ts'
import { processPlantDomainId } from '../model.ts'
import { answerProcessPlantQuery, processPlantQueryKinds } from '../query.ts'
import type { ProcessPlantSystemRuntime } from '../system-runtime.ts'
import { processPlantSimAdapterId, processPlantSimProviderId } from './constants.ts'
import {
  processPlantProviderStateSchema,
  type ProcessPlantProviderState,
} from './provider-state.ts'
import {
  initialProcessPlantObjects,
  processPlantProjectionEvents,
  processPlantUnitSystemId,
  projectedInitialProcessPlantObjects,
} from './object-projection.ts'
import { assertProviderConfigMatchesCompiledSystems, processPlantProviderConfigFor } from './provider-config.ts'
import { createProcessPlantProviderPersistence } from './persistence.ts'
import { createProcessPlantSystemRuntimes } from './system-runtime-factory.ts'

const updateIntervalMs = 1_000

const fail = (request: PackQueryRequest, reason: string): PackQueryResponse => ({
  ok: false,
  packId: request.packId,
  kind: request.kind,
  reason,
  generatedAt: nowIso(),
})

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
    const systems = createProcessPlantSystemRuntimes({
      compiledSystems,
      providerConfig,
      providerState,
    })
    const persistence = createProcessPlantProviderPersistence({
      connection: config,
      systems,
    })
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
      await persistence.saveNow()
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
            await persistence.saveNow()
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
          await persistence.saveNow()
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
        await persistence.saveNow()
        handlers.clear()
      },
    }
  },
})
