import { z } from 'zod'
import type {
  CommandEnvelope,
  CommandResult,
  ControlInstanceEvent,
  IsoTimestamp,
  OperationalObject,
  SimulationClockState,
} from '../../../core/model/index.ts'
import { nowIso } from '../../../core/model/index.ts'
import type {
  PackRuntimeAdapter,
  PackRuntimeConnection,
  PackRuntimeConnectionConfig,
  PackRuntimeEvent,
  PackRuntimeEventHandler,
  PackRuntimeEventPersistence,
} from '../../../simulation/protocol.ts'
import type { PackQueryRequest, PackQueryResponse } from '../../../core/packs/protocol.ts'
import {
  electricGridCommandKinds,
  gridClearDerateCommandKind,
  gridCloseBranchCommandKind,
  gridDerateBranchCommandKind,
  gridDispatchGeneratorCommandKind,
  gridOpenBranchCommandKind,
  gridRestoreLoadCommandKind,
  gridSetEvChargingPolicyCommandKind,
  gridSetGeneratorAvailabilityCommandKind,
  gridShedLoadCommandKind,
  gridTripGeneratorCommandKind,
} from '../commands.ts'
import { answerElectricGridQuery, electricGridQueryKinds } from '../query.ts'
import { electricGridAdapterId, electricGridRuntimeId, electricGridRuntimePackId } from './constants.ts'
import { electricGridPackDataSchema, type ElectricGridPackData } from '../model.ts'
import { solveGrid, type GridRuntimeState } from '../runtime/solver.ts'

const updateIntervalMs = 2_000

const targetMwSchema = z.object({ targetMw: z.number().finite().nonnegative() })
const availabilitySchema = z.object({ availableMw: z.number().finite().nonnegative() })
const derateSchema = z.object({ availability: z.number().finite().min(0.05).max(1) })
const shedLoadSchema = z.object({ shedMw: z.number().finite().nonnegative() })
const evPolicySchema = z.object({ demandMw: z.number().finite().nonnegative() })

const restoreGridObject = (object: OperationalObject): OperationalObject => {
  const parsed = electricGridPackDataSchema.safeParse(object.packData)
  if (!parsed.success) throw new Error(`invalid restored electric-grid object ${object.id}: ${parsed.error.message}`)
  return { ...object, packData: parsed.data }
}

const emit = (
  handlers: ReadonlySet<PackRuntimeEventHandler>,
  events: ReadonlyArray<PackRuntimeEvent>,
  at: IsoTimestamp,
): void => {
  if (events.length === 0) return
  for (const handler of handlers) {
    handler({
      type: 'event.emission',
      runtimeId: electricGridRuntimeId,
      emittedAt: at,
      events,
    })
  }
}

const commandAccepted = (command: CommandEnvelope, acceptedAt: IsoTimestamp): CommandResult => ({
  ok: true,
  commandId: command.id,
  acceptedAt,
})

const commandRejected = (command: CommandEnvelope, rejectedAt: IsoTimestamp, reason: string): CommandResult => ({
  ok: false,
  commandId: command.id,
  rejectedAt,
  reason,
})

const updatedWithPackData = (
  object: OperationalObject,
  data: ElectricGridPackData,
  at: IsoTimestamp,
): OperationalObject => ({
  ...object,
  revision: object.revision + 1,
  timestamps: { ...object.timestamps, updatedAt: at },
  packData: data,
})

const applyCommandToObject = (
  object: OperationalObject,
  command: CommandEnvelope,
  at: IsoTimestamp,
): OperationalObject | null => {
  const data = electricGridPackDataSchema.safeParse(object.packData)
  if (!data.success) return null
  if (command.kind === gridDispatchGeneratorCommandKind && data.data.type === 'grid_generator') {
    const payload = targetMwSchema.parse(command.payload)
    return updatedWithPackData(object, { ...data.data, targetMw: Math.min(payload.targetMw, data.data.availableMw) }, at)
  }
  if (command.kind === gridTripGeneratorCommandKind && data.data.type === 'grid_generator') {
    return updatedWithPackData(object, { ...data.data, state: 'tripped', targetMw: 0, dispatchMw: 0, availableMw: 0 }, at)
  }
  if (command.kind === gridSetGeneratorAvailabilityCommandKind && data.data.type === 'grid_generator') {
    const payload = availabilitySchema.parse(command.payload)
    return updatedWithPackData(object, { ...data.data, availableMw: Math.min(payload.availableMw, data.data.capacityMw), state: payload.availableMw > 0 ? 'online' : 'offline' }, at)
  }
  if (command.kind === gridOpenBranchCommandKind && data.data.type === 'grid_branch') {
    return updatedWithPackData(object, { ...data.data, state: 'open', flowMw: 0, loadingPercent: 0 }, at)
  }
  if (command.kind === gridCloseBranchCommandKind && data.data.type === 'grid_branch') {
    return updatedWithPackData(object, { ...data.data, state: 'closed', availability: 1 }, at)
  }
  if (command.kind === gridDerateBranchCommandKind && data.data.type === 'grid_branch') {
    const payload = derateSchema.parse(command.payload)
    return updatedWithPackData(object, { ...data.data, state: 'derated', availability: payload.availability }, at)
  }
  if (command.kind === gridClearDerateCommandKind && data.data.type === 'grid_branch') {
    return updatedWithPackData(object, { ...data.data, state: 'closed', availability: 1 }, at)
  }
  if (command.kind === gridShedLoadCommandKind && data.data.type === 'grid_load') {
    const payload = shedLoadSchema.parse(command.payload)
    const shedMw = Math.min(data.data.interruptibleMw, payload.shedMw)
    return updatedWithPackData(object, {
      ...data.data,
      demandMw: Math.max(data.data.criticalMw, data.data.demandMw - shedMw),
      servedMw: Math.max(data.data.criticalMw, data.data.demandMw - shedMw),
      shedMw,
      serviceState: shedMw > 0 ? 'shed' : data.data.serviceState,
    }, at)
  }
  if (command.kind === gridRestoreLoadCommandKind && data.data.type === 'grid_load') {
    return updatedWithPackData(object, { ...data.data, demandMw: data.data.criticalMw + data.data.interruptibleMw, shedMw: 0, serviceState: 'normal' }, at)
  }
  if (command.kind === gridSetEvChargingPolicyCommandKind && data.data.type === 'grid_load' && data.data.loadKind === 'ev_charging') {
    const payload = evPolicySchema.parse(command.payload)
    return updatedWithPackData(object, {
      ...data.data,
      demandMw: payload.demandMw,
      interruptibleMw: Math.max(0, payload.demandMw - data.data.criticalMw),
      servedMw: Math.min(payload.demandMw, data.data.servedMw),
    }, at)
  }
  return null
}

