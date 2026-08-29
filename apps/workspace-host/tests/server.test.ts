import { afterEach, describe, expect, test } from 'bun:test'
import { moduleIdSchema } from '@samsinn-leitbild/platform-contracts'
import { createWorkspaceHost } from '../src/host.ts'
import { createModuleGateway } from '../src/module-gateway.ts'
import { createWorkspaceHostServer } from '../src/server.ts'
import { createWorkspaceStore, type WorkspaceStore } from '../src/store.ts'

const servers: Array<ReturnType<typeof createWorkspaceHostServer>> = []
const stores: WorkspaceStore[] = []

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true)
  for (const store of stores.splice(0)) store.close()
})

const startHost = () => {
  const store = createWorkspaceStore(':memory:')
  stores.push(store)
  const host = createWorkspaceHost({ store, modules: createModuleGateway({ registrations: [] }) })
  const server = createWorkspaceHostServer({ host, port: 0, bindHost: '127.0.0.1' })
  servers.push(server)
  return { host, baseUrl: `http://127.0.0.1:${server.port}` }
}

describe('Workspace Host server', () => {
  test('creates one unnamed Workspace at an empty root and selects it only by URL', async () => {
    const { host, baseUrl } = startHost()
    const response = await fetch(`${baseUrl}/`, { redirect: 'manual' })
    expect(response.status).toBe(303)
    expect(response.headers.get('set-cookie')).toBeNull()
    const location = response.headers.get('location')!
    expect(location).toMatch(/\/workspaces\/[0-9a-f-]{36}$/)
    expect(host.list()).toHaveLength(1)
    expect(host.list()[0]?.name).toBeNull()

    const secondTab = await fetch(location)
    expect(secondTab.status).toBe(200)
    expect(secondTab.headers.get('set-cookie')).toBeNull()
  })

  test('supports versionless create, rename, read, and delete APIs', async () => {
    const { baseUrl } = startHost()
    const createdResponse = await fetch(`${baseUrl}/api/workspaces`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(createdResponse.status).toBe(201)
    const created = (await createdResponse.json() as { workspace: { id: string; name: string | null } }).workspace
    expect(created.name).toBeNull()

    const renamedResponse = await fetch(`${baseUrl}/api/workspaces/${created.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Exercise Alpha' }),
    })
    expect((await renamedResponse.json() as { workspace: { name: string } }).workspace.name).toBe('Exercise Alpha')

    expect((await fetch(`${baseUrl}/api/workspaces/${created.id}`)).status).toBe(200)
    expect((await fetch(`${baseUrl}/api/workspaces/${created.id}`, { method: 'DELETE' })).status).toBe(204)
    expect((await fetch(`${baseUrl}/api/workspaces/${created.id}`)).status).toBe(404)
  })

  test('rejects unknown Modules instead of inventing a fallback registration', async () => {
    const { baseUrl } = startHost()
    const created = (await fetch(`${baseUrl}/api/workspaces`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    }).then(response => response.json()) as { workspace: { id: string } }).workspace
    const response = await fetch(`${baseUrl}/api/workspaces/${created.id}/modules/${moduleIdSchema.parse('microworld')}`, { method: 'PUT' })
    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({ error: { code: 'module_not_installed' } })
  })
})
