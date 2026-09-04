import { mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { z } from 'zod'
import { writeAtomic } from '../storage/atomic-write.ts'
import { runExecutionStateSchema, type RunExecutionState } from './execution.ts'

const persistedExecutionSchema = z.object({
  schemaVersion: z.literal(2),
  execution: runExecutionStateSchema,
}).strict()

export interface ExecutionStore {
  readonly load: () => Promise<RunExecutionState | null>
  readonly save: (execution: RunExecutionState) => Promise<void>
}

export const createExecutionStore = (path: string): ExecutionStore => ({
  load: async () => {
    try {
      const parsed = persistedExecutionSchema.parse(JSON.parse(await readFile(path, 'utf8')) as unknown)
      const updatedAt = new Date().toISOString()
      return runExecutionStateSchema.parse({
        ...parsed.execution,
        playback: 'paused',
        updatedAt,
        acceleration: parsed.execution.acceleration?.status === 'running'
          ? { ...parsed.execution.acceleration, status: 'paused', updatedAt }
          : parsed.execution.acceleration,
      })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  },
  save: async execution => {
    await mkdir(dirname(path), { recursive: true })
    await writeAtomic(path, `${JSON.stringify({ schemaVersion: 2, execution: runExecutionStateSchema.parse(execution) })}\n`)
  },
})
