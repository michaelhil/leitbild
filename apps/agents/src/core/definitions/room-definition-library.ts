import { createHash } from 'node:crypto'
import { mkdir, readFile, rename } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import type { WorkspaceId } from '@leitbild/contracts'
import { workspaceModulePaths } from '../paths.ts'
import {
  BUNDLED_ROOM_DEFINITIONS,
  roomDefinitionSchema,
  type RoomDefinition,
} from './room-definition-catalog.ts'

const deletedDefinitionsSchema = z.object({
  definitionIds: z.array(z.string().min(1).max(128)),
}).strict()

export interface RoomDefinitionRevision {
  readonly id: string
  readonly definitionId: string
  readonly definition: RoomDefinition
}

export interface RoomDefinitionLibrary {
  readonly list: () => Promise<ReadonlyArray<RoomDefinitionRevision>>
  readonly get: (definitionId: string) => Promise<RoomDefinitionRevision | undefined>
  readonly getRevision: (revisionId: string) => Promise<RoomDefinitionRevision | undefined>
  readonly delete: (definitionId: string, revisionId: string) => Promise<boolean>
}

const stableJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

const revisionFor = (definition: RoomDefinition): RoomDefinitionRevision => ({
  id: `revision-${createHash('sha256').update(stableJson(definition)).digest('hex').slice(0, 32)}`,
  definitionId: definition.id,
  definition,
})

export const createRoomDefinitionLibrary = (workspaceId: WorkspaceId): RoomDefinitionLibrary => {
  const path = join(workspaceModulePaths(workspaceId).agents.root, 'deleted-definitions.json')
  const revisionsDir = join(workspaceModulePaths(workspaceId).agents.root, 'definition-revisions')
  let mutationQueue: Promise<void> = Promise.resolve()

  const revisionSchema = z.object({
    id: z.string().min(1).max(128),
    definitionId: z.string().min(1).max(128),
    definition: roomDefinitionSchema,
  }).strict()

  const revisionPath = (id: string): string => join(revisionsDir, `${id}.json`)

  const loadRevision = async (id: string): Promise<RoomDefinitionRevision | undefined> => {
    try {
      return revisionSchema.parse(JSON.parse(await readFile(revisionPath(id), 'utf8')) as unknown)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }

  const materializeBundledRevisions = async (): Promise<ReadonlyArray<RoomDefinitionRevision>> => {
    const revisions = BUNDLED_ROOM_DEFINITIONS.map(revisionFor)
    await mkdir(revisionsDir, { recursive: true })
    for (const revision of revisions) {
      const existing = await loadRevision(revision.id)
      if (existing !== undefined) {
        if (stableJson(existing) !== stableJson(revision)) throw new Error(`Room Definition Revision collision: ${revision.id}`)
        continue
      }
      const target = revisionPath(revision.id)
      const temporaryPath = `${target}.${crypto.randomUUID()}.tmp`
      await Bun.write(temporaryPath, `${JSON.stringify(revisionSchema.parse(revision), null, 2)}\n`)
      await rename(temporaryPath, target)
    }
    return revisions
  }

  const loadDeleted = async (): Promise<ReadonlySet<string>> => {
    try {
      const value = deletedDefinitionsSchema.parse(JSON.parse(await readFile(path, 'utf8')) as unknown)
      return new Set(value.definitionIds)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Set()
      throw error
    }
  }

  const saveDeleted = async (ids: ReadonlySet<string>): Promise<void> => {
    await mkdir(dirname(path), { recursive: true })
    const temporaryPath = `${path}.${crypto.randomUUID()}.tmp`
    await Bun.write(temporaryPath, `${JSON.stringify({ definitionIds: [...ids].sort() }, null, 2)}\n`)
    await rename(temporaryPath, path)
  }

  const list = async (): Promise<ReadonlyArray<RoomDefinitionRevision>> => {
    const revisions = await materializeBundledRevisions()
    const deleted = await loadDeleted()
    return revisions
      .filter(revision => !deleted.has(revision.definitionId))
      .sort((left, right) => left.definition.title.localeCompare(right.definition.title))
  }

  return {
    list,
    get: async definitionId => (await list()).find(revision => revision.definitionId === definitionId),
    getRevision: async revisionId => {
      await materializeBundledRevisions()
      return await loadRevision(revisionId)
    },
    delete: (definitionId, revisionId) => {
      const operation = mutationQueue.then(async () => {
        const definitions = await list()
        if (!definitions.some(definition => definition.definitionId === definitionId && definition.id === revisionId)) return false
        const deleted = new Set(await loadDeleted())
        deleted.add(definitionId)
        await saveDeleted(deleted)
        return true
      })
      mutationQueue = operation.then(() => undefined, () => undefined)
      return operation
    },
  }
}
