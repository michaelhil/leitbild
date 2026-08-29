import { afterEach, describe, expect, test } from 'bun:test'
import type { SimulationRunId } from '../src/core/model/index.ts'
import { workspaceIdSchema } from '@samsinn-leitbild/platform-contracts'
import { configureActiveWorkspace } from '../src/ui/workspace-context.ts'
import {
  createSimulationRun,
  deleteSimulationRun,
  joinSimulationRun,
  listSimulationRuns,
  resetSimulationRun,
  sendSimulationRunCommand,
  setSimulationRunClock,
  syncSimulationRunSnapshot,
} from '../src/ui/simulation-run-client.ts'

const originalFetch = globalThis.fetch
const workspaceId = workspaceIdSchema.parse('11111111-1111-4111-8111-111111111111')
const apiPrefix = `/api/workspaces/${workspaceId}`

configureActiveWorkspace(workspaceId)

const installFetch = (
  handler: (input: string | URL | Request, init: RequestInit | undefined) => Response,
): void => {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> =>
    handler(input, init)) as typeof fetch
}

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('simulation run client', () => {
  test('uses the Simulation Run API paths for list, create, join, snapshot, and delete', async () => {
    const calls: string[] = []
    installFetch((input, init) => {
      const path = String(input)
      calls.push(`${init?.method ?? 'GET'} ${path}`)
      if (path === `${apiPrefix}/simulation-runs`) {
        return new Response(JSON.stringify({ simulationRuns: [] }), { status: 200 })
      }
      if (init?.method === 'DELETE') {
        return new Response(JSON.stringify({ id: 'run-test', deleted: true }), { status: 200 })
      }
      return new Response(JSON.stringify({ id: 'run-test', snapshot: { objects: [], seq: 0 } }), { status: 200 })
    })

    await listSimulationRuns()
    await createSimulationRun()
    await joinSimulationRun('run-test' as SimulationRunId)
    await syncSimulationRunSnapshot('run-test' as SimulationRunId)
    await deleteSimulationRun('run-test' as SimulationRunId)

    expect(calls).toEqual([
      `GET ${apiPrefix}/simulation-runs`,
      `POST ${apiPrefix}/simulation-runs`,
      `GET ${apiPrefix}/simulation-runs/run-test`,
      `GET ${apiPrefix}/simulation-runs/run-test/snapshot`,
      `DELETE ${apiPrefix}/simulation-runs/run-test`,
    ])
  })

  test('sends command payloads through the Simulation Run command endpoint', async () => {
    let recordedBody = ''
    installFetch((input, init) => {
      expect(String(input)).toBe(`${apiPrefix}/simulation-runs/run-test/commands`)
      expect(init?.method).toBe('POST')
      recordedBody = String(init?.body ?? '')
      return new Response(JSON.stringify({ result: { ok: true } }), { status: 200 })
    })

    const response = await sendSimulationRunCommand('run-test' as SimulationRunId, {
      kind: 'pack.command',
      targetObjectIds: ['object:1'],
      payload: { value: 1 },
    })

    expect(response.result.ok).toBe(true)
    expect(JSON.parse(recordedBody)).toEqual({
      kind: 'pack.command',
      targetObjectIds: ['object:1'],
      payload: { value: 1 },
    })
  })

  test('sends clock updates through the Simulation Run clock endpoint', async () => {
    let recordedBody = ''
    installFetch((input, init) => {
      expect(String(input)).toBe(`${apiPrefix}/simulation-runs/run-test/clock`)
      expect(init?.method).toBe('POST')
      recordedBody = String(init?.body ?? '')
      return new Response(JSON.stringify({
        clock: {
          currentTime: '2026-01-01T10:00:00.000Z',
          updatedAt: '2026-01-01T10:00:00.000Z',
          paused: true,
          speed: 1,
        },
      }), { status: 200 })
    })

    const response = await setSimulationRunClock('run-test' as SimulationRunId, { paused: true })

    expect(response.clock.paused).toBe(true)
    expect(JSON.parse(recordedBody)).toEqual({ paused: true })
  })

  test('selects a Scenario only at creation and preserves it on join and reset', async () => {
    const calls: Array<{ readonly path: string; readonly method: string; readonly body: string }> = []
    installFetch((input, init) => {
      calls.push({ path: String(input), method: init?.method ?? 'GET', body: String(init?.body ?? '') })
      return new Response(JSON.stringify({ id: 'run-test', snapshot: { objects: [], seq: 0 } }), { status: 200 })
    })

    await createSimulationRun({ scenarioId: 'oslo-ambulance' })
    await joinSimulationRun('run-test' as SimulationRunId)
    await resetSimulationRun('run-test' as SimulationRunId)

    expect(calls).toEqual([
      { path: `${apiPrefix}/simulation-runs`, method: 'POST', body: JSON.stringify({ scenarioId: 'oslo-ambulance' }) },
      { path: `${apiPrefix}/simulation-runs/run-test`, method: 'GET', body: '' },
      { path: `${apiPrefix}/simulation-runs/run-test/reset`, method: 'POST', body: '' },
    ])
  })

  test('throws visible errors for failed API responses', async () => {
    installFetch(() => new Response('nope', { status: 503 }))

    await expect(listSimulationRuns()).rejects.toThrow('simulation run list failed: 503')
  })
})
