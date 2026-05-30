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
import { defaultControlInstanceRuntimePolicy } from '../../../core/control-instances/runtime-persistence-policy.ts'
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
import { norwayGridArenaTopology } from '../arena/norway-grid-arena.ts'
import { solveGrid, type GridRuntimeState, type GridSolverTopology } from '../runtime/solver.ts'

const updateIntervalMs = 2_000
const runtimeStateFlushIntervalMs = defaultControlInstanceRuntimePolicy.runtimePrivateStateFlushIntervalMs
const projectedChangeThresholds = {
  branchFlowMw: 50,
  branchLoadingPercent: 5,
  branchFrequencyHz: 0.05,
  generatorMw: 1,
  loadMw: 2,
  shedMw: 1,
  loadFrequencyHz: 0.02,
  substationVoltagePu: 0.002,
  substationLoadingPercent: 2,
  storageMw: 1,
  stateOfChargeFraction: 0.005,
  marketAreaMw: 10,
} as const

const targetMwSchema = z.object({ targetMw: z.number().finite().nonnegative() })
const availabilitySchema = z.object({ availableMw: z.number().finite().nonnegative() })
const derateSchema = z.object({ availability: z.number().finite().min(0.05).max(1) })
const shedLoadSchema = z.object({ shedMw: z.number().finite().nonnegative() })
const evPolicySchema = z.object({ demandMw: z.number().finite().nonnegative() })
const persistedRuntimeStateSchema = z.object({
  runtimeState: z.object({
    tick: z.number().int().nonnegative(),
    frequencyHz: z.number().finite(),
  }),
})
const runtimeConfigSchema = z.object({
  topology: z.object({
    kind: z.literal('built-in'),
    arenaId: z.literal('source-derived-oslofjord-grid'),
  }).optional(),
}).default({})

const topologyForRuntimeConfig = (runtimeConfig: unknown): GridSolverTopology | null => {
  const parsed = runtimeConfigSchema.parse(runtimeConfig ?? {})
  if (parsed.topology?.kind !== 'built-in') return null
  return norwayGridArenaTopology()
}

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

const changedByAtLeast = (left: number, right: number, threshold: number): boolean =>
  Math.abs(left - right) >= threshold

const projectedGridChangeIsMeaningful = (
  previous: ElectricGridPackData,
  next: ElectricGridPackData,
): boolean => {
  if (previous.type !== next.type) return true
  if (next.type === 'grid_system') return true
  if (previous.type === 'grid_branch' && next.type === 'grid_branch') {
    return previous.state !== next.state
      || changedByAtLeast(previous.flowMw, next.flowMw, projectedChangeThresholds.branchFlowMw)
      || changedByAtLeast(previous.loadingPercent, next.loadingPercent, projectedChangeThresholds.branchLoadingPercent)
      || changedByAtLeast(previous.frequencyHz, next.frequencyHz, projectedChangeThresholds.branchFrequencyHz)
  }
  if (previous.type === 'grid_generator' && next.type === 'grid_generator') {
    return previous.state !== next.state
      || changedByAtLeast(previous.dispatchMw, next.dispatchMw, projectedChangeThresholds.generatorMw)
      || changedByAtLeast(previous.availableMw, next.availableMw, projectedChangeThresholds.generatorMw)
      || changedByAtLeast(previous.targetMw, next.targetMw, projectedChangeThresholds.generatorMw)
  }
  if (previous.type === 'grid_load' && next.type === 'grid_load') {
    return previous.serviceState !== next.serviceState
      || changedByAtLeast(previous.demandMw, next.demandMw, projectedChangeThresholds.loadMw)
      || changedByAtLeast(previous.servedMw, next.servedMw, projectedChangeThresholds.loadMw)
      || changedByAtLeast(previous.shedMw, next.shedMw, projectedChangeThresholds.shedMw)
      || changedByAtLeast(previous.frequencyHz, next.frequencyHz, projectedChangeThresholds.loadFrequencyHz)
  }
  if (previous.type === 'grid_substation' && next.type === 'grid_substation') {
    return previous.state !== next.state
      || changedByAtLeast(previous.voltagePu, next.voltagePu, projectedChangeThresholds.substationVoltagePu)
      || changedByAtLeast(previous.loadingPercent, next.loadingPercent, projectedChangeThresholds.substationLoadingPercent)
      || changedByAtLeast(previous.connectedBranchCount, next.connectedBranchCount, 1)
  }
  if (previous.type === 'grid_storage' && next.type === 'grid_storage') {
    return previous.state !== next.state
      || changedByAtLeast(previous.dispatchMw, next.dispatchMw, projectedChangeThresholds.storageMw)
      || changedByAtLeast(
        previous.stateOfChargeFraction,
        next.stateOfChargeFraction,
        projectedChangeThresholds.stateOfChargeFraction,
      )
  }
  if (previous.type === 'grid_market_area' && next.type === 'grid_market_area') {
    return previous.constrained !== next.constrained
      || changedByAtLeast(previous.generationMw, next.generationMw, projectedChangeThresholds.marketAreaMw)
      || changedByAtLeast(previous.loadMw, next.loadMw, projectedChangeThresholds.marketAreaMw)
      || changedByAtLeast(previous.netExportMw, next.netExportMw, projectedChangeThresholds.marketAreaMw)
  }
  return JSON.stringify(previous) !== JSON.stringify(next)
}

