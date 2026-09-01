import type { WorkspaceId } from '@leitbild/contracts'
import {
  createRevisionedDefinitionStore,
  type DefinitionRecord,
  type DefinitionRevision,
  type RevisionedDefinitionStore,
} from '@leitbild/module-runtime'
import { workspaceModulePaths } from '../paths.ts'
import {
  BUNDLED_ROOM_DEFINITIONS,
  roomDefinitionSchema,
  type RoomDefinition,
} from './room-definition-catalog.ts'

export type RoomDefinitionRecord = DefinitionRecord
export type RoomDefinitionRevision = DefinitionRevision<RoomDefinition>

export interface RoomDefinitionLibrary {
  readonly create: (definition: RoomDefinition) => Promise<RoomDefinitionRevision>
  readonly update: (definition: RoomDefinition, expectedRevisionId: string) => Promise<RoomDefinitionRevision>
  readonly list: () => Promise<ReadonlyArray<RoomDefinitionRecord>>
  readonly get: (definitionId: string) => Promise<RoomDefinitionRecord | undefined>
  readonly currentRevision: (definitionId: string) => Promise<RoomDefinitionRevision | undefined>
  readonly getRevision: (revisionId: string) => Promise<RoomDefinitionRevision | undefined>
  readonly delete: (definitionId: string, expectedRevisionId: string) => Promise<boolean>
}

export const createRoomDefinitionLibrary = (workspaceId: WorkspaceId): RoomDefinitionLibrary => {
  const store: RevisionedDefinitionStore<RoomDefinition> = createRevisionedDefinitionStore({
    workspaceId,
    rootDir: `${workspaceModulePaths(workspaceId).agents.root}/definitions`,
    documentSchema: roomDefinitionSchema,
    metadata: definition => ({
      id: definition.id,
      title: definition.title,
      description: definition.description,
      ...(definition.category === undefined ? {} : { category: definition.category }),
    }),
  })
  let ready: Promise<void> | undefined
  const ensureReady = (): Promise<void> => {
    ready ??= store.seed(BUNDLED_ROOM_DEFINITIONS)
    return ready
  }

  return {
    create: async definition => {
      await ensureReady()
      return await store.create(definition)
    },
    update: async (definition, expectedRevisionId) => {
      await ensureReady()
      return await store.update(definition, expectedRevisionId)
    },
    list: async () => {
      await ensureReady()
      return await store.list()
    },
    get: async definitionId => {
      await ensureReady()
      return await store.get(definitionId)
    },
    currentRevision: async definitionId => {
      await ensureReady()
      return await store.currentRevision(definitionId)
    },
    getRevision: async revisionId => {
      await ensureReady()
      return await store.getRevision(revisionId)
    },
    delete: async (definitionId, expectedRevisionId) => {
      await ensureReady()
      return await store.delete(definitionId, expectedRevisionId)
    },
  }
}
