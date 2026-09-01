import { z } from 'zod'
import type { WorkspaceId } from '@leitbild/contracts'
import {
  createRevisionedDefinitionStore,
  type DefinitionRecord,
  type DefinitionRevision,
  type RevisionedDefinitionStore,
} from '@leitbild/module-runtime'
import { scenarioSourceSchema, type ScenarioSource } from './config.ts'

export const scenarioRevisionIdSchema = z.string()
  .regex(/^revision-[a-f0-9]{32}$/)
  .brand<'ScenarioRevisionId'>()
export type ScenarioRevisionId = z.infer<typeof scenarioRevisionIdSchema>

export type ScenarioRecord = DefinitionRecord
export type ScenarioRevision = Omit<DefinitionRevision<ScenarioSource>, 'id'> & {
  readonly id: ScenarioRevisionId
}

export interface ScenarioLibrary {
  readonly seed: (sources: ReadonlyArray<ScenarioSource>) => Promise<void>
  readonly create: (source: ScenarioSource) => Promise<ScenarioRevision>
  readonly update: (source: ScenarioSource, expectedRevisionId: ScenarioRevisionId) => Promise<ScenarioRevision>
  readonly list: () => Promise<ReadonlyArray<ScenarioRecord>>
  readonly get: (scenarioId: string) => Promise<ScenarioRecord | undefined>
  readonly getRevision: (revisionId: ScenarioRevisionId) => Promise<ScenarioRevision | undefined>
  readonly currentRevision: (scenarioId: string) => Promise<ScenarioRevision | undefined>
  readonly delete: (scenarioId: string, expectedRevisionId: ScenarioRevisionId) => Promise<boolean>
}

const asScenarioRevision = (
  revision: DefinitionRevision<ScenarioSource>,
): ScenarioRevision => ({ ...revision, id: scenarioRevisionIdSchema.parse(revision.id) })

export const createLocalScenarioLibrary = (config: {
  readonly workspaceId: WorkspaceId
  readonly rootDir: string
}): ScenarioLibrary => {
  const store: RevisionedDefinitionStore<ScenarioSource> = createRevisionedDefinitionStore({
    workspaceId: config.workspaceId,
    rootDir: config.rootDir,
    documentSchema: scenarioSourceSchema,
    metadata: source => ({
      id: source.id,
      title: source.title,
      ...(source.description === undefined ? {} : { description: source.description }),
    }),
  })
  return {
    seed: sources => store.seed(sources),
    create: async source => asScenarioRevision(await store.create(source)),
    update: async (source, expectedRevisionId) => asScenarioRevision(await store.update(source, expectedRevisionId)),
    list: () => store.list(),
    get: scenarioId => store.get(scenarioId),
    getRevision: async revisionId => {
      const revision = await store.getRevision(revisionId)
      return revision === undefined ? undefined : asScenarioRevision(revision)
    },
    currentRevision: async scenarioId => {
      const revision = await store.currentRevision(scenarioId)
      return revision === undefined ? undefined : asScenarioRevision(revision)
    },
    delete: (scenarioId, expectedRevisionId) => store.delete(scenarioId, expectedRevisionId),
  }
}
