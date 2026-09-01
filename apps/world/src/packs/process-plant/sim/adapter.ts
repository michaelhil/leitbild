import { randomUUID } from 'node:crypto'
import type { CommandEnvelope, CommandResult, IsoTimestamp, PackRuntimeRecordingBatch, SimulationRunEvent, ObjectId, OperationalObject, SignalId, SimulationClockState } from '../../../core/model/index.ts'
import { nowIso } from '../../../core/model/index.ts'
import type {
  PackRuntimeAdapter,
  PackRuntimeConnection,
  PackRuntimeConnectionConfig,
  PackRuntimeEvent,
  PackRuntimeEventHandler,
} from '../../../simulation/protocol.ts'
import { definePackRuntimeOperations } from '../../../simulation/operations.ts'
import type { PackQueryRequest, PackQueryResponse } from '../../../core/packs/protocol.ts'
import {
  processPlantControlRampCommandKind,
  processPlantControlRampPayloadSchema,
  processPlantControlWriteCommandKind,
  processPlantControlWritePayloadSchema,
  processPlantIcLifecycleCommandKind,
  processPlantIcLifecyclePayloadSchema,
  processPlantActionInvokeCommandKind,
  processPlantActionInvokePayloadSchema,
} from '../commands.ts'
import { commandsForProcessPlantAction } from '../actions.ts'
import { processPlantDefinitionSchema, type ProcessPlantDefinition } from '../config.ts'
import { createProcessPlantRecordingPlan } from '../recording.ts'
import { compileProcessPlants } from '../plant-compiler.ts'
import { validateProcessPlantControlWrite } from '../control-write-validation.ts'
import { processPlantIdForObject, processPlantPackId, processPlantUnitPackDataSchema } from '../model.ts'
import { answerProcessPlantQuery, processPlantQueryKinds } from '../query.ts'
import type { ProcessPlantRuntimeInstance } from '../runtime-instance.ts'
import { processPlantSimAdapterId, processPlantSimRuntimeId } from './constants.ts'
import {
  processPlantRuntimeStateSchema,
  type ProcessPlantRuntimeState,
} from './runtime-state.ts'
import {
  initialProcessPlantObjects,
  processPlantProjectionEvents,
  projectedInitialProcessPlantObjects,
} from './object-projection.ts'
import { createProcessPlantRuntimePersistence } from './persistence.ts'
import { createProcessPlantRuntimeInstances } from './runtime-instance-factory.ts'

const updateIntervalMs = 1_000