const shouldEmitProjectedObjectUpdate = (
  previous: OperationalObject | undefined,
  next: OperationalObject,
): boolean => {
  if (!previous) return true
  if (previous.revision === next.revision) return false
  const previousData = electricGridPackDataSchema.safeParse(previous.packData)
  const nextData = electricGridPackDataSchema.safeParse(next.packData)
  if (!previousData.success || !nextData.success) return true
  return projectedGridChangeIsMeaningful(previousData.data, nextData.data)
}

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
    const nominalDemandMw = data.data.nominalDemandMw ?? data.data.demandMw
    const shedMw = Math.min(data.data.nominalInterruptibleMw ?? data.data.interruptibleMw, payload.shedMw)
    const nextNominalDemandMw = Math.max(data.data.criticalMw, nominalDemandMw - shedMw)
    return updatedWithPackData(object, {
      ...data.data,
      nominalDemandMw: nextNominalDemandMw,
      demandMw: nextNominalDemandMw,
      servedMw: nextNominalDemandMw,
      shedMw,
      serviceState: shedMw > 0 ? 'shed' : data.data.serviceState,
    }, at)
  }
  if (command.kind === gridRestoreLoadCommandKind && data.data.type === 'grid_load') {
    const restoredDemandMw = data.data.criticalMw + (data.data.nominalInterruptibleMw ?? data.data.interruptibleMw)
    return updatedWithPackData(object, {
      ...data.data,
      nominalDemandMw: restoredDemandMw,
      demandMw: restoredDemandMw,
      shedMw: 0,
      serviceState: 'normal',
    }, at)
  }
  if (command.kind === gridSetEvChargingPolicyCommandKind && data.data.type === 'grid_load' && data.data.loadKind === 'ev_charging') {
    const payload = evPolicySchema.parse(command.payload)
    return updatedWithPackData(object, {
      ...data.data,
      nominalDemandMw: payload.demandMw,
      nominalInterruptibleMw: Math.max(0, payload.demandMw - data.data.criticalMw),
      demandMw: payload.demandMw,
      interruptibleMw: Math.max(0, payload.demandMw - data.data.criticalMw),
      servedMw: Math.min(payload.demandMw, data.data.servedMw),
    }, at)
  }
  return null
}

const currentSimulationTime = (clock: SimulationClockState | null): IsoTimestamp => {
  if (!clock) return nowIso()
  if (clock.paused) return clock.currentTime
  const currentTimeMs = Date.parse(clock.currentTime)
  const updatedAtMs = Date.parse(clock.updatedAt)
  if (!Number.isFinite(currentTimeMs) || !Number.isFinite(updatedAtMs)) return nowIso()
  return new Date(currentTimeMs + Math.max(0, Date.now() - updatedAtMs) * clock.speed).toISOString() as IsoTimestamp
}

