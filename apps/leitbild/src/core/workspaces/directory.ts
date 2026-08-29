import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { z } from 'zod'
import { isoTimestampSchema, workspaceIdSchema, type WorkspaceId } from '@samsinn-leitbild/platform-contracts'

export interface WorkspaceRecord {
  readonly id: WorkspaceId
  readonly createdAt: string
}

export interface WorkspaceDirectory {
  readonly list: () => Promise<ReadonlyArray<WorkspaceRecord>>
  readonly get: (id: WorkspaceId) => Promise<WorkspaceRecord | undefined>
  readonly create: (id: WorkspaceId) => Promise<WorkspaceRecord>
  readonly delete: (id: WorkspaceId) => Promise<boolean>
}

const workspaceRecordSchema = z.object({
  id: workspaceIdSchema,
  createdAt: isoTimestampSchema,
}).strict()

const directoryFileSchema = z.object({
  schemaVersion: z.literal(2),
  workspaces: z.array(workspaceRecordSchema),
}).strict().superRefine((file, ctx) => {
  const seen = new Set<string>()
  file.workspaces.forEach((workspace, index) => {
    if (seen.has(workspace.id)) {
      ctx.addIssue({ code: 'custom', path: ['workspaces', index, 'id'], message: `duplicate Workspace id: ${workspace.id}` })
    }
    seen.add(workspace.id)
  })
})

type DirectoryFile = z.infer<typeof directoryFileSchema>

const emptyDirectory = (): DirectoryFile => ({ schemaVersion: 2, workspaces: [] })

export const createLocalWorkspaceDirectory = (config: { readonly path: string }): WorkspaceDirectory => {
  let mutationQueue: Promise<void> = Promise.resolve()

  const load = async (): Promise<DirectoryFile> => {
    try {
      return directoryFileSchema.parse(JSON.parse(await readFile(config.path, 'utf8')) as unknown)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyDirectory()
      throw error
    }
  }

  const save = async (file: DirectoryFile): Promise<void> => {
    const validated = directoryFileSchema.parse(file)
    await mkdir(dirname(config.path), { recursive: true })
    const temporaryPath = `${config.path}.${randomUUID()}.tmp`
    await writeFile(temporaryPath, `${JSON.stringify(validated, null, 2)}\n`, 'utf8')
    await rename(temporaryPath, config.path)
  }

  const mutate = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = mutationQueue.then(operation)
    mutationQueue = result.then(() => undefined, () => undefined)
    return result
  }

  return {
    list: async () => (await load()).workspaces,
    get: async id => (await load()).workspaces.find(workspace => workspace.id === id),
    create: id => mutate(async () => {
      const parsedId = workspaceIdSchema.parse(id)
      const file = await load()
      const existing = file.workspaces.find(workspace => workspace.id === parsedId)
      if (existing) return existing
      const record = workspaceRecordSchema.parse({ id: parsedId, createdAt: new Date().toISOString() })
      await save({ schemaVersion: 2, workspaces: [...file.workspaces, record] })
      return record
    }),
    delete: id => mutate(async () => {
      const parsedId = workspaceIdSchema.parse(id)
      const file = await load()
      if (!file.workspaces.some(workspace => workspace.id === parsedId)) return false
      await save({
        schemaVersion: 2,
        workspaces: file.workspaces.filter(workspace => workspace.id !== parsedId),
      })
      return true
    }),
  }
}
