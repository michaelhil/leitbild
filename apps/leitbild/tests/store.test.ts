import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { moduleIdSchema, moduleMembershipSchema } from '@leitbild/contracts'
import { createWorkspaceStore } from '../src/store.ts'

const temporaryDirectories: string[] = []

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) await rm(directory, { recursive: true, force: true })
})

describe('Workspace Store', () => {
  test('persists unnamed Workspaces and explicit Module lifecycle state in SQLite', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'workspace-host-store-'))
    temporaryDirectories.push(directory)
    const path = join(directory, 'workspaces.sqlite')
    const moduleId = moduleIdSchema.parse('world')
    const first = createWorkspaceStore(path)
    const created = first.create({ name: null, moduleIds: [moduleId] })
    expect(created.name).toBeNull()
    expect(created.modules[0]?.status).toBe('joining')
    first.setMembership(created.id, moduleMembershipSchema.parse({
      moduleId,
      status: 'join_failed',
      failure: { code: 'module_unavailable', message: 'offline', retryable: true },
      updatedAt: new Date().toISOString(),
    }))
    first.close()

    const reopened = createWorkspaceStore(path)
    expect(reopened.get(created.id)).toMatchObject({
      id: created.id,
      name: null,
      modules: [{ moduleId, status: 'join_failed', failure: { code: 'module_unavailable', retryable: true } }],
    })
    reopened.close()
  })

  test('renames and deletes without a default or archive state', () => {
    const store = createWorkspaceStore(':memory:')
    const workspace = store.create({ name: null, moduleIds: [] })
    expect(store.rename(workspace.id, 'Exercise Alpha')?.name).toBe('Exercise Alpha')
    expect(store.delete(workspace.id)).toBe(true)
    expect(store.count()).toBe(0)
    expect(store.get(workspace.id)).toBeUndefined()
    store.close()
  })
})
