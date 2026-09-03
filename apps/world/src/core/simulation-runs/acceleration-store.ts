import { mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { z } from 'zod'
import { writeAtomic } from '../storage/atomic-write.ts'
import { accelerationJobStateSchema, type AccelerationJobState } from './acceleration.ts'

const persistedAccelerationSchema = z.object({
  schemaVersion: z.literal(1),
  job: accelerationJobStateSchema,
}).strict()

export interface AccelerationStore {
  readonly load: () => Promise<AccelerationJobState | null>
  readonly save: (job: AccelerationJobState) => Promise<void>
}

export const createAccelerationStore = (path: string): AccelerationStore => ({
  load: async () => {
    try {
      const parsed = persistedAccelerationSchema.parse(JSON.parse(await readFile(path, 'utf8')) as unknown)
      // A process cannot still own a job after restart. Preserve its exact
      // progress, but require an explicit user decision to continue.
      return parsed.job.status === 'running'
        ? accelerationJobStateSchema.parse({ ...parsed.job, status: 'paused', updatedAt: new Date().toISOString() })
        : parsed.job
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  },
  save: async job => {
    await mkdir(dirname(path), { recursive: true })
    await writeAtomic(path, `${JSON.stringify({ schemaVersion: 1, job: accelerationJobStateSchema.parse(job) })}\n`)
  },
})
