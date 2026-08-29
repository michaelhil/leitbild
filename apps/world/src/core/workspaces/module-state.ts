import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, rmdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import {
  isoTimestampSchema,
  workspaceIdSchema,
  type WorkspaceId,
} from '@leitbild/contracts'
import { worldWorkspacePaths } from './paths.ts'

const worldModuleMarkerSchema = z.object({
  workspaceId: workspaceIdSchema,
  moduleId: z.literal('world'),
  createdAt: isoTimestampSchema,
}).strict()
export type WorldModuleMarker = z.infer<typeof worldModuleMarkerSchema>

export interface WorldModuleState {
  readonly list: () => Promise<ReadonlyArray<WorldModuleMarker>>
  readonly get: (workspaceId: WorkspaceId) => Promise<WorldModuleMarker | null>
  readonly provision: (workspaceId: WorkspaceId) => Promise<{
    readonly marker: WorldModuleMarker
    readonly created: boolean
  }>
  readonly remove: (workspaceId: WorkspaceId) => Promise<boolean>
}

export const createWorldModuleState = (config: {
  readonly dataDir: string
}): WorldModuleState => {
  let mutationQueue = Promise.resolve()
  const mutate = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = mutationQueue.then(operation)
    mutationQueue = result.then(() => undefined, () => undefined)
    return result
  }

  const get = async (workspaceId: WorkspaceId): Promise<WorldModuleMarker | null> => {
    const paths = worldWorkspacePaths(config.dataDir, workspaceId)
    try {
      const marker = worldModuleMarkerSchema.parse(JSON.parse(await readFile(paths.marker, 'utf8')) as unknown)
      if (marker.workspaceId !== workspaceId) throw new Error(`Invalid World marker for Workspace ${workspaceId}`)
      return marker
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }

  return {
    get,
    list: async () => {
      const root = join(config.dataDir, 'workspaces')
      let entries
      try {
        entries = await readdir(root, { withFileTypes: true })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
        throw error
      }
      const markers = await Promise.all(entries
        .filter(entry => entry.isDirectory())
        .map(async entry => {
          const parsed = workspaceIdSchema.safeParse(entry.name)
          return parsed.success ? await get(parsed.data) : null
        }))
      return markers.filter((marker): marker is WorldModuleMarker => marker !== null)
    },
    provision: workspaceId => mutate(async () => {
      const existing = await get(workspaceId)
      if (existing) return { marker: existing, created: false }
      const marker = worldModuleMarkerSchema.parse({
        workspaceId,
        moduleId: 'world',
        createdAt: new Date().toISOString(),
      })
      const path = worldWorkspacePaths(config.dataDir, workspaceId).marker
      await mkdir(dirname(path), { recursive: true })
      const temporaryPath = `${path}.${randomUUID()}.tmp`
      await writeFile(temporaryPath, `${JSON.stringify(marker, null, 2)}\n`, 'utf8')
      await rename(temporaryPath, path)
      return { marker, created: true }
    }),
    remove: workspaceId => mutate(async () => {
      if (!await get(workspaceId)) return false
      const paths = worldWorkspacePaths(config.dataDir, workspaceId)
      await rm(paths.root, { recursive: true, force: true })
      try {
        if ((await readdir(paths.workspaceRoot)).length === 0) await rmdir(paths.workspaceRoot)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      return true
    }),
  }
}