const processPlantDefinitionsFor = (
  objects: ReadonlyArray<OperationalObject>,
): ReadonlyArray<ProcessPlantDefinition> => objects.flatMap(object => {
  if (object.packId !== processPlantPackId) return []
  const data = processPlantUnitPackDataSchema.parse(object.packData)
  return [processPlantDefinitionSchema.parse({
    id: object.id,
    model: data.model,
    operatingPoint: data.operatingPoint,
    automation: data.automation,
  })]
})

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
  recording?: PackRuntimeRecordingBatch,
): void => {
  if (events.length === 0 && recording === undefined) return
  const emittedAt = nowIso()
  for (const handler of handlers) {
    handler({
      type: 'event.emission',
      events,
      ...(recording === undefined ? {} : { recording }),
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
  clock: 'simulation',
  operations: definePackRuntimeOperations({
    commands: [processPlantControlWriteCommandKind, processPlantControlRampCommandKind, processPlantIcLifecycleCommandKind, processPlantActionInvokeCommandKind],
    queries: processPlantQueryKinds,
  }),
  connect: async (config: PackRuntimeConnectionConfig): Promise<PackRuntimeConnection> => {
    const handlers = new Set<PackRuntimeEventHandler>()
    const rawRuntimeState = await config.runtimeStateStore?.load()
    const runtimeState = rawRuntimeState === undefined || rawRuntimeState === null
      ? null
      : processPlantRuntimeStateSchema.parse(rawRuntimeState) as ProcessPlantRuntimeState
    const initialObjects = initialProcessPlantObjects(config)
    const compiledPlants = compileProcessPlants(processPlantDefinitionsFor(initialObjects))
    const plants = createProcessPlantRuntimeInstances({
      compiledPlants,
      runtimeState,
    })
    const persistence = createProcessPlantRuntimePersistence({
      connection: config,
      plants,
    })
    if (config.recording?.packId !== undefined && config.recording.packId !== processPlantPackId) {
      throw new Error(`process plant runtime received recording selection for Pack ${config.recording.packId}`)
    }
    const recordingPlan = config.recording === undefined
      ? null
      : createProcessPlantRecordingPlan({ selection: config.recording, plants })
    let recordingDescriptorsPending = recordingPlan !== null
    let nextRecordingElapsedMs = recordingPlan?.intervalMs ?? Number.POSITIVE_INFINITY
    let clock: SimulationClockState = {
      currentTime: config.scenario?.world.startsAt ?? nowIso(),
      updatedAt: nowIso(),
      paused: false,
      speed: 1,
    }
    let lastTickWallMs = Date.now()
    let simulationTimeOffsetMs = Date.parse(clock.currentTime)
    const objectsById = new Map<ObjectId, OperationalObject>(
      projectedInitialProcessPlantObjects({
        objects: initialObjects,
        plants,
        at: nowIso(),
      }).map(object => [object.id, object]),
    )

    let runtimeFailureReason: string | null = null

    const advance = async (): Promise<void> => {
      if (runtimeFailureReason !== null) return
      const nowWallMs = Date.now()
      const elapsedMs = clock.paused ? 0 : Math.round((nowWallMs - lastTickWallMs) * clock.speed)
      lastTickWallMs = nowWallMs
      if (elapsedMs <= 0 || plants.size === 0) return
      const events: PackRuntimeEvent[] = []
      for (const { runtime, ramps, protection, performance: runtimePerformance } of plants.values()) {
        const startedAt = performance.now()
        ramps.apply(runtime.elapsedMs() + elapsedMs)
        const tick = runtime.tick(elapsedMs)
        events.push(...(protection?.evaluate({
          runtime,
          elapsedMs: runtime.elapsedMs(),
          simulationRunId: config.simulationRunId,
          sourceRuntimeId: processPlantSimRuntimeId,
        }) ?? []))
        runtimePerformance.record({
          wallMs: performance.now() - startedAt,
          simulatedMs: tick.simulatedMs,
        })
      }
      events.push(...processPlantProjectionEvents({
        objectsById,
        plants,
        at: nowIso(),
        provenance: {
          source: 'simulator',
          adapterId: processPlantSimAdapterId,
        },
      }))
      const recordedElapsedMs = Math.min(...[...plants.values()].map(plant => plant.runtime.elapsedMs()))
      const recording = recordingPlan !== null && recordedElapsedMs >= nextRecordingElapsedMs
        ? (() => {
            nextRecordingElapsedMs = recordedElapsedMs + recordingPlan.intervalMs
            const sampled = recordingPlan.sample({
              observedAt: nowIso(),
              simulationTime: new Date(simulationTimeOffsetMs + recordedElapsedMs).toISOString() as IsoTimestamp,
            })
            if (!recordingDescriptorsPending) return sampled
            recordingDescriptorsPending = false
            return { ...sampled, descriptors: [...recordingPlan.descriptors] }
          })()
        : undefined
      emitPackRuntimeEvents(handlers, events, recording)
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
        if (command.kind === processPlantActionInvokeCommandKind) {
          const payload = processPlantActionInvokePayloadSchema.safeParse(command.payload)
          if (!payload.success) return { ok: false, commandId: command.id, rejectedAt: acceptedAt, reason: payload.error.message }
          const plant = plants.get(payload.data.plantId)
          if (!plant) return { ok: false, commandId: command.id, rejectedAt: acceptedAt, reason: `process plant not found: ${payload.data.plantId}` }
          try {
            const commands = commandsForProcessPlantAction({
              actionId: payload.data.actionId,
              parameters: payload.data.parameters,
              graph: plant.plant.graph,
            })
            const validated = commands.map(actionCommand => {
              const result = validateProcessPlantControlWrite({
                system: plant.plant,
                runtime: plant.runtime,
                ...(plant.protection === undefined ? {} : { protection: plant.protection }),
                payload: {
                  plantId: payload.data.plantId,
                  path: actionCommand.path,
                  value: actionCommand.value,
                },
              })
              if (!result.accepted) throw new Error(result.reason)
              return { type: 'setVariable' as const, path: result.targetPath, value: actionCommand.value }
            })
            for (const actionCommand of validated) plant.runtime.writeCommand(actionCommand)
            await persistence.saveNow()
            return { ok: true, commandId: command.id, acceptedAt }
          } catch (err) {
            return { ok: false, commandId: command.id, rejectedAt: acceptedAt, reason: err instanceof Error ? err.message : String(err) }
          }
        }
        if (command.kind === processPlantIcLifecycleCommandKind) {
          const payload = processPlantIcLifecyclePayloadSchema.safeParse(command.payload)
          if (!payload.success) return { ok: false, commandId: command.id, rejectedAt: acceptedAt, reason: payload.error.message }
          const plant = plants.get(payload.data.plantId)
          if (!plant) return { ok: false, commandId: command.id, rejectedAt: acceptedAt, reason: `process plant not found: ${payload.data.plantId}` }
          if (!plant.protection) return { ok: false, commandId: command.id, rejectedAt: acceptedAt, reason: `process plant I&C is not configured for plant: ${payload.data.plantId}` }
          try {
            const events = plant.protection.applyLifecycleAction({
              id: payload.data.lifecycleId,
              action: payload.data.action,
              elapsedMs: plant.runtime.elapsedMs(),
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
          const plant = plants.get(payload.data.plantId)
          if (!plant) return { ok: false, commandId: command.id, rejectedAt: acceptedAt, reason: `process plant not found: ${payload.data.plantId}` }
          const validation = validateProcessPlantControlWrite({
            system: plant.plant,
            runtime: plant.runtime,
            ...(plant.protection === undefined ? {} : { protection: plant.protection }),
            payload: {
              plantId: payload.data.plantId,
              ...(payload.data.path === undefined ? {} : { path: payload.data.path }),
              ...(payload.data.tagId === undefined ? {} : { tagId: payload.data.tagId }),
              value: payload.data.targetValue,
            },
          })
          if (!validation.accepted) return { ok: false, commandId: command.id, rejectedAt: acceptedAt, reason: validation.reason }
          plant.ramps.start({
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
        const plant = plants.get(payload.data.plantId)
        if (!plant) return { ok: false, commandId: command.id, rejectedAt: acceptedAt, reason: `process plant not found: ${payload.data.plantId}` }
        try {
          const validation = validateProcessPlantControlWrite({
            system: plant.plant,
            runtime: plant.runtime,
            ...(plant.protection === undefined ? {} : { protection: plant.protection }),
            payload: payload.data,
          })
          if (!validation.accepted) return { ok: false, commandId: command.id, rejectedAt: acceptedAt, reason: validation.reason }
          plant.runtime.writeCommand({
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
        if (plants.size === 0) return fail(request, 'process plant runtime is not active for this scenario')
        return answerProcessPlantQuery({
          request,
          plants,
          at: nowIso(),
        })
      },
      observeCommittedEvents: async (events: ReadonlyArray<SimulationRunEvent>): Promise<void> => {
        for (const event of events) {
          if (event.type === 'object.upserted' && processPlantIdForObject(event.object) !== null) {
            objectsById.set(event.object.id, event.object)
          }
          if (event.type === 'object.deleted') objectsById.delete(event.objectId)
        }
      },
      setClock: async (nextClock: SimulationClockState): Promise<void> => {
        clock = nextClock
        lastTickWallMs = Date.now()
        const elapsedMs = plants.size === 0 ? 0 : Math.min(...[...plants.values()].map(plant => plant.runtime.elapsedMs()))
        simulationTimeOffsetMs = Date.parse(nextClock.currentTime) - elapsedMs
      },
      close: async (): Promise<void> => {
        clearInterval(interval)
        await persistence.saveNow()
        handlers.clear()
      },
    }
  },
})
