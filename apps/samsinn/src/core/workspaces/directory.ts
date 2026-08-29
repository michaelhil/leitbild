import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { z } from 'zod'
import { isoTimestampSchema, newWorkspaceId, workspaceIdSchema, type WorkspaceId } from '@samsinn-leitbild/platform-contracts'

export interface WorkspaceRecord {
  readonly id: WorkspaceId
  readonly displayName: string
  readonly createdAt: string
  readonly updatedAt: string
}

export interface WorkspaceDirectory {
  readonly list: () => Promise<ReadonlyArray<WorkspaceRecord>>
  readonly get: (id: WorkspaceId) => Promise<WorkspaceRecord | undefined>
  readonly ensure: (config: { readonly id: WorkspaceId; readonly displayName: string }) => Promise<WorkspaceRecord>
  readonly ensureDefault: (displayName?: string) => Promise<WorkspaceRecord>
}

const workspaceRecordSchema = z.object({
  id: workspaceIdSchema,
  displayName: z.string().min(1).max(256),
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
}).strict()

const directoryFileSchema = z.object({
  schemaVersion: z.literal(1),
  defaultWorkspaceId: workspaceIdSchema.optional(),
  workspaces: z.array(workspaceRecordSchema),
}).strict().superRefine((file, ctx) => {
  const seen = new Set<string>()
  file.workspaces.forEach((workspace, index) => {
    if (seen.has(workspace.id)) {
      ctx.addIssue({ code: 'custom', path: ['workspaces', index, 'id'], message: `duplicate Workspace id: ${workspace.id}` })
    }
    seen.add(workspace.id)
  })
  if (file.defaultWorkspaceId !== undefined && !seen.has(file.defaultWorkspaceId)) {
    ctx.addIssue({ code: 'custom', path: ['defaultWorkspaceId'], message: 'default Workspace does not exist' })
  }
})

type DirectoryFile = z.infer<typeof directoryFileSchema>

const emptyDirectory = (): DirectoryFile => ({ schemaVersion: 1, workspaces: [] })
const nowIso = (): string => new Date().toISOString()

export const createLocalWorkspaceDirectory = (config: {
  readonly path: string
  readonly defaultDisplayName: string
}): WorkspaceDirectory => {
  let mutationQueue: Promise<void> = Promise.resolve()

  const load = async (): Promise<DirectoryFile> => {
    let raw: string
    try {
      raw = await readFile(config.path, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return emptyDirectory()
      throw err
    }
    return directoryFileSchema.parse(JSON.parse(raw) as unknown)
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

  const ensure = (ensureConfig: { readonly id: WorkspaceId; readonly displayName: string }): Promise<WorkspaceRecord> =>
    mutate(async () => {
      const file = await load()
      const existing = file.workspaces.find(workspace => workspace.id === ensureConfig.id)
      if (existing) return existing
      const timestamp = nowIso()
      const record: WorkspaceRecord = {
        id: ensureConfig.id,
        displayName: ensureConfig.displayName,
        createdAt: timestamp,
        updatedAt: timestamp,
      }
      await save({ ...file, workspaces: [...file.workspaces, record] })
      return record
    })

  const ensureDefault = (displayName = config.defaultDisplayName): Promise<WorkspaceRecord> =>
    mutate(async () => {
      const file = await load()
      if (file.defaultWorkspaceId !== undefined) {
        const existing = file.workspaces.find(workspace => workspace.id === file.defaultWorkspaceId)
        if (!existing) throw new Error(`default Workspace is missing: ${file.defaultWorkspaceId}`)
        return existing
      }
      const timestamp = nowIso()
      const record: WorkspaceRecord = {
        id: newWorkspaceId(),
        displayName,
        createdAt: timestamp,
        updatedAt: timestamp,
      }
      await save({
        schemaVersion: 1,
        defaultWorkspaceId: record.id,
        workspaces: [...file.workspaces, record],
      })
      return record
    })

  return {
    list: async () => (await load()).workspaces,
    get: async (id) => (await load()).workspaces.find(workspace => workspace.id === id),
    ensure,
    ensureDefault,
  }
}
