import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { z } from 'zod'
import { controlInstanceIdSchema, nowIso, type ControlInstanceId, type IsoTimestamp } from '../model/index.ts'
import { controlInstanceStateSnapshotSchema, type ControlInstanceStateSnapshot } from './state-store.ts'

const persistedControlInstanceSnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  controlInstanceId: controlInstanceIdSchema,
  savedAt: z.string().datetime(),
  snapshot: controlInstanceStateSnapshotSchema,
})

export interface PersistedControlInstanceSnapshot {
  readonly schemaVersion: 1
  readonly controlInstanceId: ControlInstanceId
  readonly savedAt: IsoTimestamp
  readonly snapshot: ControlInstanceStateSnapshot
}

export interface ControlInstanceSnapshotStore {
  readonly load: () => Promise<ControlInstanceStateSnapshot | null>
  readonly save: (snapshot: ControlInstanceStateSnapshot) => Promise<void>
}

export const createControlInstanceSnapshotStore = (config: {
  readonly controlInstanceId: ControlInstanceId
  readonly path: string
}): ControlInstanceSnapshotStore => {
  const load = async (): Promise<ControlInstanceStateSnapshot | null> => {
    let raw: string
    try {
      raw = await readFile(config.path, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw err
    }
    const parsed = persistedControlInstanceSnapshotSchema.parse(JSON.parse(raw) as unknown)
    if (parsed.controlInstanceId !== config.controlInstanceId) {
      throw new Error(`snapshot control instance mismatch: expected ${config.controlInstanceId}, got ${parsed.controlInstanceId}`)
    }
    return parsed.snapshot as ControlInstanceStateSnapshot
  }

  const save = async (snapshot: ControlInstanceStateSnapshot): Promise<void> => {
    await mkdir(dirname(config.path), { recursive: true })
    const payload: PersistedControlInstanceSnapshot = {
      schemaVersion: 1,
      controlInstanceId: config.controlInstanceId,
      savedAt: nowIso(),
      snapshot,
    }
    const temporaryPath = `${config.path}.${randomUUID()}.tmp`
    await writeFile(temporaryPath, `${JSON.stringify(payload)}\n`, 'utf8')
    await rename(temporaryPath, config.path)
  }

  return { load, save }
}
