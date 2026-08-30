import { randomUUID } from 'node:crypto'
import type { CommandEnvelope, CommandResult, SimulationRunEvent, ObjectId, OperationalObject, SignalId, SimulationClockState } from '../../../core/model/index.ts'
import { nowIso } from '../../../core/model/index.ts'
import type {
  PackRuntimeAdapter,
  PackRuntimeConnection,
  PackRuntimeConnectionConfig,
  PackRuntimeEvent,
  PackRuntimeEventHandler,
} from '../../../simulation/protocol.ts'
import type { PackQueryRequest, PackQueryResponse } from '../../../core/packs/protocol.ts'
import {
  processPlantControlRampCommandKind,
  processPlantControlRampPayloadSchema,
  processPlantControlWriteCommandKind,
  processPlantControlWritePayloadSchema,
  processPlantIcLifecycleCommandKind,
  processPlantIcLifecyclePayloadSchema,
} from '../commands.ts'
import { compileProcessPlantSystems } from '../process-systems.ts'
import { validateProcessPlantControlWrite } from '../control-write-validation.ts'
import { processPlantPackId } from '../model.ts'
import { answerProcessPlantQuery, processPlantQueryKinds } from '../query.ts'
import type { ProcessPlantSystemRuntime } from '../system-runtime.ts'
import { processPlantSimAdapterId, processPlantSimRuntimeId } from './constants.ts'
import {
  processPlantRuntimeStateSchema,
  type ProcessPlantRuntimeState,
} from './runtime-state.ts'
import {
  initialProcessPlantObjects,
  processPlantProjectionEvents,
  processPlantUnitSystemId,
  projectedInitialProcessPlantObjects,
} from './object-projection.ts'
import { assertRuntimeConfigMatchesCompiledSystems, processPlantRuntimeConfigFor } from './runtime-config.ts'
import { createProcessPlantRuntimePersistence } from './persistence.ts'
import { createProcessPlantSystemRuntimes } from './system-runtime-factory.ts'

const updateIntervalMs = 1_000

const fail = (request: PackQueryRequest, reason: string): PackQueryResponse => ({
  ok: false,
  packId: request.packId,
  kind: request.kind,
  reason,
  generatedAt: nowIso(),
})

const emitPackRuntimeEvents = (
  handlers: ReadonlySet<PackRuntimeEventHandler>,
  events: ReadonlyArray<PackRuntimeEvent>,
): void => {
  if (events.length === 0) return
  const emittedAt = nowIso()
  for (const handler of handlers) {
    handler({
      type: 'event.emission',
      events,
      emittedAt,
      runtimeId: processPlantSimRuntimeId,
    })
  }
}

const emitRuntimeFailure = (config: {
  readonly handlers: ReadonlySet<PackRuntimeEventHandler>
  readonly simulationRunId: PackRuntimeConnectionConfig['simulationRunId']
  readonly error: unknown
}): void => {
  const at = nowIso()
  emitPackRuntimeEvents(config.handlers, [{
    type: 'interaction.signal',
    at,
    provenance: { source: 'simulator', adapterId: processPlantSimAdapterId },
    signal: {
      id: `process-plant-runtime-failed:${randomUUID()}` as SignalId,
      simulationRunId: config.simulationRunId,
      at,
      source: { kind: 'simulation', id: processPlantSimRuntimeId },
      targets: [{ kind: 'broadcast' }],
      type: 'process-plant.runtime.failed',
      severity: 'critical',
      payload: {
        runtimeId: processPlantSimRuntimeId,
        message: config.error instanceof Error ? config.error.message : String(config.error),
      },
    },
  }])
}

