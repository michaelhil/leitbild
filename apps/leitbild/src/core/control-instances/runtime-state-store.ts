import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { z } from 'zod'
import { idSchema, nowIso } from '../model/index.ts'
import type { PackRuntimeStateStore } from '../../simulation/protocol.ts'

const persistedRuntimeStateSchema = z.object({
  schemaVersion: z.literal(1),
  runtimeId: idSchema,
  savedAt: z.string().datetime(),
  state: z.unknown(),
})

interface PersistedRuntimeState {
  readonly schemaVersion: 1
  readonly runtimeId: string
  readonly savedAt: string
  readonly state: unknown
}

export const createJsonRuntimeStateStore = (config: {
  readonly runtimeId: string
  readonly path: string
}): PackRuntimeStateStore => {
  const load = async (): Promise<unknown | null> => {
    let raw: string
    try {
      raw = await readFile(config.path, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw err
    }
    const parsed = persistedRuntimeStateSchema.parse(JSON.parse(raw) as unknown)
    if (parsed.runtimeId !== config.runtimeId) {
      throw new Error(`runtime state mismatch: expected ${config.runtimeId}, got ${parsed.runtimeId}`)
    }
    return parsed.state
  }

  const save = async (state: unknown): Promise<void> => {
    await mkdir(dirname(config.path), { recursive: true })
    const payload: PersistedRuntimeState = {
      schemaVersion: 1,
      runtimeId: config.runtimeId,
      savedAt: nowIso(),
      state,
    }
    const temporaryPath = `${config.path}.${randomUUID()}.tmp`
    await writeFile(temporaryPath, `${JSON.stringify(payload)}\n`, 'utf8')
    await rename(temporaryPath, config.path)
  }

  return { load, save }
}
