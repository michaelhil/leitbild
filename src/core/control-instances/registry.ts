import { randomUUID } from 'node:crypto'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { ControlInstanceId, InteractionHandler } from '../model/index.ts'
import { controlInstanceIdSchema } from '../model/index.ts'
import type { SimulationAdapter } from '../../simulation/protocol.ts'
import { createJsonlEventLog } from './event-log.ts'
import { createControlInstanceRuntime, type ControlInstanceRuntime } from './runtime.ts'
import { createControlInstanceSnapshotStore } from './snapshot-store.ts'
import type { DomainEvent } from '../model/index.ts'

export interface ControlInstanceSummary {
  readonly id: ControlInstanceId
  readonly loaded: boolean
  readonly snapshotSeq: number | null
  readonly objectCount: number | null
}

export interface ControlInstanceRegistry {
  readonly create: (config?: { readonly id?: ControlInstanceId }) => Promise<ControlInstanceRuntime>
  readonly ensure: (id: ControlInstanceId) => Promise<ControlInstanceRuntime>
  readonly get: (id: ControlInstanceId) => ControlInstanceRuntime | undefined
  readonly list: () => ReadonlyArray<ControlInstanceRuntime>
  readonly listKnown: () => Promise<ReadonlyArray<ControlInstanceSummary>>
  readonly close: (id: ControlInstanceId) => Promise<boolean>
}

export const createControlInstanceRegistry = (config: {
  readonly dataDir: string
  readonly simulationAdapter: SimulationAdapter
  readonly interactionHandlers?: ReadonlyArray<InteractionHandler>
}): ControlInstanceRegistry => {
  const controlInstances = new Map<ControlInstanceId, ControlInstanceRuntime>()
  const controlInstanceRoot = join(config.dataDir, 'control-instances')

  const validateRestoredEvents = (id: ControlInstanceId, events: ReadonlyArray<DomainEvent>): void => {
    let previousSeq = 0
    for (const event of events) {
      if (event.controlInstanceId !== id) {
        throw new Error(`event log control instance mismatch: expected ${id}, got ${event.controlInstanceId}`)
      }
      if (event.seq <= previousSeq) {
        throw new Error(`event log sequence regression for ${id}: ${event.seq} after ${previousSeq}`)
      }
      previousSeq = event.seq
    }
  }

  const create = async (createConfig?: { readonly id?: ControlInstanceId }): Promise<ControlInstanceRuntime> => {
    const id = createConfig?.id ?? `control-instance:${randomUUID()}` as ControlInstanceId
    if (controlInstances.has(id)) throw new Error(`control instance already exists: ${id}`)
    const instanceDir = join(controlInstanceRoot, id)
    const eventLog = createJsonlEventLog(join(instanceDir, 'events.jsonl'))
    const snapshotStore = createControlInstanceSnapshotStore({
      controlInstanceId: id,
      path: join(instanceDir, 'snapshot.json'),
    })
    const restoredSnapshot = await snapshotStore.load()
    const restoredEvents = await eventLog.readAll()
    validateRestoredEvents(id, restoredEvents)
    const maxEventSeq = restoredEvents.at(-1)?.seq ?? 0
    if (restoredSnapshot && restoredSnapshot.seq < maxEventSeq) {
      throw new Error(`snapshot sequence ${restoredSnapshot.seq} is behind event log sequence ${maxEventSeq} for ${id}`)
    }
    const simulation = await config.simulationAdapter.connect({
      controlInstanceId: id,
      ...(restoredSnapshot ? { initialObjects: restoredSnapshot.objects } : {}),
    })
    const runtime = await createControlInstanceRuntime({
      id,
      simulation,
      eventLog,
      snapshotStore,
      ...(config.interactionHandlers ? { interactionHandlers: config.interactionHandlers } : {}),
      ...(restoredSnapshot ? { restoredSnapshot } : {}),
      ...(restoredEvents.length === 0 ? {} : { restoredEvents }),
    })
    controlInstances.set(id, runtime)
    return runtime
  }

  const ensure = async (id: ControlInstanceId): Promise<ControlInstanceRuntime> => {
    const existing = controlInstances.get(id)
    if (existing) return existing
    return create({ id })
  }

  const close = async (id: ControlInstanceId): Promise<boolean> => {
    const runtime = controlInstances.get(id)
    if (!runtime) return false
    await runtime.close()
    controlInstances.delete(id)
    return true
  }

  const listPersistedIds = async (): Promise<ReadonlyArray<ControlInstanceId>> => {
    let entries: ReadonlyArray<{ readonly isDirectory: () => boolean; readonly name: string }>
    try {
      entries = await readdir(controlInstanceRoot, { withFileTypes: true })
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw err
    }
    return entries
      .filter(entry => entry.isDirectory())
      .map(entry => controlInstanceIdSchema.safeParse(entry.name))
      .filter((result): result is { readonly success: true; readonly data: ControlInstanceId } => result.success)
      .map(result => result.data)
      .sort()
  }

  const summaryFor = async (id: ControlInstanceId): Promise<ControlInstanceSummary> => {
    const loaded = controlInstances.get(id)
    if (loaded) {
      const snapshot = loaded.snapshot()
      return {
        id,
        loaded: true,
        snapshotSeq: snapshot.seq,
        objectCount: snapshot.objects.length,
      }
    }
    const snapshotStore = createControlInstanceSnapshotStore({
      controlInstanceId: id,
      path: join(controlInstanceRoot, id, 'snapshot.json'),
    })
    const snapshot = await snapshotStore.load()
    return {
      id,
      loaded: false,
      snapshotSeq: snapshot?.seq ?? null,
      objectCount: snapshot?.objects.length ?? null,
    }
  }

  const listKnown = async (): Promise<ReadonlyArray<ControlInstanceSummary>> => {
    const ids = new Set<ControlInstanceId>([...controlInstances.keys(), ...await listPersistedIds()])
    const summaries: ControlInstanceSummary[] = []
    for (const id of [...ids].sort()) summaries.push(await summaryFor(id))
    return summaries
  }

  return {
    create,
    ensure,
    get: (id: ControlInstanceId) => controlInstances.get(id),
    list: () => [...controlInstances.values()],
    listKnown,
    close,
  }
}
