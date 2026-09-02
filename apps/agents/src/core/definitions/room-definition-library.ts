import type { WorkspaceId } from '@leitbild/contracts'
import {
  createRevisionedDefinitionStore,
  createOperationScope,
  type DefinitionRecord,
  type DefinitionRevision,
  type RevisionedDefinitionStore,
} from '@leitbild/module-runtime'
import { workspaceModulePaths } from '../paths.ts'
import { agentsStorageBudget } from '../storage/admission.ts'
import {
  BUNDLED_ROOM_DEFINITIONS,
  roomDefinitionSchema,
  type RoomDefinition,
} from './room-definition-catalog.ts'

export type RoomDefinitionRecord = DefinitionRecord
export type RoomDefinitionRevision = DefinitionRevision<RoomDefinition>

export interface RoomDefinitionLibrary {
  readonly close: () => Promise<void>
  readonly create: (definition: RoomDefinition) => Promise<RoomDefinitionRevision>
  readonly update: (definition: RoomDefinition, expectedRevisionId: string) => Promise<RoomDefinitionRevision>
  readonly list: () => Promise<ReadonlyArray<RoomDefinitionRecord>>
  readonly get: (definitionId: string) => Promise<RoomDefinitionRecord | undefined>
  readonly currentRevision: (definitionId: string) => Promise<RoomDefinitionRevision | undefined>
  readonly getRevision: (revisionId: string) => Promise<RoomDefinitionRevision | undefined>
  readonly delete: (definitionId: string, expectedRevisionId: string) => Promise<boolean>
}

export const createRoomDefinitionLibrary = (workspaceId: WorkspaceId): RoomDefinitionLibrary => {
  const operations = createOperationScope('Agents definition library')
  const storage = agentsStorageBudget()
  const root = workspaceModulePaths(workspaceId).agents.root
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
    close: () => operations.close(),
    create: definition => operations.run(async () => {
      await ensureReady()
      return await storage.withGrowth(root, Buffer.byteLength(JSON.stringify(definition)) * 2, () => store.create(definition))
    }),
    update: (definition, expectedRevisionId) => operations.run(async () => {
      await ensureReady()
      return await storage.withGrowth(root, Buffer.byteLength(JSON.stringify(definition)) * 2, () => store.update(definition, expectedRevisionId))
    }),
    list: () => operations.run(async () => {
      await ensureReady()
      return await store.list()
    }),
    get: definitionId => operations.run(async () => {
      await ensureReady()
      return await store.get(definitionId)
    }),
    currentRevision: definitionId => operations.run(async () => {
      await ensureReady()
      return await store.currentRevision(definitionId)
    }),
    getRevision: revisionId => operations.run(async () => {
      await ensureReady()
      return await store.getRevision(revisionId)
    }),
    delete: (definitionId, expectedRevisionId) => operations.run(async () => {
      await ensureReady()
      return await store.delete(definitionId, expectedRevisionId)
    }),
  }
}