export const createLocalProcessPlantPackRuntimeAdapter = (): PackRuntimeAdapter => ({
  id: processPlantSimRuntimeId,
  version: '1.0.0',
  packId: processPlantPackId,
  acceptedCommandKinds: [
    processPlantControlWriteCommandKind,
    processPlantControlRampCommandKind,
    processPlantIcLifecycleCommandKind,
  ],
  queryKinds: processPlantQueryKinds,
  connect: async (config: PackRuntimeConnectionConfig): Promise<PackRuntimeConnection> => {
    const handlers = new Set<PackRuntimeEventHandler>()
    const rawRuntimeState = await config.runtimeStateStore?.load()
    const runtimeState = rawRuntimeState === undefined || rawRuntimeState === null
      ? null
      : processPlantRuntimeStateSchema.parse(rawRuntimeState) as ProcessPlantRuntimeState
    const runtimeConfig = processPlantRuntimeConfigFor(config)
    const compiledSystems = compileProcessPlantSystems(config.scenario?.processSystems ?? [])
    assertRuntimeConfigMatchesCompiledSystems({
      runtimeConfig,
      systemIds: new Set(compiledSystems.map(system => system.id)),
    })
    const systems = createProcessPlantSystemRuntimes({
      compiledSystems,
      runtimeConfig,
      runtimeState,
    })
    const persistence = createProcessPlantRuntimePersistence({
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

    let runtimeFailureReason: string | null = null

    const advance = async (): Promise<void> => {
      if (runtimeFailureReason !== null) return
      const nowWallMs = Date.now()
      const elapsedMs = clock.paused ? 0 : Math.round((nowWallMs - lastTickWallMs) * clock.speed)
      lastTickWallMs = nowWallMs
      if (elapsedMs <= 0 || systems.size === 0) return
      const events: PackRuntimeEvent[] = []
      for (const { runtime, ramps, telemetry, protection, performance: runtimePerformance } of systems.values()) {
        const startedAt = performance.now()
        ramps.apply(runtime.elapsedMs() + elapsedMs)
        const tick = runtime.tick(elapsedMs)
        events.push(...(protection?.evaluate({
          runtime,
          elapsedMs: runtime.elapsedMs(),
          simulationRunId: config.simulationRunId,
          sourceRuntimeId: processPlantSimRuntimeId,
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
      emitPackRuntimeEvents(handlers, events)
      persistence.scheduleSave()
    }

    const interval = setInterval(() => {
      const runAdvance = async (): Promise<void> => {
        try {
          await advance()
        } catch (error) {
          runtimeFailureReason = error instanceof Error ? error.message : String(error)
          clearInterval(interval)
          emitRuntimeFailure({
            handlers,
            simulationRunId: config.simulationRunId,
            error,
          })
        }
      }
      void runAdvance()
    }, updateIntervalMs)

    return {
      getSnapshot: async () => ({
        simulationRunId: config.simulationRunId,
        objects: [...objectsById.values()],
        capturedAt: nowIso(),
      }),
      subscribe: (handler: PackRuntimeEventHandler): (() => void) => {
        handlers.add(handler)
        return () => {
          handlers.delete(handler)
        }
      },
      sendCommand: async (command: CommandEnvelope): Promise<CommandResult> => {
        const acceptedAt = nowIso()
        if (runtimeFailureReason !== null) {
          return { ok: false, commandId: command.id, rejectedAt: acceptedAt, reason: `process plant runtime has stopped after a runtime failure: ${runtimeFailureReason}` }
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
              simulationRunId: config.simulationRunId,
              sourceRuntimeId: processPlantSimRuntimeId,
              actorId: command.actorId,
              ...(command.clientId === undefined ? {} : { clientId: command.clientId }),
              ...(payload.data.reason === undefined ? {} : { reason: payload.data.reason }),
              ...(payload.data.shelveDurationMs === undefined ? {} : { shelveDurationMs: payload.data.shelveDurationMs }),
            })
            emitPackRuntimeEvents(handlers, events)
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
        if (command.kind === processPlantControlRampCommandKind) {
          const payload = processPlantControlRampPayloadSchema.safeParse(command.payload)
          if (!payload.success) return { ok: false, commandId: command.id, rejectedAt: acceptedAt, reason: payload.error.message }
          const system = systems.get(payload.data.systemId)
          if (!system) return { ok: false, commandId: command.id, rejectedAt: acceptedAt, reason: `process plant system not found: ${payload.data.systemId}` }
          const validation = validateProcessPlantControlWrite({
            system: system.system,
            runtime: system.runtime,
            ...(system.protection === undefined ? {} : { protection: system.protection }),
            payload: {
              systemId: payload.data.systemId,
              ...(payload.data.path === undefined ? {} : { path: payload.data.path }),
              ...(payload.data.tagId === undefined ? {} : { tagId: payload.data.tagId }),
              value: payload.data.targetValue,
            },
          })
          if (!validation.accepted) return { ok: false, commandId: command.id, rejectedAt: acceptedAt, reason: validation.reason }
          system.ramps.start({
            id: command.id,
            path: validation.targetPath,
            target: payload.data.targetValue,
            durationMs: payload.data.durationSeconds * 1_000,
          })
          await persistence.saveNow()
          return { ok: true, commandId: command.id, acceptedAt }
        }
        if (command.kind !== processPlantControlWriteCommandKind) {
          return {
            ok: false,
            commandId: command.id,
            rejectedAt: acceptedAt,
            reason: `process plant runtime does not accept command kind: ${command.kind}`,
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
        if (runtimeFailureReason !== null) return fail(request, `process plant runtime has stopped after a runtime failure: ${runtimeFailureReason}`)
        if (systems.size === 0) return fail(request, 'process plant runtime is not active for this scenario')
        return answerProcessPlantQuery({
          request,
          systems,
          at: nowIso(),
        })
      },
      observeCommittedEvents: async (events: ReadonlyArray<SimulationRunEvent>): Promise<void> => {
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
