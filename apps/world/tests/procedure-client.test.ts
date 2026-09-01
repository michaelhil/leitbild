import { afterEach, describe, expect, test } from 'bun:test'
import { workspaceIdSchema } from '@leitbild/contracts'
import type { SimulationRunId } from '../src/core/model/index.ts'
import { validateProcedureTags } from '../src/ui/procedures/procedure-client.ts'
import { configureActiveWorkspace } from '../src/ui/workspace-context.ts'

const originalFetch = globalThis.fetch
const workspaceId = workspaceIdSchema.parse('11111111-1111-4111-8111-111111111111')

configureActiveWorkspace(workspaceId)

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('procedure client', () => {
  test('validates all tags through one tolerant Process Plant query', async () => {
    const requests: unknown[] = []
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      expect(String(input)).toBe(`/api/workspaces/${workspaceId}/world/simulation-runs/run-test/queries`)
      requests.push(JSON.parse(String(init?.body)))
      return new Response(JSON.stringify({
        response: {
          ok: true,
          packId: 'process-plant',
          kind: 'process-plant.procedure-tags.validate',
          result: {
            plantId: 'plant:test',
            tags: [
              { id: 'PT-455', status: 'resolved', signal: { path: 'pressurizer.pressureMPa' }, warnings: [] },
              { id: 'SI-SIG', status: 'missing', warnings: [] },
            ],
          },
          generatedAt: '2026-01-01T00:00:00.000Z',
        },
      }), { status: 200 })
    }) as typeof fetch

    const validation = await validateProcedureTags(
      'run-test' as SimulationRunId,
      'plant:test',
      [
        { id: 'PT-455', units: 'psig' },
        { id: 'SI-SIG', units: 'bool' },
      ],
    )

    expect(requests).toEqual([{
      packId: 'process-plant',
      kind: 'process-plant.procedure-tags.validate',
      payload: {
        plantId: 'plant:test',
        tags: [
          { id: 'PT-455', units: 'psig' },
          { id: 'SI-SIG', units: 'bool' },
        ],
      },
    }])
    expect(validation.get('PT-455')).toMatchObject({ id: 'PT-455', status: 'resolved' })
    expect(validation.get('SI-SIG')).toEqual({ id: 'SI-SIG', status: 'missing', warnings: [] })
  })
})