export const createLocalElectricGridPackRuntimeAdapter = (): PackRuntimeAdapter => ({
  id: electricGridRuntimeId,
  packId: electricGridRuntimePackId,
  acceptedCommandKinds: electricGridCommandKinds,
  queryKinds: electricGridQueryKinds,
  connect: async (config: PackRuntimeConnectionConfig): Promise<PackRuntimeConnection> => {
    const initialObjects = (config.initialObjects ?? config.scenario?.initialObjects ?? [])
      .filter(object => object.packId === electricGridRuntimePackId)
      .map(restoreGridObject)
    const objects = new Map(initialObjects.map(object => [object.id, object]))
    const handlers = new Set<PackRuntimeEventHandler>()
    let runtimeState: GridRuntimeState | null = null
    let closed = false
    let clock: SimulationClockState | null = null
    let interval: ReturnType<typeof setInterval> | null = null

    const solveAndEmit = (
      dtSeconds: number,
      persistence: PackRuntimeEventPersistence = 'projected',
    ): void => {
      if (closed || clock?.paused) return
      const at = nowIso()
      const solved = solveGrid({ objects: [...objects.values()], runtimeState, dtSeconds, at })
      runtimeState = solved.runtimeState
      const events: PackRuntimeEvent[] = []
      for (const next of solved.objects) {
        const previous = objects.get(next.id)
        objects.set(next.id, next)
        if (!previous || previous.revision !== next.revision) {
          events.push({ type: 'object.upserted', object: next, at, provenance: next.provenance, persistence })
        }
      }
      void config.runtimeStateStore?.save({
        runtimeState: {
          tick: runtimeState.tick,
          frequencyHz: runtimeState.frequencyHz,
        },
      })
      emit(handlers, events, at)
    }

    solveAndEmit(1, 'projected')
    interval = setInterval(() => solveAndEmit(updateIntervalMs / 1000, 'projected'), updateIntervalMs)

    return {
      getSnapshot: async () => ({
        controlInstanceId: config.controlInstanceId,
        objects: [...objects.values()],
        capturedAt: nowIso(),
      }),
      subscribe: (handler) => {
        handlers.add(handler)
        return () => {
          handlers.delete(handler)
        }
      },
      sendCommand: async (command: CommandEnvelope): Promise<CommandResult> => {
        const acceptedAt = nowIso()
        if (!electricGridCommandKinds.includes(command.kind as typeof electricGridCommandKinds[number])) {
          return commandRejected(command, acceptedAt, `electric-grid runtime does not accept command kind: ${command.kind}`)
        }
        const targets = command.targetObjectIds.length > 0 ? command.targetObjectIds : [...objects.keys()]
        const commandEvents: PackRuntimeEvent[] = []
        try {
          for (const targetId of targets) {
            const object = objects.get(targetId)
            if (!object) continue
            const next = applyCommandToObject(object, command, acceptedAt)
            if (!next) continue
            objects.set(next.id, next)
            commandEvents.push({
              type: 'object.upserted',
              object: next,
              at: acceptedAt,
              provenance: { source: 'operator', causedByCommandId: command.id },
              persistence: 'durable',
            })
          }
        } catch (err) {
          return commandRejected(command, acceptedAt, err instanceof Error ? err.message : String(err))
        }
        emit(handlers, commandEvents, acceptedAt)
        solveAndEmit(1, 'projected')
        return commandAccepted(command, acceptedAt)
      },
      query: async (request: PackQueryRequest): Promise<PackQueryResponse> =>
        answerElectricGridQuery({ request, objects: [...objects.values()] }),
      observeCommittedEvents: async (events: ReadonlyArray<ControlInstanceEvent>): Promise<void> => {
        for (const event of events) {
          if (event.type === 'object.upserted' && event.object.packId === electricGridRuntimePackId) {
            objects.set(event.object.id, restoreGridObject(event.object))
          }
          if (event.type === 'object.deleted') objects.delete(event.objectId)
        }
      },
      setClock: async (nextClock: SimulationClockState): Promise<void> => {
        clock = nextClock
      },
      close: async (): Promise<void> => {
        closed = true
        handlers.clear()
        if (interval) clearInterval(interval)
      },
    }
  },
})

export { electricGridAdapterId, electricGridRuntimeId }
