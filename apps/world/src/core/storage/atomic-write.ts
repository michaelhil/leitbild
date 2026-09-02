import { randomUUID } from 'node:crypto'
import { rename, rm, writeFile } from 'node:fs/promises'

/** Caller owns directory creation and write ordering. Failed writes leave no temp file. */
export const writeAtomic = async (path: string, contents: string): Promise<void> => {
  const temporaryPath = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temporaryPath, contents, 'utf8')
    await rename(temporaryPath, path)
  } finally {
    await rm(temporaryPath, { force: true })
  }
}
