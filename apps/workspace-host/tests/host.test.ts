import { afterEach, describe, expect, test } from 'bun:test'
import { moduleIdSchema, moduleRegistrationSchema, type WorkspaceId } from '@samsinn-leitbild/platform-contracts'
import { createWorkspaceHost } from '../src/host.ts'
import { createModuleGateway } from '../src/module-gateway.ts'
import { createWorkspaceStore } from '../src/store.ts'

const servers: Bun.Server<unknown>[] = []

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true)
})

const createMicroworldModule = () => {
  const state = {
    available: true,
    failLeave: false,
    workspaces: new Set<string>(),
  }
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(request) {
      const url = new URL(request.url)
      if (url.pathname === '/.well-known/workspace-module' && request.method === 'GET') {
        if (!state.available) return new Response('offline', { status: 503 })
        return Response.json({
          module: { id: 'microworld', title: 'Microworld' },
          endpoints: {
            workspace: '/internal/workspaces/{workspaceId}',
            resources: '/internal/workspaces/{workspaceId}/resources',
            capabilities: '/internal/workspaces/{workspaceId}/capabilities',
            invoke: '/internal/workspaces/{workspaceId}/capabilities/{capabilityId}/invoke',
          },
        })
      }
      const match = url.pathname.match(/^\/internal\/workspaces\/([^/]+)$/)
      if (match && request.method === 'PUT') {
        state.workspaces.add(decodeURIComponent(match[1] ?? ''))
        return Response.json({ ok: true }, { status: 201 })
      }
      if (match && request.method === 'DELETE') {
        if (state.failLeave) return new Response('unavailable', { status: 503 })
        state.workspaces.delete(decodeURIComponent(match[1] ?? ''))
        return new Response(null, { status: 204 })
      }
      return new Response('not found', { status: 404 })
    },
  })
  servers.push(server)
  return {
    state,
    registration: moduleRegistrationSchema.parse({
      moduleId: 'microworld',
      baseUrl: `http://127.0.0.1:${server.port}`,
      manifestPath: '/.well-known/workspace-module',
    }),
  }
}

const createHost = (registrations: Parameters<typeof createModuleGateway>[0]['registrations']) => {
  const store = createWorkspaceStore(':memory:')
  return {
    store,
    host: createWorkspaceHost({ store, modules: createModuleGateway({ registrations }) }),
  }
}

describe('Workspace Host', () => {
  test('owns Workspace lifecycle while a Module owns its Workspace state', async () => {
    const module = createMicroworldModule()
    const { host, store } = createHost([module.registration])
    const workspace = await host.create({ name: null })
    expect(workspace.name).toBeNull()
    expect(workspace.modules).toEqual([])

    const joined = await host.addModule(workspace.id, moduleIdSchema.parse('microworld'))
    expect(joined.modules[0]?.status).toBe('ready')
    expect(module.state.workspaces.has(workspace.id)).toBe(true)

    expect(host.rename(workspace.id, { name: 'Exercise Alpha' }).name).toBe('Exercise Alpha')
    const removed = await host.removeModule(workspace.id, moduleIdSchema.parse('microworld'))
    expect(removed.modules).toEqual([])
    expect(module.state.workspaces.has(workspace.id)).toBe(false)

    await host.delete(workspace.id)
    expect(host.get(workspace.id)).toBeUndefined()
    store.close()
  })

  test('records failed joins and retries the operation explicitly', async () => {
    const module = createMicroworldModule()
    module.state.available = false
    const { host, store } = createHost([module.registration])
    const moduleId = moduleIdSchema.parse('microworld')
    const workspace = await host.create({ name: null, moduleIds: [moduleId] })
    expect(workspace.modules[0]).toMatchObject({
      moduleId,
      status: 'join_failed',
      failure: { code: 'module_discovery_failed', retryable: true },
    })

    module.state.available = true
    const recovered = await host.retryModule(workspace.id, moduleId)
    expect(recovered.modules[0]?.status).toBe('ready')
    store.close()
  })

  test('does not hide failed cleanup by deleting the Workspace', async () => {
    const module = createMicroworldModule()
    const { host, store } = createHost([module.registration])
    const workspace = await host.create({ name: null, moduleIds: [moduleIdSchema.parse('microworld')] })
    module.state.failLeave = true

    await expect(host.delete(workspace.id)).rejects.toMatchObject({ code: 'workspace_delete_incomplete' })
    expect(host.get(workspace.id)?.modules[0]?.status).toBe('leave_failed')
    store.close()
  })
})
