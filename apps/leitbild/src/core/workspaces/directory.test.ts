import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { newWorkspaceId } from '@samsinn-leitbild/platform-contracts'
import { createLocalWorkspaceDirectory } from './directory.ts'
import { createOpenAccessContext } from './request-context.ts'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

const createDirectory = async () => {
  const root = await mkdtemp(join(tmpdir(), 'leitbild-workspaces-'))
  temporaryDirectories.push(root)
  const path = join(root, 'directory.json')
  return { path, directory: createLocalWorkspaceDirectory({ path }) }
}

describe('Microworld Workspace shard directory', () => {
  test('creates only Host-supplied Workspace ids and persists no Host metadata', async () => {
    const { path, directory } = await createDirectory()
    const id = newWorkspaceId()
    const first = await directory.create(id)
    const reloaded = createLocalWorkspaceDirectory({ path })
    expect(await reloaded.create(id)).toEqual(first)
    expect(first).toEqual({ id, createdAt: expect.any(String) })
  })

  test('keeps and deletes independent Workspace shards without a default or archive', async () => {
    const { directory } = await createDirectory()
    const first = await directory.create(newWorkspaceId())
    const second = await directory.create(newWorkspaceId())
    expect((await directory.list()).map(workspace => workspace.id)).toEqual([first.id, second.id])
    expect(await directory.delete(first.id)).toBe(true)
    expect(await directory.get(first.id)).toBeUndefined()
    expect(await directory.get(second.id)).toEqual(second)
  })

  test('fails visibly for corrupt or obsolete persisted data', async () => {
    const { path, directory } = await createDirectory()
    await writeFile(path, JSON.stringify({ schemaVersion: 1, workspaces: [] }), 'utf8')
    expect(directory.list()).rejects.toThrow()
  })

  test('creates explicit open access context and rejects malformed supplied request ids', async () => {
    const { directory } = await createDirectory()
    const workspace = await directory.create(newWorkspaceId())
    expect(createOpenAccessContext(workspace.id, new Request('http://leitbild.test')).workspaceId).toBe(workspace.id)
    expect(() => createOpenAccessContext(workspace.id, new Request('http://leitbild.test', {
      headers: { 'x-request-id': 'not-a-uuid' },
    }))).toThrow()
  })
})
