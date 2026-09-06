import { mkdir, readFile, readdir, rename, rm, link } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ExecutionGrowth } from './spawn.ts'

const identifier = (value: string): string => {
  if (!/^[a-zA-Z0-9_-]+$/.test(value)) throw new Error('Invalid comparison identifier')
  return value
}

/** Immutable task input and independently replaced execution records. The
 * caller serializes mutations; this layer never caches historical content. */
export const createComparisonStorage = (root: string, growth: ExecutionGrowth) => {
  const directory = (roomId: string, messageId: string) => join(root, identifier(roomId), identifier(messageId))
  const write = async (path: string, text: string, immutable = false): Promise<void> => {
    await growth(Buffer.byteLength(text), async () => {
      const parent = path.slice(0, path.lastIndexOf('/'))
      await mkdir(parent, { recursive: true })
      const temporary = `${path}.${randomUUID()}.tmp`
      try {
        await Bun.write(temporary, text)
        if (immutable) {
          try { await link(temporary, path) }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
        } else await rename(temporary, path)
      } finally { await rm(temporary, { force: true }) }
    })
  }
  return {
    writeSource: (roomId: string, messageId: string, text: string) => write(join(directory(roomId, messageId), 'source.json'), text, true),
    writeAlternative: (roomId: string, messageId: string, id: string, text: string) => write(join(directory(roomId, messageId), 'alternatives', `${identifier(id)}.json`), text),
    read: async (roomId: string, messageId: string): Promise<{ source: unknown; alternatives: unknown[] } | undefined> => {
      const dir = directory(roomId, messageId)
      let source: unknown
      try { source = JSON.parse(await readFile(join(dir, 'source.json'), 'utf8')) }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
      let files: string[]
      try { files = await readdir(join(dir, 'alternatives')) }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') files = []; else throw error }
      const alternatives = await Promise.all(files.filter(file => file.endsWith('.json')).sort().map(async file => {
        const value: unknown = JSON.parse(await readFile(join(dir, 'alternatives', file), 'utf8'))
        if (!value || typeof value !== 'object' || !('id' in value) || `${value.id}.json` !== file) throw new Error('Comparison execution identity does not match its file')
        return value
      }))
      return { source, alternatives }
    },
    removeAlternative: (roomId: string, messageId: string, id: string) => rm(join(directory(roomId, messageId), 'alternatives', `${identifier(id)}.json`), { force: true }),
    remove: (roomId: string, messageId?: string) => rm(messageId ? directory(roomId, messageId) : join(root, identifier(roomId)), { force: true, recursive: true }),
  }
}
