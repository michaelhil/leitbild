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
  return { path, directory: createLocalWorkspaceDirectory({ path, defaultDisplayName: 'Leitbild' }) }
}

describe('local Workspace directory', () => {
  test('persists one stable default Workspace', async () => {
    const { path, directory } = await createDirectory()
    const first = await directory.ensureDefault()
    const reloaded = createLocalWorkspaceDirectory({ path, defaultDisplayName: 'Ignored after creation' })
    expect((await reloaded.ensureDefault()).id).toBe(first.id)
  })

  test('keeps independent Workspace records and archives explicitly', async () => {
    const { directory } = await createDirectory()
    const first = await directory.ensure({ id: newWorkspaceId(), displayName: 'First' })
    const second = await directory.ensure({ id: newWorkspaceId(), displayName: 'Second' })
    expect(await directory.archive(first.id)).toBe(true)
    expect((await directory.get(first.id))?.status).toBe('archived')
    expect((await directory.get(second.id))?.status).toBe('active')
  })

  test('fails visibly for corrupt persisted data', async () => {
    const { path, directory } = await createDirectory()
    await writeFile(path, '{broken', 'utf8')
    expect(directory.list()).rejects.toThrow()
  })

  test('creates explicit open access context and rejects malformed supplied request ids', async () => {
    const { directory } = await createDirectory()
    const workspace = await directory.ensureDefault()
    expect(createOpenAccessContext(workspace.id, new Request('http://leitbild.test')).workspaceId).toBe(workspace.id)
    expect(() => createOpenAccessContext(workspace.id, new Request('http://leitbild.test', {
      headers: { 'x-request-id': 'not-a-uuid' },
    }))).toThrow()
  })
})
