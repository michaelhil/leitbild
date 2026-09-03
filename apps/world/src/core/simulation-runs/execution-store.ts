import { mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { z } from 'zod'
import { writeAtomic } from '../storage/atomic-write.ts'
import { runExecutionStateSchema, type RunExecutionState } from './execution.ts'

const persistedExecutionSchema = z.object({
  schemaVersion: z.literal(1),
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
      if (parsed.execution.mode !== 'fast-forward') return parsed.execution
      const updatedAt = new Date().toISOString()
      return runExecutionStateSchema.parse({
        ...parsed.execution,
        mode: 'paused',
        updatedAt,
        fastForward: parsed.execution.fastForward === null ? null : {
          ...parsed.execution.fastForward,
          status: 'stopped',
          updatedAt,
        },
      })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  },
  save: async execution => {
    await mkdir(dirname(path), { recursive: true })
    await writeAtomic(path, `${JSON.stringify({ schemaVersion: 1, execution: runExecutionStateSchema.parse(execution) })}\n`)
  },
})
