import { z } from 'zod'
import type { CommandEnvelope, CommandResult, DomainEvent, SimulationClockState } from '../../../core/model/index.ts'
import { nowIso } from '../../../core/model/index.ts'
import type {
  SimulationAdapter,
  SimulationConnection,
  SimulationConnectionConfig,
  SimulationEventHandler,
} from '../../../simulation/protocol.ts'
import type { PackQueryRequest, PackQueryResponse } from '../../../core/packs/protocol.ts'
import { processPlantControlWriteCommandKind, processPlantControlWritePayloadSchema } from '../commands.ts'
import { compileProcessPlantSystems } from '../process-systems.ts'
import { createProcessPlantRuntime } from '../runtime/index.ts'
import {
  createProcessPlantScheduleRunner,
  createProcessPlantTelemetryRecorder,
  processPlantScheduleConfigSchema,
  processPlantScheduleSnapshotSchema,
  processPlantTelemetryConfigSchema,
  processPlantTelemetrySnapshotSchema,
  type ProcessPlantRuntimeSnapshot,
  type ProcessPlantScheduleConfig,
  type ProcessPlantScheduleSnapshot,
  type ProcessPlantTelemetryConfig,
  type ProcessPlantTelemetryRecorder,
  type ProcessPlantTelemetrySnapshot,
} from '../runtime/index.ts'
import {
  processQuantitySchema,
  processUnitSchema,
  processVariableValueSchema,
  variableKindSchema,
  variablePathSchema,
  variableDomainSchema,
} from '../graph/index.ts'
import { answerProcessPlantQuery, type ProcessPlantSystemRuntime } from '../query.ts'
import { processPlantDomainId, processPlantSimProviderId } from './constants.ts'

const processPlantVariableSnapshotSchema = z.object({
  path: variablePathSchema,
  value: processVariableValueSchema,
  canonicalValue: processVariableValueSchema,
  quantity: processQuantitySchema,
  unit: processUnitSchema,
  domain: variableDomainSchema,
  kind: variableKindSchema,
  writable: z.boolean(),
  published: z.boolean(),
})

const processPlantRuntimeSnapshotSchema = z.object({
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
  })),
})

interface ProcessPlantProviderState {
  readonly schemaVersion: 1
  readonly systems: ReadonlyArray<{
    readonly systemId: string
    readonly runtime: ProcessPlantRuntimeSnapshot
    readonly schedule?: ProcessPlantScheduleSnapshot
    readonly telemetry?: ProcessPlantTelemetrySnapshot
  }>
}

const processPlantProviderSystemConfigSchema = z.object({
  schedule: processPlantScheduleConfigSchema.optional(),
  telemetry: processPlantTelemetryConfigSchema.optional(),
}).strict()

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
  systems: [...systems.values()].map(({ system, runtime, schedule, telemetry }) => ({
    systemId: system.id,
    runtime: runtime.snapshot(),
    schedule: schedule.snapshot(),
    ...(telemetry === undefined ? {} : { telemetry: telemetry.snapshot() }),
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

const processPlantProviderConfigFor = (config: SimulationConnectionConfig): ProcessPlantProviderConfig => {
  const rawConfig = config.scenario?.providerConfigs?.['process-plant'] ?? {}
  return processPlantProviderConfigSchema.parse(rawConfig)
}

const saveProviderState = async (
  config: SimulationConnectionConfig,
  systems: ReadonlyMap<string, ProcessPlantSystemRuntime>,
): Promise<void> => {
  if (!config.providerStateStore || systems.size === 0) return
  await config.providerStateStore.save(providerStateFor(systems))
}

export const createLocalProcessPlantSimulationAdapter = (): SimulationAdapter => ({
  id: processPlantSimProviderId,
  packId: 'process-plant',
  domain: processPlantDomainId,
  acceptedCommandKinds: [processPlantControlWriteCommandKind],
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
        return {
          system,
          runtime,
          schedule: createProcessPlantScheduleRunner({
            system,
            ...(scheduleConfig === undefined ? {} : { schedule: scheduleConfig }),
            ...(restoredSchedule === undefined ? {} : { restoredSnapshot: restoredSchedule }),
          }),
          ...(telemetry === undefined ? {} : { telemetry }),
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

    await saveProviderState(config, systems)

    const advance = async (): Promise<void> => {
      const nowWallMs = Date.now()
      const elapsedMs = clock.paused ? 0 : Math.round((nowWallMs - lastTickWallMs) * clock.speed)
      lastTickWallMs = nowWallMs
      if (elapsedMs <= 0 || systems.size === 0) return
      for (const { runtime, schedule, telemetry } of systems.values()) {
        schedule.applyDueActions(runtime, runtime.snapshot().elapsedMs + elapsedMs)
        runtime.tick(elapsedMs)
        telemetry?.recordDueSamples(runtime)
      }
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
        objects: [],
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
          system.runtime.writeCommand({
            type: 'setVariable',
            path: payload.data.path,
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
      observeCommittedEvents: async (_events: ReadonlyArray<DomainEvent>): Promise<void> => {},
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
