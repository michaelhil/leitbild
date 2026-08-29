import { describe, expect, test } from 'bun:test'
import {
  moduleBindingSchema,
  newWorkspaceId,
  type WorkspaceId,
} from '@samsinn-leitbild/platform-contracts'
import type {
  WorkspaceDirectory,
  WorkspaceRecord,
} from '../core/workspaces/directory.ts'
import { handleWorkspaceDirectoryApi } from './workspace-api.ts'

const createDirectory = (): WorkspaceDirectory => {
  const records = new Map<WorkspaceId, WorkspaceRecord>()
  const ensure = async (config: { readonly id: WorkspaceId; readonly displayName: string; readonly modules?: WorkspaceRecord['modules'] }): Promise<WorkspaceRecord> => {
    const existing = records.get(config.id)
    if (existing) {
      if (config.modules === undefined) return existing
      const updated = { ...existing, modules: config.modules, updatedAt: new Date().toISOString() }
      records.set(config.id, updated)
      return updated
    }
    const timestamp = new Date().toISOString()
    const record = { id: config.id, displayName: config.displayName, modules: config.modules ?? [], createdAt: timestamp, updatedAt: timestamp }
    records.set(config.id, record)
    return record
  }
  return {
    list: async () => [...records.values()],
    get: async id => records.get(id),
    ensure,
    ensureDefault: async displayName => ensure({ id: newWorkspaceId(), displayName: displayName ?? 'Workspace' }),
  }
}

const call = (
  directory: WorkspaceDirectory,
  method: string,
  pathname: string,
  body?: unknown,
): Promise<Response | null> => {
  const request = new Request(`https://samsinn.test${pathname}`, {
    method,
    ...(body === undefined ? {} : {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  })
  return handleWorkspaceDirectoryApi(request, new URL(request.url), directory, crypto.randomUUID())
}

describe('Workspace directory API', () => {
  test('creates and lists Workspaces at the canonical collection', async () => {
    const directory = createDirectory()
    const created = await call(directory, 'POST', '/api/workspaces', { displayName: 'Exercise Alpha' })
    expect(created?.status).toBe(201)
    const createdBody = await created!.json() as { workspace: WorkspaceRecord }

    const listed = await call(directory, 'GET', '/api/workspaces')
    expect(await listed!.json()).toEqual({ workspaces: [createdBody.workspace] })
  })

  test('provisions a caller-selected canonical Workspace id idempotently', async () => {
    const directory = createDirectory()
    const workspaceId = newWorkspaceId()
    const path = `/api/workspaces/${workspaceId}`
    expect((await call(directory, 'PUT', path, { displayName: 'Coordinated Workspace' }))?.status).toBe(201)
    expect((await call(directory, 'PUT', path, { displayName: 'Coordinated Workspace' }))?.status).toBe(200)
  })

  test('stores Module Bindings and refreshes a loaded Workspace cache', async () => {
    const directory = createDirectory()
    const workspaceId = newWorkspaceId()
    const modules = [moduleBindingSchema.parse({
      moduleId: 'leitbild',
      baseUrl: 'https://leitbild.test',
      discoveryUrl: 'https://leitbild.test/.well-known/leitbild',
    })]
    const observed: unknown[] = []
    const request = new Request(`https://samsinn.test/api/workspaces/${workspaceId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName: 'Connected Workspace', modules }),
    })
    const response = await handleWorkspaceDirectoryApi(
      request,
      new URL(request.url),
      directory,
      crypto.randomUUID(),
      (id, bindings) => observed.push({ id, bindings }),
    )
    expect(response?.status).toBe(201)
    expect((await response!.json() as { workspace: WorkspaceRecord }).workspace.modules).toEqual(modules)
    expect(observed).toEqual([{ id: workspaceId, bindings: modules }])
  })

  test('rejects conflicting provisioning metadata', async () => {
    const directory = createDirectory()
    const workspaceId = newWorkspaceId()
    const path = `/api/workspaces/${workspaceId}`
    await call(directory, 'PUT', path, { displayName: 'First Name' })
    const response = await call(directory, 'PUT', path, { displayName: 'Second Name' })
    expect(response?.status).toBe(409)
    expect(await response!.json()).toEqual({
      error: {
        code: 'workspace_conflict',
        message: 'Workspace display name does not match the existing Workspace',
      },
    })
  })

  test('fails visibly on invalid request bodies', async () => {
    const response = await call(createDirectory(), 'POST', '/api/workspaces', { display_name: 'wrong field' })
    expect(response?.status).toBe(400)
    expect((await response!.json() as { error: { code: string } }).error.code).toBe('invalid_request')
  })
})
