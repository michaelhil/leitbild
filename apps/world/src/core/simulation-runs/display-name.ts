import { randomUUID } from 'node:crypto'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { z } from 'zod'

export const runDisplayNameSchema = z.string().trim().min(1).max(256).nullable()
const metadataSchema = z.object({ name: runDisplayNameSchema }).strict()

// An absent annotation means the Run uses its pinned Scenario title. This is
// optional display metadata, never launch provenance or simulation state.
export const readRunDisplayName = async (path: string): Promise<string | null> => {
  try {
    return metadataSchema.parse(JSON.parse(await readFile(path, 'utf8')) as unknown).name
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

export const writeRunDisplayName = async (path: string, name: string | null): Promise<void> => {
  const metadata = metadataSchema.parse({ name })
  const temporaryPath = `${path}.${randomUUID()}.tmp`
  // Do not mkdir: a concurrently deleted Run must not be resurrected by rename.
  await writeFile(temporaryPath, `${JSON.stringify(metadata)}\n`, 'utf8')
  await rename(temporaryPath, path)
}
