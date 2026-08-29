import { mkdir, readdir, rename, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { z } from 'zod'
import {
  isoTimestampSchema,
  workspaceIdSchema,
  type WorkspaceId,
} from '@samsinn-leitbild/platform-contracts'
import { workspaceModulePaths } from '../paths.ts'

export const samsinnModuleIdSchema = z.enum(['collaboration', 'agents'])
export type SamsinnModuleId = z.infer<typeof samsinnModuleIdSchema>

const markerSchema = z.object({
  workspaceId: workspaceIdSchema,
  moduleId: samsinnModuleIdSchema,
  createdAt: isoTimestampSchema,
}).strict()
export type SamsinnModuleMarker = z.infer<typeof markerSchema>

const markerPathFor = (workspaceId: WorkspaceId, moduleId: SamsinnModuleId): string =>
  workspaceModulePaths(workspaceId)[moduleId].marker

const readMarker = async (
  workspaceId: WorkspaceId,
  moduleId: SamsinnModuleId,
): Promise<SamsinnModuleMarker | null> => {
  const file = Bun.file(markerPathFor(workspaceId, moduleId))
  if (!await file.exists()) return null
  const marker = markerSchema.parse(JSON.parse(await file.text()) as unknown)
  if (marker.workspaceId !== workspaceId || marker.moduleId !== moduleId) {
    throw new Error(`Invalid ${moduleId} Workspace marker for ${workspaceId}`)
  }
  return marker
}

export interface SamsinnModuleState {
  readonly provision: (workspaceId: WorkspaceId, moduleId: SamsinnModuleId) => Promise<{ readonly marker: SamsinnModuleMarker; readonly created: boolean }>
  readonly remove: (workspaceId: WorkspaceId, moduleId: SamsinnModuleId) => Promise<void>
  readonly has: (workspaceId: WorkspaceId, moduleId: SamsinnModuleId) => Promise<boolean>
  readonly enabled: (workspaceId: WorkspaceId) => Promise<ReadonlySet<SamsinnModuleId>>
}

export const createSamsinnModuleState = (): SamsinnModuleState => {
  let mutationQueue = Promise.resolve()
  const mutate = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = mutationQueue.then(operation)
    mutationQueue = result.then(() => undefined, () => undefined)
    return result
  }

  const provision = (workspaceId: WorkspaceId, moduleId: SamsinnModuleId) => mutate(async () => {
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

  const remove = (workspaceId: WorkspaceId, moduleId: SamsinnModuleId) => mutate(async () => {
    const paths = workspaceModulePaths(workspaceId)
    await rm(paths[moduleId].root, { recursive: true, force: true })
    try {
      if ((await readdir(paths.root)).length === 0) await rm(paths.root, { recursive: false })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  })

  return {
    provision,
    remove,
    has: async (workspaceId, moduleId) => (await readMarker(workspaceId, moduleId)) !== null,
    enabled: async workspaceId => {
      const states = await Promise.all(samsinnModuleIdSchema.options.map(async moduleId => ({
        moduleId,
        enabled: (await readMarker(workspaceId, moduleId)) !== null,
      })))
      return new Set(states.filter(state => state.enabled).map(state => state.moduleId))
    },
  }
}
