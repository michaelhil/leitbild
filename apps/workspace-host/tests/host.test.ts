import { afterEach, describe, expect, test } from 'bun:test'
import {
  accessContextSchema,
  capabilityIdSchema,
  experienceDescriptorSchema,
  moduleIdSchema,
  moduleRegistrationSchema,
  newRequestId,
} from '@samsinn-leitbild/platform-contracts'
import { createWorkspaceHost } from '../src/host.ts'
import { createModuleGateway } from '../src/module-gateway.ts'
import { createWorkspaceHostServer } from '../src/server.ts'
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
    async fetch(request) {
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
          ui: { workspace: '/workspaces/{workspaceId}' },
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
      const resourcesMatch = url.pathname.match(/^\/internal\/workspaces\/([^/]+)\/resources$/)
      if (resourcesMatch && request.method === 'GET') {
        const workspaceId = decodeURIComponent(resourcesMatch[1] ?? '')
        if (!state.workspaces.has(workspaceId)) return new Response('not found', { status: 404 })
        return Response.json({
          resources: [{
            ref: { workspaceId, moduleId: 'microworld', type: 'microworld.simulation-run', id: 'run-01' },
            title: 'Run 01',
            capabilityIds: ['microworld.simulation-run.read'],
            observedAt: new Date().toISOString(),
          }],
        })
      }
      const capabilitiesMatch = url.pathname.match(/^\/internal\/workspaces\/([^/]+)\/capabilities$/)
      if (capabilitiesMatch && request.method === 'GET') {
        return Response.json({
          capabilities: [{
            id: 'microworld.simulation-run.read',
            moduleId: 'microworld',
            kind: 'query',
            scope: { kind: 'resource', resourceType: 'microworld.simulation-run' },
            title: 'Read Simulation Run',
            description: 'Reads the selected Simulation Run.',
            risk: 'read',
            idempotent: true,
            inputSchema: { type: 'object' },
            outputSchema: { type: 'object' },
          }],
        })
      }
      const invocationMatch = url.pathname.match(/^\/internal\/workspaces\/([^/]+)\/capabilities\/([^/]+)\/invoke$/)
      if (invocationMatch && request.method === 'POST') {
        const invocation = await request.json() as { resource?: { id: string }; input: unknown }
        return Response.json({ result: { resourceId: invocation.resource?.id, input: invocation.input } })
      }
      if (/^\/workspaces\/[^/]+$/.test(url.pathname) && request.method === 'GET') {
        return new Response('Microworld')
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

const createHost = (
  registrations: Parameters<typeof createModuleGateway>[0]['registrations'],
  experiences: Parameters<typeof createWorkspaceHost>[0]['experiences'] = [],
) => {
  const store = createWorkspaceStore(':memory:')
  return {
    store,
    host: createWorkspaceHost({ store, modules: createModuleGateway({ registrations }), experiences }),
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
    const workspace = await host.create({ name: null })
    const failed = await host.addModule(workspace.id, moduleId)
    expect(failed.modules[0]).toMatchObject({
      moduleId,
      status: 'join_failed',
      failure: { code: 'module_discovery_failed', retryable: true },
    })

    module.state.available = true
    const recovered = await host.retryModule(workspace.id, moduleId)
    expect(recovered.modules[0]?.status).toBe('ready')
    store.close()
  })

  test('aggregates typed discovery and invokes a Capability without a Module-specific URL', async () => {
    const module = createMicroworldModule()
    const { host, store } = createHost([module.registration])
    const workspace = await host.create({ name: null })
    await host.addModule(workspace.id, moduleIdSchema.parse('microworld'))

    const resources = await host.resources(workspace.id)
    expect(resources.modules).toEqual([{ moduleId: moduleIdSchema.parse('microworld'), status: 'ready' }])
    expect(resources.resources.map(resource => String(resource.ref.id))).toEqual(['run-01'])
    const capabilities = await host.capabilities(workspace.id)
    expect(capabilities.capabilities.map(capability => String(capability.id))).toEqual(['microworld.simulation-run.read'])

    const result = await host.invoke(
      workspace.id,
      capabilityIdSchema.parse('microworld.simulation-run.read'),
      { resource: resources.resources[0]!.ref, input: { include: 'summary' } },
      accessContextSchema.parse({
        workspaceId: workspace.id,
        requestId: newRequestId(),
        actor: { kind: 'ai', id: 'agent:test' },
      }),
    )
    expect(result).toEqual({ resourceId: 'run-01', input: { include: 'summary' } })
    store.close()
  })

  test('does not hide failed cleanup by deleting the Workspace', async () => {
    const module = createMicroworldModule()
    const { host, store } = createHost([module.registration])
    const workspace = await host.create({ name: null })
    await host.addModule(workspace.id, moduleIdSchema.parse('microworld'))
    module.state.failLeave = true

    await expect(host.delete(workspace.id)).rejects.toMatchObject({ code: 'workspace_delete_incomplete' })
    expect(host.get(workspace.id)?.modules[0]?.status).toBe('leave_failed')
    store.close()
  })

  test('composes user-facing Experiences while retaining technical Module status', async () => {
    const module = createMicroworldModule()
    const leitbild = experienceDescriptorSchema.parse({
      id: 'leitbild',
      title: 'Leitbild',
      requiredModules: ['microworld'],
      entryModuleId: 'microworld',
    })
    const { host, store } = createHost([module.registration], [leitbild])
    const workspace = await host.create({ name: null, experienceIds: [leitbild.id] })
    expect(workspace.modules[0]?.status).toBe('ready')
    expect(host.experiences(workspace.id)).toEqual([expect.objectContaining({ id: 'leitbild', status: 'ready' })])

    expect(await host.removeExperience(workspace.id, leitbild.id)).toEqual([
      expect.objectContaining({ id: 'leitbild', status: 'absent' }),
    ])
    expect(host.get(workspace.id)?.modules).toEqual([])
    store.close()
  })

  test('creates the first Workspace and routes directly into its sole initial Experience', async () => {
    const module = createMicroworldModule()
    const leitbild = experienceDescriptorSchema.parse({
      id: 'leitbild',
      title: 'Leitbild',
      requiredModules: ['microworld'],
      entryModuleId: 'microworld',
    })
    const { host, store } = createHost([module.registration], [leitbild])
    const server = createWorkspaceHostServer({
      host,
      bindHost: '127.0.0.1',
      port: 0,
      initialExperienceIds: [leitbild.id],
    })
    servers.push(server)
    const origin = `http://127.0.0.1:${server.port}`

    const first = await fetch(origin, { redirect: 'manual' })
    expect(first.status).toBe(303)
    const workspace = host.list()[0]!
    expect(workspace.name).toBeNull()
    expect(first.headers.get('location')).toBe(
      `${origin}/workspaces/${workspace.id}/experiences/leitbild`,
    )

    const entry = await fetch(first.headers.get('location')!, { redirect: 'manual' })
    expect(entry.status).toBe(303)
    expect(entry.headers.get('location')).toBe(
      `${module.registration.baseUrl}/workspaces/${workspace.id}`,
    )
    store.close()
  })
})
