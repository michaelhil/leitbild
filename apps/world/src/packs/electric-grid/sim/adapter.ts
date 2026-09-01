import type {
  CommandEnvelope,
  CommandResult,
  IsoTimestamp,
  ObjectId,
  OperationalObject,
  PackRuntimeRecordingBatch,
  SimulationClockState,
  SimulationRunEvent,
} from '../../../core/model/index.ts'
import { nowIso } from '../../../core/model/index.ts'
import type { PackQueryRequest, PackQueryResponse } from '../../../core/packs/protocol.ts'
import type {
  PackRuntimeAdapter,
  PackRuntimeConnection,
  PackRuntimeConnectionConfig,
  PackRuntimeEvent,
  PackRuntimeEventHandler,
  PackRuntimeEventHistory,
} from '../../../simulation/protocol.ts'
import {
  electricGridCommandKinds,
  electricGridCommandOperations,
  gridClearDerateCommandKind,
  gridClearDeratePayloadSchema,
  gridCloseBranchCommandKind,
  gridCloseBranchPayloadSchema,
  gridDerateBranchCommandKind,
  gridDerateBranchPayloadSchema,
  gridDispatchGeneratorCommandKind,
  gridDispatchGeneratorPayloadSchema,
  gridOpenBranchCommandKind,
  gridOpenBranchPayloadSchema,
  gridRestoreLoadCommandKind,
  gridRestoreLoadPayloadSchema,
  gridSetEvChargingPolicyCommandKind,
  gridSetEvChargingPolicyPayloadSchema,
  gridSetGeneratorAvailabilityCommandKind,
  gridSetGeneratorAvailabilityPayloadSchema,
  gridShedLoadCommandKind,
  gridShedLoadPayloadSchema,
  gridTripGeneratorCommandKind,
  gridTripGeneratorPayloadSchema,
} from '../commands.ts'
import { gridDefinitionSchema } from '../config.ts'
import { electricGridPackDataSchema, electricGridPackId } from '../model.ts'
import { answerElectricGridQuery, electricGridQueryOperations } from '../query.ts'
import { createGridRecordingPlan } from '../recording.ts'
import { createGridRuntimeInstance, type GridRuntimeInstance } from '../runtime/instance.ts'
import { advanceGrid } from '../runtime/solver.ts'
import { gridProjectionEvents, projectedInitialGridObjects } from './object-projection.ts'
import { createElectricGridRuntimePersistence } from './persistence.ts'
import { electricGridRuntimeStateSchema, restoredGridRuntimeStateFor } from './runtime-state.ts'
import { electricGridAdapterId, electricGridRuntimeId } from './constants.ts'

const updateIntervalMs = 2_000

const currentSimulationTime = (clock: SimulationClockState): IsoTimestamp => {
  if (clock.paused) return clock.currentTime
  const current = Date.parse(clock.currentTime)
  const updated = Date.parse(clock.updatedAt)
  if (!Number.isFinite(current) || !Number.isFinite(updated)) throw new Error('electric-grid runtime received an invalid simulation clock')
  return new Date(current + Math.max(0, Date.now() - updated) * clock.speed).toISOString() as IsoTimestamp
}

const emit = (config: {
  readonly handlers: ReadonlySet<PackRuntimeEventHandler>
  readonly events: ReadonlyArray<PackRuntimeEvent>
  readonly recording?: PackRuntimeRecordingBatch
}): void => {
  if (config.events.length === 0 && config.recording === undefined) return
  const emittedAt = nowIso()
  for (const handler of config.handlers) handler({
    type: 'event.emission',
    runtimeId: electricGridRuntimeId,
    emittedAt,
    events: config.events,
    ...(config.recording === undefined ? {} : { recording: config.recording }),
  })
}

const commandRejected = (command: CommandEnvelope, reason: string): CommandResult => ({
  ok: false,
  commandId: command.id,
  rejectedAt: nowIso(),
  reason,
})

const gridObjectDefinitions = (objects: ReadonlyArray<OperationalObject>) => objects.flatMap(object => {
  if (object.packId !== electricGridPackId) return []
  const data = electricGridPackDataSchema.parse(object.packData)
  return [{
    object,
    definition: gridDefinitionSchema.parse({
      id: object.id,
      model: data.model,
      operatingPoint: data.operatingPoint,
      automation: data.automation,
    }),
  }]
})

