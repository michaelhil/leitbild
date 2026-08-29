import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { workspaceIdSchema, type WorkspaceId } from '@samsinn-leitbild/platform-contracts'
import { scenarioDefinitionSchema, type ScenarioDefinition } from '../model/index.ts'

const scenarioRevisionIdSchema = z.string()
  .regex(/^revision-[a-f0-9]{32}$/)
  .brand<'ScenarioRevisionId'>()

export type ScenarioRevisionId = z.infer<typeof scenarioRevisionIdSchema>

const scenarioRecordSchema = z.object({
  id: z.string().min(1).max(128),
  title: z.string().min(1),
  description: z.string().optional(),
  currentRevisionId: scenarioRevisionIdSchema,
  revisionIds: z.array(scenarioRevisionIdSchema).min(1),
}).strict()

export type ScenarioRecord = z.infer<typeof scenarioRecordSchema>

const scenarioRevisionSchema = z.object({
  schemaVersion: z.literal(1),
  id: scenarioRevisionIdSchema,
  workspaceId: workspaceIdSchema,
  scenarioId: z.string().min(1).max(128),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.string().datetime({ offset: true }),
  definition: scenarioDefinitionSchema,
}).strict()

export type ScenarioRevision = Omit<z.infer<typeof scenarioRevisionSchema>, 'definition'> & {
  readonly definition: ScenarioDefinition
}

const scenarioLibraryIndexSchema = z.object({
  schemaVersion: z.literal(1),
  workspaceId: workspaceIdSchema,
  scenarios: z.array(scenarioRecordSchema),
}).strict().superRefine((index, ctx) => {
  const scenarioIds = new Set<string>()
  index.scenarios.forEach((scenario, scenarioIndex) => {
    if (scenarioIds.has(scenario.id)) {
      ctx.addIssue({ code: 'custom', path: ['scenarios', scenarioIndex, 'id'], message: `duplicate Scenario id: ${scenario.id}` })
    }
    scenarioIds.add(scenario.id)
    if (!scenario.revisionIds.includes(scenario.currentRevisionId)) {
      ctx.addIssue({ code: 'custom', path: ['scenarios', scenarioIndex, 'currentRevisionId'], message: 'current revision is not in revision history' })
    }
  })
})

type ScenarioLibraryIndex = z.infer<typeof scenarioLibraryIndexSchema>

export interface ScenarioLibrary {
  readonly materializeTemplates: (templates: ReadonlyArray<ScenarioDefinition>) => Promise<void>
  readonly list: () => Promise<ReadonlyArray<ScenarioRecord>>
  readonly get: (scenarioId: string) => Promise<ScenarioRecord | undefined>
  readonly getRevision: (revisionId: ScenarioRevisionId) => Promise<ScenarioRevision | undefined>
  readonly currentRevision: (scenarioId: string) => Promise<ScenarioRevision | undefined>
}

const stableJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
    return `{${entries.join(',')}}`
  }
  return JSON.stringify(value)
}

const digestDefinition = (definition: ScenarioDefinition): string =>
  createHash('sha256').update(stableJson(definition)).digest('hex')

export const createLocalScenarioLibrary = (config: {
  readonly workspaceId: WorkspaceId
  readonly rootDir: string
}): ScenarioLibrary => {
  const indexPath = join(config.rootDir, 'catalog.json')
  const revisionsDir = join(config.rootDir, 'revisions')
  let mutationQueue: Promise<void> = Promise.resolve()

  const emptyIndex = (): ScenarioLibraryIndex => ({
    schemaVersion: 1,
    workspaceId: config.workspaceId,
    scenarios: [],
  })

  const loadIndex = async (): Promise<ScenarioLibraryIndex> => {
    try {
      const index = scenarioLibraryIndexSchema.parse(JSON.parse(await readFile(indexPath, 'utf8')) as unknown)
      if (index.workspaceId !== config.workspaceId) throw new Error(`Scenario Library Workspace mismatch: ${index.workspaceId}`)
      return index
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return emptyIndex()
      throw err
    }
  }

  const atomicWrite = async (path: string, value: unknown): Promise<void> => {
    await mkdir(dirname(path), { recursive: true })
    const temporaryPath = `${path}.${randomUUID()}.tmp`
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    await rename(temporaryPath, path)
  }

  const saveIndex = async (index: ScenarioLibraryIndex): Promise<void> => {
    await atomicWrite(indexPath, scenarioLibraryIndexSchema.parse(index))
  }

  const revisionPath = (id: ScenarioRevisionId): string => join(revisionsDir, `${id}.json`)

  const loadRevision = async (id: ScenarioRevisionId): Promise<ScenarioRevision | undefined> => {
    try {
      const revision = scenarioRevisionSchema.parse(JSON.parse(await readFile(revisionPath(id), 'utf8')) as unknown) as ScenarioRevision
      if (revision.workspaceId !== config.workspaceId) throw new Error(`Scenario Revision Workspace mismatch: ${revision.workspaceId}`)
      return revision
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw err
    }
  }

  const materializeTemplates = (templates: ReadonlyArray<ScenarioDefinition>): Promise<void> => {
    const operation = mutationQueue.then(async () => {
      const definitions = templates.map(template => scenarioDefinitionSchema.parse(template) as ScenarioDefinition)
      const duplicate = definitions.find((definition, index) => definitions.findIndex(candidate => candidate.id === definition.id) !== index)
      if (duplicate) throw new Error(`duplicate Scenario template id: ${duplicate.id}`)
      const index = await loadIndex()
      const records = new Map(index.scenarios.map(record => [record.id, record]))

      for (const definition of definitions) {
        const digest = digestDefinition(definition)
        const revisionId = scenarioRevisionIdSchema.parse(`revision-${digest.slice(0, 32)}`)
        const existingRevision = await loadRevision(revisionId)
        if (existingRevision) {
          if (existingRevision.digest !== digest || stableJson(existingRevision.definition) !== stableJson(definition)) {
            throw new Error(`Scenario Revision digest collision: ${revisionId}`)
          }
        } else {
          const revision = scenarioRevisionSchema.parse({
            schemaVersion: 1,
            id: revisionId,
            workspaceId: config.workspaceId,
            scenarioId: definition.id,
            digest,
            createdAt: new Date().toISOString(),
            definition,
          }) as ScenarioRevision
          await atomicWrite(revisionPath(revisionId), revision)
        }

        const current = records.get(definition.id)
        records.set(definition.id, scenarioRecordSchema.parse({
          id: definition.id,
          title: definition.title,
          ...(definition.description === undefined ? {} : { description: definition.description }),
          currentRevisionId: revisionId,
          revisionIds: current?.revisionIds.includes(revisionId)
            ? current.revisionIds
            : [...(current?.revisionIds ?? []), revisionId],
        }))
      }

      await saveIndex({
        schemaVersion: 1,
        workspaceId: config.workspaceId,
        scenarios: [...records.values()].sort((left, right) => left.id.localeCompare(right.id)),
      })
    })
    mutationQueue = operation.then(() => undefined, () => undefined)
    return operation
  }

  return {
    materializeTemplates,
    list: async () => (await loadIndex()).scenarios,
    get: async (scenarioId) => (await loadIndex()).scenarios.find(scenario => scenario.id === scenarioId),
    getRevision: loadRevision,
    currentRevision: async (scenarioId) => {
      const record = (await loadIndex()).scenarios.find(scenario => scenario.id === scenarioId)
      return record ? await loadRevision(record.currentRevisionId) : undefined
    },
  }
}
