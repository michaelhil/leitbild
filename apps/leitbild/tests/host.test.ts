import { afterEach, describe, expect, test } from 'bun:test'
import {
  accessContextSchema,
  capabilityIdSchema,
  coreModuleIds,
  moduleRegistrationSchema,
  newRequestId,
  type ModuleId,
} from '@leitbild/contracts'
import { createWorkspaceHost } from '../src/host.ts'
import { createModuleGateway } from '../src/module-gateway.ts'
import { createWorkspaceStore } from '../src/store.ts'

const servers: Bun.Server<unknown>[] = []
afterEach(() => { for (const server of servers.splice(0)) server.stop(true) })

const createModule = (moduleId: ModuleId) => {
  const state = { available: true, failLeave: false, workspaces: new Set<string>() }
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      const url = new URL(request.url)
      if (url.pathname === '/manifest') {
        if (!state.available) return new Response('offline', { status: 503 })
        return Response.json({
          module: { id: moduleId, title: String(moduleId) },
          endpoints: {
            workspace: `/internal/${moduleId}/workspaces/{workspaceId}`,
            resources: `/internal/${moduleId}/workspaces/{workspaceId}/resources`,
            capabilities: `/internal/${moduleId}/workspaces/{workspaceId}/capabilities`,
            invoke: `/internal/${moduleId}/workspaces/{workspaceId}/capabilities/{capabilityId}/invoke`,
          },
          ui: { workspace: `/workspaces/{workspaceId}/${moduleId}` },
        })
      }
      const root = url.pathname.match(new RegExp(`^/internal/${moduleId}/workspaces/([^/]+)$`))
      if (root && request.method === 'PUT') {
        state.workspaces.add(decodeURIComponent(root[1] ?? ''))
        return Response.json({ ok: true }, { status: 201 })
      }
      if (root && request.method === 'DELETE') {
        if (state.failLeave) return new Response('unavailable', { status: 503 })
        state.workspaces.delete(decodeURIComponent(root[1] ?? ''))
        return new Response(null, { status: 204 })
      }
      const resources = url.pathname.match(new RegExp(`^/internal/${moduleId}/workspaces/([^/]+)/resources$`))
      if (resources) {
        const workspaceId = decodeURIComponent(resources[1] ?? '')
        return Response.json({ resources: moduleId === 'world' ? [{
          ref: { workspaceId, moduleId, type: 'world.simulation-run', id: 'run-01' },
          title: 'Run 01', capabilityIds: ['world.simulation-run.read'], observedAt: new Date().toISOString(),
        }] : [] })
      }
      if (new RegExp(`^/internal/${moduleId}/workspaces/[^/]+/capabilities$`).test(url.pathname)) {
        return Response.json({ capabilities: moduleId === 'world' ? [{
          id: 'world.simulation-run.read', moduleId, kind: 'query',
          scope: { kind: 'resource', resourceType: 'world.simulation-run' },
          title: 'Read Simulation Run', description: 'Reads the selected Simulation Run.',
          risk: 'read', idempotent: true, inputSchema: { type: 'object' }, outputSchema: { type: 'object' },
        }] : [] })
      }
      if (new RegExp(`^/internal/${moduleId}/workspaces/[^/]+/capabilities/[^/]+/invoke$`).test(url.pathname)) {
        const invocation = await request.json() as { resource?: { id: string }; input: unknown }
        return Response.json({ result: { resourceId: invocation.resource?.id, input: invocation.input } })
      }
      return new Response('not found', { status: 404 })
    },
  })
  servers.push(server)
  return {
    state,
    registration: moduleRegistrationSchema.parse({ moduleId, internalBaseUrl: `http://127.0.0.1:${server.port}`, manifestPath: '/manifest' }),
  }
}

const createFixture = () => {
  const modules = coreModuleIds.map(createModule)
  const store = createWorkspaceStore(':memory:')
  const host = createWorkspaceHost({ store, modules: createModuleGateway({ registrations: modules.map(item => item.registration) }) })
  return { modules, store, host }
}

describe('Leitbild Workspace Host', () => {
  test('provisions every core Module and owns the complete lifecycle', async () => {
    const { modules, host, store } = createFixture()
    const workspace = await host.create({ name: null })
    expect(workspace.modules.map(item => [String(item.moduleId), item.status])).toEqual([
      ['agents', 'ready'], ['world', 'ready'],
    ])
    expect(modules.every(item => item.state.workspaces.has(workspace.id))).toBe(true)
    expect(host.rename(workspace.id, { name: 'Exercise Alpha' }).name).toBe('Exercise Alpha')
    await host.delete(workspace.id)
    expect(host.get(workspace.id)).toBeUndefined()
    store.close()
  })

  test('records a failed core Module join and retries it', async () => {
    const { modules, host, store } = createFixture()
    const world = modules.find(item => item.registration.moduleId === 'world')!
    world.state.available = false
    const workspace = await host.create({ name: null })
    expect(workspace.modules.find(item => item.moduleId === 'world')).toMatchObject({ status: 'join_failed' })
    world.state.available = true
    expect((await host.retryModule(workspace.id, world.registration.moduleId)).modules.find(item => item.moduleId === 'world')?.status).toBe('ready')
    store.close()
  })

  test('aggregates and invokes dynamically discovered capabilities', async () => {
    const { host, store } = createFixture()
    const workspace = await host.create({ name: null })
    const resources = await host.resources(workspace.id)
    expect(resources.resources.map(resource => String(resource.ref.id))).toEqual(['run-01'])
    expect((await host.capabilities(workspace.id)).capabilities.map(item => String(item.id))).toEqual(['world.simulation-run.read'])
    const result = await host.invoke(
      workspace.id,
      capabilityIdSchema.parse('world.simulation-run.read'),
      { resource: resources.resources[0]!.ref, input: { include: 'summary' } },
      accessContextSchema.parse({ workspaceId: workspace.id, requestId: newRequestId(), actor: { kind: 'ai', id: 'agent:test' } }),
    )
    expect(result).toEqual({ resourceId: 'run-01', input: { include: 'summary' } })
    store.close()
  })

  test('applies a Preset as independent Capability calls', async () => {
    const { host, store } = createFixture()
    const workspace = await host.create({ name: null })
    const access = accessContextSchema.parse({ workspaceId: workspace.id, requestId: newRequestId(), actor: { kind: 'human', id: 'operator' } })
    const application = await host.applyPreset(workspace.id, 'halden-process-control-room', access)
    expect(application.status).toBe('applied')
    expect(application.outcomes.map(outcome => String(outcome.capabilityId))).toEqual([
      'world.simulation-run.create',
      'agents.demo.apply',
    ])
    store.close()
  })

  test('keeps a Workspace visible when any Module cleanup fails', async () => {
    const { modules, host, store } = createFixture()
    const workspace = await host.create({ name: null })
    modules[0]!.state.failLeave = true
    await expect(host.delete(workspace.id)).rejects.toMatchObject({ code: 'workspace_delete_incomplete' })
    expect(host.get(workspace.id)).toBeDefined()
    store.close()
  })
})