const requireGrid = (grids: ReadonlyMap<string, GridRuntimeInstance>, command: CommandEnvelope): GridRuntimeInstance => {
  if (command.targetObjectIds.length !== 1) throw new Error('electric-grid commands require exactly one target Grid object')
  const gridId = command.targetObjectIds[0]!
  const grid = grids.get(gridId)
  if (!grid) throw new Error(`target Grid not found: ${gridId}`)
  return grid
}

const applyCommand = (grid: GridRuntimeInstance, command: CommandEnvelope): void => {
  if (command.kind === gridDispatchGeneratorCommandKind) {
    const payload = gridDispatchGeneratorPayloadSchema.parse(command.payload)
    const state = grid.generators.get(payload.assetId)
    if (!state) throw new Error(`generator Grid Asset not found: ${payload.assetId}`)
    state.targetMw = Math.min(payload.targetMw, state.availableMw)
    return
  }
  if (command.kind === gridTripGeneratorCommandKind) {
    const payload = gridTripGeneratorPayloadSchema.parse(command.payload)
    const state = grid.generators.get(payload.assetId)
    if (!state) throw new Error(`generator Grid Asset not found: ${payload.assetId}`)
    state.state = 'tripped'
    state.dispatchMw = 0
    state.targetMw = 0
    return
  }
  if (command.kind === gridSetGeneratorAvailabilityCommandKind) {
    const payload = gridSetGeneratorAvailabilityPayloadSchema.parse(command.payload)
    const state = grid.generators.get(payload.assetId)
    const definition = grid.definition.model.generators.find(candidate => candidate.id === payload.assetId)
    if (!state || !definition) throw new Error(`generator Grid Asset not found: ${payload.assetId}`)
    state.availableMw = Math.min(payload.availableMw, definition.capacityMw)
    state.targetMw = Math.min(state.targetMw, state.availableMw)
    state.dispatchMw = Math.min(state.dispatchMw, state.availableMw)
    state.state = state.availableMw > 0 ? 'online' : 'offline'
    return
  }
  if (command.kind === gridOpenBranchCommandKind || command.kind === gridCloseBranchCommandKind || command.kind === gridDerateBranchCommandKind || command.kind === gridClearDerateCommandKind) {
    const payload = command.kind === gridOpenBranchCommandKind
      ? gridOpenBranchPayloadSchema.parse(command.payload)
      : command.kind === gridCloseBranchCommandKind
        ? gridCloseBranchPayloadSchema.parse(command.payload)
        : command.kind === gridDerateBranchCommandKind
          ? gridDerateBranchPayloadSchema.parse(command.payload)
          : gridClearDeratePayloadSchema.parse(command.payload)
    const state = grid.branches.get(payload.assetId)
    if (!state) throw new Error(`branch Grid Asset not found: ${payload.assetId}`)
    if (command.kind === gridOpenBranchCommandKind) state.state = 'open'
    if (command.kind === gridCloseBranchCommandKind || command.kind === gridClearDerateCommandKind) {
      state.state = 'closed'
      state.availability = 1
    }
    if (command.kind === gridDerateBranchCommandKind) {
      state.state = 'derated'
      state.availability = gridDerateBranchPayloadSchema.parse(command.payload).availability
    }
    grid.topologyPlan = null
    return
  }
  if (command.kind === gridShedLoadCommandKind) {
    const payload = gridShedLoadPayloadSchema.parse(command.payload)
    const state = grid.loads.get(payload.assetId)
    const definition = grid.definition.model.loads.find(candidate => candidate.id === payload.assetId)
    if (!state || !definition) throw new Error(`load Grid Asset not found: ${payload.assetId}`)
    state.nominalDemandMw = Math.max(definition.criticalMw, state.nominalDemandMw - payload.amountMw)
    return
  }
  if (command.kind === gridRestoreLoadCommandKind) {
    const payload = gridRestoreLoadPayloadSchema.parse(command.payload)
    const state = grid.loads.get(payload.assetId)
    const definition = grid.definition.model.loads.find(candidate => candidate.id === payload.assetId)
    if (!state || !definition) throw new Error(`load Grid Asset not found: ${payload.assetId}`)
    state.nominalDemandMw = definition.demandMw * grid.definition.operatingPoint.loadScale
    return
  }
  if (command.kind === gridSetEvChargingPolicyCommandKind) {
    const payload = gridSetEvChargingPolicyPayloadSchema.parse(command.payload)
    const state = grid.loads.get(payload.assetId)
    const definition = grid.definition.model.loads.find(candidate => candidate.id === payload.assetId)
    if (!state || !definition || definition.kind !== 'ev_charging') throw new Error(`EV charging Grid Asset not found: ${payload.assetId}`)
    state.nominalDemandMw = Math.max(definition.criticalMw, payload.demandMw)
    return
  }
  throw new Error(`electric-grid runtime does not accept command kind: ${command.kind}`)
}

