import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { z } from 'zod'
import { simulationRunIdSchema, nowIso, type SimulationRunId, type IsoTimestamp } from '../model/index.ts'
import { simulationRunStateSnapshotSchema, type SimulationRunStateSnapshot } from './state-store.ts'

const persistedSimulationRunSnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  simulationRunId: simulationRunIdSchema,
  savedAt: z.string().datetime(),
  snapshot: simulationRunStateSnapshotSchema,
})

export interface PersistedSimulationRunSnapshot {
  readonly schemaVersion: 1
  readonly simulationRunId: SimulationRunId
  readonly savedAt: IsoTimestamp
  readonly snapshot: SimulationRunStateSnapshot
}

export interface SimulationRunSnapshotStore {
  readonly load: () => Promise<SimulationRunStateSnapshot | null>
  readonly save: (snapshot: SimulationRunStateSnapshot) => Promise<void>
}

export const createSimulationRunSnapshotStore = (config: {
  readonly simulationRunId: SimulationRunId
  readonly path: string
}): SimulationRunSnapshotStore => {
  const load = async (): Promise<SimulationRunStateSnapshot | null> => {
    let raw: string
    try {
      raw = await readFile(config.path, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw err
    }
    const parsed = persistedSimulationRunSnapshotSchema.parse(JSON.parse(raw) as unknown)
    if (parsed.simulationRunId !== config.simulationRunId) {
      throw new Error(`snapshot simulation run mismatch: expected ${config.simulationRunId}, got ${parsed.simulationRunId}`)
    }
    return parsed.snapshot as SimulationRunStateSnapshot
  }

  const save = async (snapshot: SimulationRunStateSnapshot): Promise<void> => {
    await mkdir(dirname(config.path), { recursive: true })
    const payload: PersistedSimulationRunSnapshot = {
      schemaVersion: 1,
      simulationRunId: config.simulationRunId,
      savedAt: nowIso(),
      snapshot,
    }
    const temporaryPath = `${config.path}.${randomUUID()}.tmp`
    await writeFile(temporaryPath, `${JSON.stringify(payload)}\n`, 'utf8')
    await rename(temporaryPath, config.path)
  }

  return { load, save }
}
