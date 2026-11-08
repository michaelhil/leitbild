import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import { writeAtomic } from '../storage/atomic-write.ts'

const epochSchema = z.object({ epoch: z.string().uuid() }).strict()
/** Called only by create/copy/reset lifecycle; never by a query. */
export const createPlanningSourceEpoch = async (path: string): Promise<string> => {
  const epoch = randomUUID()
  await writeAtomic(path, JSON.stringify({ epoch }))
  return epoch
}
export const readPlanningSourceEpoch = async (path: string): Promise<string | null> => {
  try { return epochSchema.parse(JSON.parse(await readFile(path, 'utf8')) as unknown).epoch }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null
    throw error
  }
}