export const createLocalElectricGridPackRuntimeAdapter = (): PackRuntimeAdapter => ({
  id: electricGridRuntimeId,
  packId: electricGridRuntimePackId,
  acceptedCommandKinds: electricGridCommandKinds,
  queryKinds: electricGridQueryKinds,
  connect: async (config: PackRuntimeConnectionConfig): Promise<PackRuntimeConnection> => {
    const topology = topologyForRuntimeConfig(config.scenario?.runtimeConfig)
    const runtimeStateStore = config.runtimeStateStore
    const restoredRuntimeState = runtimeStateStore
      ? persistedRuntimeStateSchema.parse(await runtimeStateStore.load() ?? { runtimeState: { tick: 0, frequencyHz: 50 } }).runtimeState
      : null
    const initialObjects = (config.initialObjects ?? config.scenario?.initialObjects ?? [])
      .filter(object => object.packId === electricGridRuntimePackId)
      .map(restoreGridObject)
    const objects = new Map(initialObjects.map(object => [object.id, object]))
    const handlers = new Set<PackRuntimeEventHandler>()
    let runtimeState: GridRuntimeState | null = restoredRuntimeState
      ? { ...restoredRuntimeState, busStates: new Map() }
      : null
    let closed = false
    let clock: SimulationClockState | null = null
    let interval: ReturnType<typeof setInterval> | null = null
    let runtimeStateSaveDirty = false
    let runtimeStateSaveTimer: ReturnType<typeof setTimeout> | null = null
    let runtimeStateSaveQueue: Promise<void> = Promise.resolve()

    const clearRuntimeStateSaveTimer = (): void => {
      if (runtimeStateSaveTimer === null) return
      clearTimeout(runtimeStateSaveTimer)
      runtimeStateSaveTimer = null
    }

    const queueRuntimeStateSave = async (): Promise<void> => {
      if (!runtimeStateStore || !runtimeState) return
      const payload = {
        runtimeState: {
          tick: runtimeState.tick,
          frequencyHz: runtimeState.frequencyHz,
        },
      }
      const currentSave = runtimeStateSaveQueue.then(async () => {
        await runtimeStateStore.save(payload)
      })
      runtimeStateSaveQueue = currentSave.catch(() => undefined)
      await currentSave
    }

    const scheduleRuntimeStateSave = (): void => {
      if (!runtimeStateStore || !runtimeState) return
      runtimeStateSaveDirty = true
      if (runtimeStateSaveTimer !== null) return
      runtimeStateSaveTimer = setTimeout(() => {
        runtimeStateSaveTimer = null
        if (!runtimeStateSaveDirty) return
        runtimeStateSaveDirty = false
        void queueRuntimeStateSave().catch(err => {
          console.error('electric-grid runtime state save failed:', err)
        })
      }, runtimeStateFlushIntervalMs)
      runtimeStateSaveTimer.unref?.()
    }

    const flushRuntimeStateSave = async (): Promise<void> => {
      clearRuntimeStateSaveTimer()
      if (runtimeStateSaveDirty) {
        runtimeStateSaveDirty = false
        await queueRuntimeStateSave()
        return
      }
      await runtimeStateSaveQueue
    }

    const solveAndEmit = (
      dtSeconds: number,
      persistence: PackRuntimeEventPersistence = 'projected',
    ): void => {
      if (closed || clock?.paused) return
      const at = currentSimulationTime(clock)
      const solved = solveGrid({ objects: [...objects.values()], runtimeState, topology, dtSeconds, at })
      runtimeState = solved.runtimeState
      const events: PackRuntimeEvent[] = []
      for (const next of solved.objects) {
        const previous = objects.get(next.id)
        objects.set(next.id, next)
        const shouldEmit = persistence === 'durable'
          ? (!previous || previous.revision !== next.revision)
          : shouldEmitProjectedObjectUpdate(previous, next)
        if (shouldEmit) {
          events.push({ type: 'object.upserted', object: next, at, provenance: next.provenance, persistence })
        }
      }
      scheduleRuntimeStateSave()
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
        await flushRuntimeStateSave()
      },
    }
  },
})

export { electricGridAdapterId, electricGridRuntimeId }
