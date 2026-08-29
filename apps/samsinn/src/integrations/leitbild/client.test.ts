import { afterEach, describe, expect, test } from 'bun:test'
import { workspaceIdSchema } from '@samsinn-leitbild/platform-contracts'
import {
  __resetClientPool,
  createLeitbildClient,
  createLeitbildModuleBinding,
} from './client.ts'

const BASE_URL = 'https://leitbild.example'
const WORKSPACE_ID = workspaceIdSchema.parse('55555555-5555-4555-8555-555555555555')
const connection = {
  moduleBinding: createLeitbildModuleBinding(BASE_URL),
  workspaceId: WORKSPACE_ID,
}

const manifest = () => ({
  generatedAt: '2026-08-29T00:00:00.000Z',
  module: { id: 'leitbild', title: 'Leitbild', implementationVersion: '1.0.0' },
  workspaceScope: {
    mode: 'path',
    pathTemplate: `${BASE_URL}/api/workspaces/{workspaceId}`,
  },
  access: { posture: 'open', modes: ['open'] },
  links: {
    self: `${BASE_URL}/.well-known/leitbild`,
    workspaces: `${BASE_URL}/api/workspaces`,
    workspace: `${BASE_URL}/api/workspaces/{workspaceId}`,
    scenarios: `${BASE_URL}/api/workspaces/{workspaceId}/scenarios`,
    scenario: `${BASE_URL}/api/workspaces/{workspaceId}/scenarios/{scenarioId}`,
    simulationRuns: `${BASE_URL}/api/workspaces/{workspaceId}/simulation-runs`,
    simulationRun: `${BASE_URL}/api/workspaces/{workspaceId}/simulation-runs/{simulationRunId}`,
    simulationRunSnapshot: `${BASE_URL}/api/workspaces/{workspaceId}/simulation-runs/{simulationRunId}/snapshot`,
    simulationRunEvents: `${BASE_URL}/api/workspaces/{workspaceId}/simulation-runs/{simulationRunId}/events{?afterSeq}`,
    simulationRunPackQueries: `${BASE_URL}/api/workspaces/{workspaceId}/simulation-runs/{simulationRunId}/queries`,
    simulationRunCapabilities: `${BASE_URL}/api/workspaces/{workspaceId}/simulation-runs/{simulationRunId}/capabilities`,
    simulationRunCommands: `${BASE_URL}/api/workspaces/{workspaceId}/simulation-runs/{simulationRunId}/commands`,
    realtime: `wss://leitbild.example/api/workspaces/{workspaceId}/ws?simulationRun={simulationRunId}`,
  },
})

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
  __resetClientPool()
})

describe('Leitbild client contract', () => {
  test('expands canonical Workspace and Simulation Run scopes', async () => {
    const requested: string[] = []
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input)
      requested.push(url)
      if (url.endsWith('/.well-known/leitbild')) return Response.json(manifest())
      if (url.endsWith(`/api/workspaces/${WORKSPACE_ID}/simulation-runs`)) {
        return Response.json({
          simulationRuns: [{
            id: 'run-55555555-5555-4555-8555-555555555555',
            scenarioId: 'scenario-a',
            scenarioRevisionId: 'revision-a',
            createdAt: '2026-08-29T00:00:00.000Z',
            loaded: true,
            snapshotSeq: 4,
            objectCount: 2,
            websocketClientCount: 0,
          }],
        })
      }
      return new Response(null, { status: 404 })
    }) as unknown as typeof fetch

    const runs = await createLeitbildClient(connection).listSimulationRuns()
    expect(runs).toHaveLength(1)
    expect(runs[0]?.id).toBe('run-55555555-5555-4555-8555-555555555555')
    expect(requested).toContain(`${BASE_URL}/api/workspaces/${WORKSPACE_ID}/simulation-runs`)
  })

  test('rejects the removed bespoke discovery manifest', async () => {
    globalThis.fetch = (async () => Response.json({
      manifestSchemaVersion: '1.0.0',
      identity: { implementation: 'leitbild' },
      links: {},
    })) as unknown as typeof fetch

    await expect(createLeitbildClient(connection).getManifest()).rejects.toThrow()
  })

  test('rejects legacy list, create, and snapshot response shapes', async () => {
    const runId = 'run-55555555-5555-4555-8555-555555555555'
    let responseShape: unknown = { instances: [] }
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith('/.well-known/leitbild')) return Response.json(manifest())
      return Response.json(responseShape)
    }) as unknown as typeof fetch

    const client = createLeitbildClient(connection)
    await expect(client.listSimulationRuns()).rejects.toThrow('simulationRuns[]')

    responseShape = { instance: { id: runId } }
    await expect(client.createSimulationRun('scenario-a')).rejects.toThrow('response.id')

    responseShape = { seq: 1, objects: [] }
    await expect(client.getSnapshot(runId)).rejects.toThrow('wrong Simulation Run id')
  })
})
