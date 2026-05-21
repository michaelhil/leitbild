import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { z } from 'zod'
import { idSchema, nowIso } from '../model/index.ts'
import type { SimulationProviderStateStore } from '../../simulation/protocol.ts'

const persistedProviderStateSchema = z.object({
  schemaVersion: z.literal(1),
  providerId: idSchema,
  savedAt: z.string().datetime(),
  state: z.unknown(),
})

interface PersistedProviderState {
  readonly schemaVersion: 1
  readonly providerId: string
  readonly savedAt: string
  readonly state: unknown
}

export const createJsonProviderStateStore = (config: {
  readonly providerId: string
  readonly path: string
}): SimulationProviderStateStore => {
  const load = async (): Promise<unknown | null> => {
    let raw: string
    try {
      raw = await readFile(config.path, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw err
    }
    const parsed = persistedProviderStateSchema.parse(JSON.parse(raw) as unknown)
    if (parsed.providerId !== config.providerId) {
      throw new Error(`provider state mismatch: expected ${config.providerId}, got ${parsed.providerId}`)
    }
    return parsed.state
  }

  const save = async (state: unknown): Promise<void> => {
    await mkdir(dirname(config.path), { recursive: true })
    const payload: PersistedProviderState = {
      schemaVersion: 1,
      providerId: config.providerId,
      savedAt: nowIso(),
      state,
    }
    const temporaryPath = `${config.path}.${randomUUID()}.tmp`
    await writeFile(temporaryPath, `${JSON.stringify(payload)}\n`, 'utf8')
    await rename(temporaryPath, config.path)
  }

  return { load, save }
}
