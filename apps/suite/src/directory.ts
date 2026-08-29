import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { z } from 'zod'
import { type WorkspaceId } from '@samsinn-leitbild/platform-contracts'
import { suiteWorkspaceSchema, type SuiteWorkspace } from './model.ts'

const directoryFileSchema = z.object({
  schemaVersion: z.literal(1),
  workspaces: z.array(suiteWorkspaceSchema),
}).strict().superRefine((file, ctx) => {
  const seen = new Set<string>()
  file.workspaces.forEach((workspace, index) => {
    if (seen.has(workspace.id)) {
      ctx.addIssue({ code: 'custom', path: ['workspaces', index, 'id'], message: `duplicate Workspace: ${workspace.id}` })
    }
    seen.add(workspace.id)
  })
})
type DirectoryFile = z.infer<typeof directoryFileSchema>

export interface SuiteWorkspaceDirectory {
  readonly list: () => Promise<ReadonlyArray<SuiteWorkspace>>
  readonly get: (id: WorkspaceId) => Promise<SuiteWorkspace | undefined>
  readonly save: (workspace: SuiteWorkspace) => Promise<SuiteWorkspace>
}

export const createSuiteWorkspaceDirectory = (path: string): SuiteWorkspaceDirectory => {
  let mutationQueue: Promise<void> = Promise.resolve()

  const load = async (): Promise<DirectoryFile> => {
    try {
      return directoryFileSchema.parse(JSON.parse(await readFile(path, 'utf8')) as unknown)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { schemaVersion: 1, workspaces: [] }
      throw error
    }
  }

  const write = async (file: DirectoryFile): Promise<void> => {
    const parsed = directoryFileSchema.parse(file)
    await mkdir(dirname(path), { recursive: true })
    const temporaryPath = `${path}.${randomUUID()}.tmp`
    await writeFile(temporaryPath, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8')
    await rename(temporaryPath, path)
  }

  const mutate = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = mutationQueue.then(operation)
    mutationQueue = result.then(() => undefined, () => undefined)
    return result
  }

  return {
    list: async () => (await load()).workspaces,
    get: async id => (await load()).workspaces.find(workspace => workspace.id === id),
    save: workspace => mutate(async () => {
      const parsed = suiteWorkspaceSchema.parse(workspace)
      const file = await load()
      const exists = file.workspaces.some(candidate => candidate.id === parsed.id)
      await write({
        schemaVersion: 1,
        workspaces: exists
          ? file.workspaces.map(candidate => candidate.id === parsed.id ? parsed : candidate)
          : [...file.workspaces, parsed],
      })
      return parsed
    }),
  }
}
