import { mkdir, readdir, rename, rm, rmdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { z } from 'zod'
import {
  isoTimestampSchema,
  workspaceIdSchema,
  type WorkspaceId,
} from '@leitbild/contracts'
import { workspaceModulePaths } from '../paths.ts'

export const collabAgentsModuleIdSchema = z.enum(['collab', 'agents'])
export type CollabAgentsModuleId = z.infer<typeof collabAgentsModuleIdSchema>

const markerSchema = z.object({
  workspaceId: workspaceIdSchema,
  moduleId: collabAgentsModuleIdSchema,
  createdAt: isoTimestampSchema,
}).strict()
export type CollabAgentsModuleMarker = z.infer<typeof markerSchema>

const markerPathFor = (workspaceId: WorkspaceId, moduleId: CollabAgentsModuleId): string =>
  workspaceModulePaths(workspaceId)[moduleId].marker

const readMarker = async (
  workspaceId: WorkspaceId,
  moduleId: CollabAgentsModuleId,
): Promise<CollabAgentsModuleMarker | null> => {
  const file = Bun.file(markerPathFor(workspaceId, moduleId))
  if (!await file.exists()) return null
  const marker = markerSchema.parse(JSON.parse(await file.text()) as unknown)
  if (marker.workspaceId !== workspaceId || marker.moduleId !== moduleId) {
    throw new Error(`Invalid ${moduleId} Workspace marker for ${workspaceId}`)
  }
  return marker
}

export interface CollabAgentsModuleState {
  readonly provision: (workspaceId: WorkspaceId, moduleId: CollabAgentsModuleId) => Promise<{ readonly marker: CollabAgentsModuleMarker; readonly created: boolean }>
  readonly remove: (workspaceId: WorkspaceId, moduleId: CollabAgentsModuleId) => Promise<void>
  readonly has: (workspaceId: WorkspaceId, moduleId: CollabAgentsModuleId) => Promise<boolean>
  readonly enabled: (workspaceId: WorkspaceId) => Promise<ReadonlySet<CollabAgentsModuleId>>
}

export const createCollabAgentsModuleState = (): CollabAgentsModuleState => {
  let mutationQueue = Promise.resolve()
  const mutate = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = mutationQueue.then(operation)
    mutationQueue = result.then(() => undefined, () => undefined)
    return result
  }

  const provision = (workspaceId: WorkspaceId, moduleId: CollabAgentsModuleId) => mutate(async () => {
    const existing = await readMarker(workspaceId, moduleId)
    if (existing) return { marker: existing, created: false }
    const marker = markerSchema.parse({
      workspaceId,
      moduleId,
      createdAt: new Date().toISOString(),
    })
    const path = markerPathFor(workspaceId, moduleId)
    await mkdir(dirname(path), { recursive: true })
    const temporaryPath = `${path}.${crypto.randomUUID()}.tmp`
    await Bun.write(temporaryPath, `${JSON.stringify(marker, null, 2)}\n`)
    await rename(temporaryPath, path)
    return { marker, created: true }
  })

  const remove = (workspaceId: WorkspaceId, moduleId: CollabAgentsModuleId) => mutate(async () => {
    const paths = workspaceModulePaths(workspaceId)
    await rm(paths[moduleId].root, { recursive: true, force: true })
    try {
      if ((await readdir(paths.root)).length === 0) await rmdir(paths.root)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  })

  return {
    provision,
    remove,
    has: async (workspaceId, moduleId) => (await readMarker(workspaceId, moduleId)) !== null,
    enabled: async workspaceId => {
      const states = await Promise.all(collabAgentsModuleIdSchema.options.map(async moduleId => ({
        moduleId,
        enabled: (await readMarker(workspaceId, moduleId)) !== null,
      })))
      return new Set(states.filter(state => state.enabled).map(state => state.moduleId))
    },
  }
}
