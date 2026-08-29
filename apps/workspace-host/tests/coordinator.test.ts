import { describe, expect, test } from 'bun:test'
import {
  moduleIdSchema,
  type WorkspaceId,
} from '@samsinn-leitbild/platform-contracts'
import { createSuiteCoordinator } from '../src/coordinator.ts'
import type { SuiteWorkspaceDirectory } from '../src/directory.ts'
import type { SuiteWorkspace } from '../src/model.ts'

const SAMSINN = moduleIdSchema.parse('samsinn')
const LEITBILD = moduleIdSchema.parse('leitbild')

const createMemoryDirectory = (): SuiteWorkspaceDirectory => {
  const workspaces = new Map<WorkspaceId, SuiteWorkspace>()
  return {
    list: async () => [...workspaces.values()],
    get: async id => workspaces.get(id),
    save: async workspace => {
      workspaces.set(workspace.id, workspace)
      return workspace
    },
  }
}

const discovery = (moduleId: 'samsinn' | 'leitbild', baseUrl: string): object => ({
  generatedAt: '2026-08-29T12:00:00.000Z',
  module: { id: moduleId, title: moduleId === 'samsinn' ? 'Samsinn' : 'Leitbild', implementationVersion: '0.1.0' },
  workspaceScope: { mode: 'path', pathTemplate: `${baseUrl}/api/workspaces/{workspaceId}` },
  access: { posture: 'open', modes: ['open'] },
  links: {
    self: `${baseUrl}/.well-known/${moduleId}`,
    workspace: `${baseUrl}/api/workspaces/{workspaceId}`,
    workspaceUi: `${baseUrl}/workspaces/{workspaceId}`,
  },
})

describe('suite coordinator', () => {
  test('provisions one opaque Workspace id and the same Module Bindings in every application', async () => {
    const provisioned = new Map<string, unknown>()
    const fetchMock = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = String(input)
      if (url === 'https://samsinn.test/.well-known/samsinn') return Response.json(discovery('samsinn', 'https://samsinn.test'))
      if (url === 'https://leitbild.test/.well-known/leitbild') return Response.json(discovery('leitbild', 'https://leitbild.test'))
      if (init?.method === 'PUT') {
        provisioned.set(url, JSON.parse(String(init.body)) as unknown)
        return Response.json({ workspace: { id: url.split('/').at(-1) } }, { status: 201 })
      }
      return new Response('not found', { status: 404 })
    }
    const coordinator = createSuiteCoordinator({
      directory: createMemoryDirectory(),
      modules: [
        { moduleId: SAMSINN, baseUrl: 'https://samsinn.test' },
        { moduleId: LEITBILD, baseUrl: 'https://leitbild.test' },
      ],
      fetch: fetchMock as typeof fetch,
    })

    const workspace = await coordinator.create({ displayName: 'Exercise Alpha' })
    expect(workspace.modules.map(module => module.status)).toEqual(['ready', 'ready'])
    const samsinnUrl = `https://samsinn.test/api/workspaces/${workspace.id}`
    const leitbildUrl = `https://leitbild.test/api/workspaces/${workspace.id}`
    expect([...provisioned.keys()].sort()).toEqual([leitbildUrl, samsinnUrl].sort())
    expect(provisioned.get(samsinnUrl)).toEqual(provisioned.get(leitbildUrl))
    expect(provisioned.get(samsinnUrl)).toEqual({
      displayName: 'Exercise Alpha',
      modules: [
        expect.objectContaining({ moduleId: 'samsinn', baseUrl: 'https://samsinn.test' }),
        expect.objectContaining({ moduleId: 'leitbild', baseUrl: 'https://leitbild.test' }),
      ],
    })
    expect(workspace.modules.map(module => module.workspaceUrl)).toEqual([
      `https://samsinn.test/workspaces/${workspace.id}`,
      `https://leitbild.test/workspaces/${workspace.id}`,
    ])
  })

  test('records a Module outage and converges on explicit retry', async () => {
    let leitbildAvailable = false
    const fetchMock = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = String(input)
      if (url.endsWith('/.well-known/samsinn')) return Response.json(discovery('samsinn', 'https://samsinn.test'))
      if (url.endsWith('/.well-known/leitbild')) {
        return leitbildAvailable
          ? Response.json(discovery('leitbild', 'https://leitbild.test'))
          : new Response('offline', { status: 503 })
      }
      if (init?.method === 'PUT') return Response.json({ ok: true }, { status: 201 })
      return new Response('not found', { status: 404 })
    }
    const coordinator = createSuiteCoordinator({
      directory: createMemoryDirectory(),
      modules: [
        { moduleId: SAMSINN, baseUrl: 'https://samsinn.test' },
        { moduleId: LEITBILD, baseUrl: 'https://leitbild.test' },
      ],
      fetch: fetchMock as typeof fetch,
    })

    const partial = await coordinator.create({ displayName: 'Resilient Workspace' })
    expect(partial.modules.map(module => [module.moduleId, module.status])).toEqual([
      [SAMSINN, 'ready'],
      [LEITBILD, 'failed'],
    ])
    expect(partial.modules[1]?.error).toContain('HTTP 503')

    leitbildAvailable = true
    const recovered = await coordinator.provision(partial.id)
    expect(recovered.id).toBe(partial.id)
    expect(recovered.modules.every(module => module.status === 'ready')).toBe(true)
  })

  test('can create a standalone single-Module Workspace', async () => {
    const fetchMock = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = String(input)
      if (url.endsWith('/.well-known/samsinn')) return Response.json(discovery('samsinn', 'https://samsinn.test'))
      if (init?.method === 'PUT') return Response.json({ ok: true }, { status: 201 })
      return new Response('not found', { status: 404 })
    }
    const coordinator = createSuiteCoordinator({
      directory: createMemoryDirectory(),
      modules: [
        { moduleId: SAMSINN, baseUrl: 'https://samsinn.test' },
        { moduleId: LEITBILD, baseUrl: 'https://leitbild.test' },
      ],
      fetch: fetchMock as typeof fetch,
    })
    const workspace = await coordinator.create({ displayName: 'Samsinn Only', moduleIds: [SAMSINN] })
    expect(workspace.modules.map(module => module.moduleId)).toEqual([SAMSINN])
  })
})