export const createLocalElectricGridPackRuntimeAdapter = (): PackRuntimeAdapter => ({
  id: electricGridRuntimeId,
  version: '1.0.0',
  packId: electricGridPackId,
  clock: 'simulation',
  operations: [...electricGridCommandOperations, ...electricGridQueryOperations],
  connect: async (config: PackRuntimeConnectionConfig): Promise<PackRuntimeConnection> => {
    const { compileGridDefinition } = await import('../definitions.ts')
    const initialObjects = (config.initialObjects ?? config.scenario?.initialObjects ?? []).filter(object => object.packId === electricGridPackId)
    const rawState = await config.runtimeStateStore?.load()
    const runtimeState = rawState === undefined || rawState === null ? null : electricGridRuntimeStateSchema.parse(rawState)
    const initialAt = config.scenario?.world.startsAt ?? nowIso()
    const grids = new Map<string, GridRuntimeInstance>()
    for (const item of gridObjectDefinitions(initialObjects)) {
      const definition = compileGridDefinition(item.definition)
      const restored = restoredGridRuntimeStateFor(runtimeState, item.object.id, definition.model.id)
      grids.set(item.object.id, createGridRuntimeInstance({
        definition,
        at: initialAt,
        ...(restored === undefined ? {} : { restored }),
      }))
    }
    for (const grid of grids.values()) advanceGrid(grid, 0, initialAt)
    const objectsById = new Map<ObjectId, OperationalObject>(projectedInitialGridObjects({ objects: initialObjects, grids, at: initialAt }).map(object => [object.id, object]))
    const projectionKeys = new Map<string, string>()
    const handlers = new Set<PackRuntimeEventHandler>()
    const persistence = createElectricGridRuntimePersistence({ connection: config, grids })
    if (config.recording?.packId !== undefined && config.recording.packId !== electricGridPackId) throw new Error(`electric-grid runtime received recording selection for Pack ${config.recording.packId}`)
    const recordingPlan = config.recording === undefined ? null : createGridRecordingPlan({ selection: config.recording, grids })
    let recordingDescriptorsPending = recordingPlan !== null
    let nextRecordingElapsedMs = recordingPlan?.intervalMs ?? Number.POSITIVE_INFINITY
    let clock: SimulationClockState = { currentTime: initialAt, updatedAt: nowIso(), paused: false, speed: 1 }
    let lastSimulationMs = Date.parse(currentSimulationTime(clock))
    let closed = false
    let failure: string | null = null

    const advanceAndEmit = (history: PackRuntimeEventHistory): void => {
      if (closed || clock.paused || failure !== null) return
      const at = currentSimulationTime(clock)
      const simulationMs = Date.parse(at)
      const dtSeconds = Math.max(0, simulationMs - lastSimulationMs) / 1_000
      lastSimulationMs = simulationMs
      for (const grid of grids.values()) advanceGrid(grid, dtSeconds, at)
      const events = gridProjectionEvents({
        objectsById,
        grids,
        previousKeys: projectionKeys,
        at,
        provenance: { source: 'simulator', adapterId: electricGridAdapterId },
        history,
      })
      const elapsedMs = Math.min(...[...grids.values()].map(grid => grid.elapsedMs))
      const recording = recordingPlan !== null && elapsedMs >= nextRecordingElapsedMs
        ? (() => {
            nextRecordingElapsedMs = elapsedMs + recordingPlan.intervalMs
            const sampled = recordingPlan.sample({ observedAt: nowIso(), simulationTime: at })
            if (!recordingDescriptorsPending) return sampled
            recordingDescriptorsPending = false
            return { ...sampled, descriptors: [...recordingPlan.descriptors] }
          })()
        : undefined
      persistence.scheduleSave()
      emit({ handlers, events, ...(recording === undefined ? {} : { recording }) })
    }

    const interval = setInterval(() => {
      try {
        advanceAndEmit('snapshot-only')
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error)
        clearInterval(interval)
        const at = nowIso()
        for (const grid of grids.values()) grid.projection = {
          ...grid.projection,
          statusTone: 'error',
          statusLabel: 'Runtime failed',
          summary: failure,
          updatedAt: at,
        }
        emit({
          handlers,
          events: gridProjectionEvents({
            objectsById,
            grids,
            previousKeys: projectionKeys,
            at,
            provenance: { source: 'simulator', adapterId: electricGridAdapterId },
            history: 'record',
          }),
        })
        console.error('electric-grid runtime failed:', error)
      }
    }, updateIntervalMs)

    return {
      getSnapshot: async () => ({ simulationRunId: config.simulationRunId, objects: [...objectsById.values()], capturedAt: nowIso() }),
      subscribe: handler => {
        handlers.add(handler)
        return () => handlers.delete(handler)
      },
      sendCommand: async (command: CommandEnvelope): Promise<CommandResult> => {
        if (failure !== null) return commandRejected(command, `electric-grid runtime stopped after a failure: ${failure}`)
        if (!electricGridCommandKinds.includes(command.kind as typeof electricGridCommandKinds[number])) return commandRejected(command, `electric-grid runtime does not accept command kind: ${command.kind}`)
        try {
          const grid = requireGrid(grids, command)
          applyCommand(grid, command)
          const at = currentSimulationTime(clock)
          advanceGrid(grid, 0, at)
          const events = gridProjectionEvents({
            objectsById,
            grids: new Map([[grid.definition.gridId, grid]]),
            previousKeys: projectionKeys,
            at,
            provenance: { source: 'operator', causedByCommandId: command.id },
            history: 'record',
          })
          await persistence.saveNow()
          emit({ handlers, events })
          return { ok: true, commandId: command.id, acceptedAt: nowIso() }
        } catch (error) {
          return commandRejected(command, error instanceof Error ? error.message : String(error))
        }
      },
      query: async (request: PackQueryRequest): Promise<PackQueryResponse> => failure === null
        ? answerElectricGridQuery({ request, grids })
        : { ok: false, packId: electricGridPackId, kind: request.kind, reason: `electric-grid runtime stopped after a failure: ${failure}`, generatedAt: nowIso() },
      observeCommittedEvents: async (events: ReadonlyArray<SimulationRunEvent>): Promise<void> => {
        for (const event of events) {
          if (event.type === 'object.deleted') {
            grids.delete(event.objectId)
            objectsById.delete(event.objectId)
            continue
          }
          if (event.type !== 'object.upserted' || event.object.packId !== electricGridPackId) continue
          objectsById.set(event.object.id, event.object)
          const data = electricGridPackDataSchema.parse(event.object.packData)
          const definition = compileGridDefinition(gridDefinitionSchema.parse({ id: event.object.id, model: data.model, operatingPoint: data.operatingPoint, automation: data.automation }))
          const current = grids.get(event.object.id)
          if (!current || current.definition.model.id !== definition.model.id || current.definition.operatingPoint.id !== definition.operatingPoint.id || current.definition.automation.id !== definition.automation.id) {
            const grid = createGridRuntimeInstance({ definition, at: event.at })
            advanceGrid(grid, 0, event.at)
            grids.set(event.object.id, grid)
          }
        }
      },
      setClock: async (nextClock: SimulationClockState): Promise<void> => {
        clock = nextClock
        lastSimulationMs = Date.parse(currentSimulationTime(clock))
      },
      close: async (): Promise<void> => {
        closed = true
        clearInterval(interval)
        handlers.clear()
        await persistence.saveNow()
      },
    }
  },
})

export { electricGridAdapterId, electricGridRuntimeId }
