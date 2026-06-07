import type { CommandEnvelope, CommandResult, ControlInstanceEvent, IsoTimestamp, OperationalObject, SimulationClockState } from '../../../core/model/index.ts'
import { nowIso } from '../../../core/model/index.ts'
import type { PackQueryRequest, PackQueryResponse } from '../../../core/packs/protocol.ts'
import type { PackRuntimeAdapter, PackRuntimeConnection, PackRuntimeConnectionConfig, PackRuntimeEvent, PackRuntimeEventHandler } from '../../../simulation/protocol.ts'
import { droneCommandKinds } from '../commands.ts'
import { dronePackId } from '../model.ts'
import { answerDroneQuery, droneQueryKinds } from '../query.ts'
import { droneProfilesFromRuntimeConfigValue } from '../scenario.ts'
import { droneSimRuntimeId } from './constants.ts'
import { createDroneSimEngine } from './engine.ts'

const tickIntervalMs = 100

const emit = (
  handlers: ReadonlySet<PackRuntimeEventHandler>,
  events: ReadonlyArray<PackRuntimeEvent>,
): void => {
  const firstEvent = events[0]
  if (!firstEvent) return
  for (const handler of handlers) {
    handler({
      type: 'event.emission',
      events,
      emittedAt: firstEvent.at,
      runtimeId: droneSimRuntimeId,
    })
  }
}

const initialObjectsFor = (config: PackRuntimeConnectionConfig): ReadonlyArray<OperationalObject> =>
  (config.initialObjects ?? config.scenario?.initialObjects ?? []).filter(object => object.packId === dronePackId)

const initialClock = (config: PackRuntimeConnectionConfig): SimulationClockState => {
  const currentTime = config.scenario?.world.startsAt ?? nowIso()
  return {
    currentTime,
    updatedAt: nowIso(),
    paused: false,
    speed: 1,
  }
}

export const createLocalDronePackRuntimeAdapter = (): PackRuntimeAdapter => ({
  id: droneSimRuntimeId,
  packId: dronePackId,
  acceptedCommandKinds: droneCommandKinds,
  queryKinds: droneQueryKinds,
  connect: async (config: PackRuntimeConnectionConfig): Promise<PackRuntimeConnection> => {
    const profiles = droneProfilesFromRuntimeConfigValue(config.scenario?.runtimeConfig)
    const engine = createDroneSimEngine({
      controlInstanceId: config.controlInstanceId,
      objects: initialObjectsFor(config),
      profiles,
      ...(config.scenario?.world.startsAt === undefined ? {} : { startedAt: config.scenario.world.startsAt }),
    })
    const handlers = new Set<PackRuntimeEventHandler>()
    let clock = initialClock(config)
    let lastWallMs = Date.now()

    const advance = (): void => {
      const nowWallMs = Date.now()
      const wallElapsedMs = Math.max(0, nowWallMs - lastWallMs)
      lastWallMs = nowWallMs
      if (clock.paused || wallElapsedMs <= 0) return
      const elapsedMs = wallElapsedMs * clock.speed
      const at = new Date(Date.parse(clock.currentTime) + elapsedMs).toISOString() as IsoTimestamp
      clock = { ...clock, currentTime: at, updatedAt: nowIso() }
      emit(handlers, engine.tick(elapsedMs, at))
    }

    const interval = setInterval(advance, tickIntervalMs)

    return {
      getSnapshot: async () => engine.snapshot(),
      subscribe: (handler: PackRuntimeEventHandler): (() => void) => {
        handlers.add(handler)
        return () => {
          handlers.delete(handler)
        }
      },
      sendCommand: async (command: CommandEnvelope): Promise<CommandResult> => {
        const handled = await engine.handleCommand(command)
        emit(handlers, handled.events)
        return handled.result
      },
      query: async (request: PackQueryRequest): Promise<PackQueryResponse> =>
        answerDroneQuery({
          request,
          objects: engine.snapshot().objects,
          at: nowIso(),
          profiles,
        }),
      observeCommittedEvents: async (events: ReadonlyArray<ControlInstanceEvent>): Promise<void> => {
        engine.observeCommittedEvents(events)
      },
      setClock: async (nextClock: SimulationClockState): Promise<void> => {
        clock = nextClock
        lastWallMs = Date.now()
      },
      close: async (): Promise<void> => {
        clearInterval(interval)
        handlers.clear()
      },
    }
  },
})
