import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { workspaceIdSchema, type WorkspaceId } from '@leitbild/contracts'
import { scenarioDefinitionSchema, type ScenarioDefinition } from '../model/index.ts'
import { scenarioDraftSchema, type ScenarioDraft, type ScenarioTemplate } from './config.ts'

export const scenarioRevisionIdSchema = z.string()
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
  draft: scenarioDraftSchema,
  definition: scenarioDefinitionSchema,
}).strict()

export type ScenarioRevision = Omit<z.infer<typeof scenarioRevisionSchema>, 'draft' | 'definition'> & {
  readonly draft: ScenarioDraft
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
  readonly materializeTemplates: (templates: ReadonlyArray<ScenarioTemplate>) => Promise<void>
  readonly create: (template: ScenarioTemplate) => Promise<ScenarioRevision>
  readonly update: (template: ScenarioTemplate, expectedRevisionId: ScenarioRevisionId) => Promise<ScenarioRevision>
  readonly list: () => Promise<ReadonlyArray<ScenarioRecord>>
  readonly get: (scenarioId: string) => Promise<ScenarioRecord | undefined>
  readonly getRevision: (revisionId: ScenarioRevisionId) => Promise<ScenarioRevision | undefined>
  readonly currentRevision: (scenarioId: string) => Promise<ScenarioRevision | undefined>
  readonly delete: (scenarioId: string) => Promise<boolean>
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

const digestTemplate = (template: ScenarioTemplate): string =>
  createHash('sha256').update(stableJson(template)).digest('hex')

export const createLocalScenarioLibrary = (config: {
  readonly workspaceId: WorkspaceId
  readonly rootDir: string
}): ScenarioLibrary => {
  const indexPath = join(config.rootDir, 'catalog.json')
  const revisionsDir = join(config.rootDir, 'revisions')
  const deletionsPath = join(config.rootDir, 'deleted-definitions.json')
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

  const deletedDefinitionsSchema = z.object({
    definitionIds: z.array(z.string().min(1).max(128)),
  }).strict()

  const loadDeletedDefinitionIds = async (): Promise<ReadonlySet<string>> => {
    try {
      const stored = deletedDefinitionsSchema.parse(JSON.parse(await readFile(deletionsPath, 'utf8')) as unknown)
      return new Set(stored.definitionIds)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return new Set()
      throw err
    }
  }

  const saveDeletedDefinitionIds = async (definitionIds: ReadonlySet<string>): Promise<void> => {
    await atomicWrite(deletionsPath, {
      definitionIds: [...definitionIds].sort((left, right) => left.localeCompare(right)),
    })
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

  const parsedTemplate = (template: ScenarioTemplate): ScenarioTemplate => {
    const draft = scenarioDraftSchema.parse(template.draft)
    const definition = scenarioDefinitionSchema.parse(template.definition) as ScenarioDefinition
    if (draft.id !== definition.id) throw new Error(`Scenario template identity mismatch: ${draft.id} != ${definition.id}`)
    return { draft, definition }
  }

  const revisionFor = (template: ScenarioTemplate): ScenarioRevision => {
    const parsed = parsedTemplate(template)
    const digest = digestTemplate(parsed)
    return scenarioRevisionSchema.parse({
      schemaVersion: 1,
      id: `revision-${digest.slice(0, 32)}`,
      workspaceId: config.workspaceId,
      scenarioId: parsed.definition.id,
      digest,
      createdAt: new Date().toISOString(),
      draft: parsed.draft,
      definition: parsed.definition,
    }) as ScenarioRevision
  }

  const writeRevision = async (revision: ScenarioRevision): Promise<void> => {
    const existing = await loadRevision(revision.id)
    if (existing) {
      if (existing.digest !== revision.digest || stableJson(existing) !== stableJson({ ...revision, createdAt: existing.createdAt })) {
        throw new Error(`Scenario Revision digest collision: ${revision.id}`)
      }
      return
    }
    await atomicWrite(revisionPath(revision.id), revision)
  }

  const materializeTemplates = (templates: ReadonlyArray<ScenarioTemplate>): Promise<void> => {
    const operation = mutationQueue.then(async () => {
      const parsedTemplates = templates.map(parsedTemplate)
      const duplicate = parsedTemplates.find((template, index) => parsedTemplates.findIndex(candidate => candidate.definition.id === template.definition.id) !== index)
      if (duplicate) throw new Error(`duplicate Scenario template id: ${duplicate.definition.id}`)
      const index = await loadIndex()
      const deletedDefinitionIds = await loadDeletedDefinitionIds()
      const records = new Map(index.scenarios.map(record => [record.id, record]))

      for (const template of parsedTemplates) {
        const definition = template.definition
        if (deletedDefinitionIds.has(definition.id)) continue
        const revision = revisionFor(template)
        await writeRevision(revision)

        const current = records.get(definition.id)
        records.set(definition.id, scenarioRecordSchema.parse({
          id: definition.id,
          title: definition.title,
          ...(definition.description === undefined ? {} : { description: definition.description }),
          currentRevisionId: revision.id,
          revisionIds: current?.revisionIds.includes(revision.id)
            ? current.revisionIds
            : [...(current?.revisionIds ?? []), revision.id],
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
    create: template => {
      const operation = mutationQueue.then(async () => {
        const revision = revisionFor(template)
        const index = await loadIndex()
        if (index.scenarios.some(scenario => scenario.id === revision.scenarioId)) {
          throw new Error(`Scenario already exists: ${revision.scenarioId}`)
        }
        await writeRevision(revision)
        await saveIndex({
          ...index,
          scenarios: [...index.scenarios, scenarioRecordSchema.parse({
            id: revision.scenarioId,
            title: revision.definition.title,
            ...(revision.definition.description === undefined ? {} : { description: revision.definition.description }),
            currentRevisionId: revision.id,
            revisionIds: [revision.id],
          })].sort((left, right) => left.id.localeCompare(right.id)),
        })
        return revision
      })
      mutationQueue = operation.then(() => undefined, () => undefined)
      return operation
    },
    update: (template, expectedRevisionId) => {
      const operation = mutationQueue.then(async () => {
        const revision = revisionFor(template)
        const index = await loadIndex()
        const record = index.scenarios.find(scenario => scenario.id === revision.scenarioId)
        if (!record) throw new Error(`Scenario not found: ${revision.scenarioId}`)
        if (record.currentRevisionId !== expectedRevisionId) throw new Error(`Scenario Revision changed: ${revision.scenarioId}`)
        await writeRevision(revision)
        await saveIndex({
          ...index,
          scenarios: index.scenarios.map(scenario => scenario.id !== revision.scenarioId ? scenario : scenarioRecordSchema.parse({
            id: scenario.id,
            title: revision.definition.title,
            ...(revision.definition.description === undefined ? {} : { description: revision.definition.description }),
            currentRevisionId: revision.id,
            revisionIds: scenario.revisionIds.includes(revision.id) ? scenario.revisionIds : [...scenario.revisionIds, revision.id],
          })),
        })
        return revision
      })
      mutationQueue = operation.then(() => undefined, () => undefined)
      return operation
    },
    list: async () => (await loadIndex()).scenarios,
    get: async (scenarioId) => (await loadIndex()).scenarios.find(scenario => scenario.id === scenarioId),
    getRevision: loadRevision,
    currentRevision: async (scenarioId) => {
      const record = (await loadIndex()).scenarios.find(scenario => scenario.id === scenarioId)
      return record ? await loadRevision(record.currentRevisionId) : undefined
    },
    delete: scenarioId => {
      const operation = mutationQueue.then(async () => {
        const index = await loadIndex()
        const exists = index.scenarios.some(scenario => scenario.id === scenarioId)
        if (!exists) return false
        const deletedDefinitionIds = new Set(await loadDeletedDefinitionIds())
        deletedDefinitionIds.add(scenarioId)
        await saveDeletedDefinitionIds(deletedDefinitionIds)
        await saveIndex({
          ...index,
          scenarios: index.scenarios.filter(scenario => scenario.id !== scenarioId),
        })
        return true
      })
      mutationQueue = operation.then(() => undefined, () => undefined)
      return operation
    },
  }
}
