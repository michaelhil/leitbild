import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, rmdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import {
  isoTimestampSchema,
  workspaceIdSchema,
  type WorkspaceId,
} from '@samsinn-leitbild/platform-contracts'
import { microworldWorkspacePaths } from './paths.ts'

const microworldModuleMarkerSchema = z.object({
  workspaceId: workspaceIdSchema,
  moduleId: z.literal('microworld'),
  createdAt: isoTimestampSchema,
}).strict()
export type MicroworldModuleMarker = z.infer<typeof microworldModuleMarkerSchema>

export interface MicroworldModuleState {
  readonly list: () => Promise<ReadonlyArray<MicroworldModuleMarker>>
  readonly get: (workspaceId: WorkspaceId) => Promise<MicroworldModuleMarker | null>
  readonly provision: (workspaceId: WorkspaceId) => Promise<{
    readonly marker: MicroworldModuleMarker
    readonly created: boolean
  }>
  readonly remove: (workspaceId: WorkspaceId) => Promise<boolean>
}

export const createMicroworldModuleState = (config: {
  readonly dataDir: string
}): MicroworldModuleState => {
  let mutationQueue = Promise.resolve()
  const mutate = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = mutationQueue.then(operation)
    mutationQueue = result.then(() => undefined, () => undefined)
    return result
  }

  const get = async (workspaceId: WorkspaceId): Promise<MicroworldModuleMarker | null> => {
    const paths = microworldWorkspacePaths(config.dataDir, workspaceId)
    try {
      const marker = microworldModuleMarkerSchema.parse(JSON.parse(await readFile(paths.marker, 'utf8')) as unknown)
      if (marker.workspaceId !== workspaceId) throw new Error(`Invalid Microworld marker for Workspace ${workspaceId}`)
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
      return markers.filter((marker): marker is MicroworldModuleMarker => marker !== null)
    },
    provision: workspaceId => mutate(async () => {
      const existing = await get(workspaceId)
      if (existing) return { marker: existing, created: false }
      const marker = microworldModuleMarkerSchema.parse({
        workspaceId,
        moduleId: 'microworld',
        createdAt: new Date().toISOString(),
      })
      const path = microworldWorkspacePaths(config.dataDir, workspaceId).marker
      await mkdir(dirname(path), { recursive: true })
      const temporaryPath = `${path}.${randomUUID()}.tmp`
      await writeFile(temporaryPath, `${JSON.stringify(marker, null, 2)}\n`, 'utf8')
      await rename(temporaryPath, path)
      return { marker, created: true }
    }),
    remove: workspaceId => mutate(async () => {
      if (!await get(workspaceId)) return false
      const paths = microworldWorkspacePaths(config.dataDir, workspaceId)
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
