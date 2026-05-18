import { afterEach, describe, expect, test } from 'bun:test'
import type { ControlInstanceId } from '../src/core/model/index.ts'
import {
  createControlInstance,
  joinControlInstance,
  listControlInstances,
  resetControlInstance,
  sendControlInstanceCommand,
  setControlInstanceClock,
  syncControlInstanceSnapshot,
} from '../src/ui/control-instance-client.ts'

const originalFetch = globalThis.fetch

const installFetch = (
  handler: (input: string | URL | Request, init: RequestInit | undefined) => Response,
): void => {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> =>
    handler(input, init)) as typeof fetch
}

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('control instance client', () => {
  test('uses the Control Instance API paths for list, create, join, and snapshot', async () => {
    const calls: string[] = []
    installFetch((input, init) => {
      const path = String(input)
      calls.push(`${init?.method ?? 'GET'} ${path}`)
      if (path === '/api/control-instances') {
        return new Response(JSON.stringify({ controlInstances: [] }), { status: 200 })
      }
      return new Response(JSON.stringify({ id: 'control-instance:test', snapshot: { objects: [], seq: 0 } }), { status: 200 })
    })

    await listControlInstances()
    await createControlInstance()
    await joinControlInstance('control-instance:test' as ControlInstanceId)
    await syncControlInstanceSnapshot('control-instance:test' as ControlInstanceId)

    expect(calls).toEqual([
      'GET /api/control-instances',
      'POST /api/control-instances',
      'POST /api/control-instances/control-instance%3Atest',
      'GET /api/control-instances/control-instance%3Atest/snapshot',
    ])
  })

  test('sends command payloads through the Control Instance command endpoint', async () => {
    let recordedBody = ''
    installFetch((input, init) => {
      expect(String(input)).toBe('/api/control-instances/control-instance%3Atest/commands')
      expect(init?.method).toBe('POST')
      recordedBody = String(init?.body ?? '')
      return new Response(JSON.stringify({ result: { ok: true } }), { status: 200 })
    })

    const response = await sendControlInstanceCommand('control-instance:test' as ControlInstanceId, {
      kind: 'domain.command',
      targetObjectIds: ['object:1'],
      payload: { value: 1 },
    })

    expect(response.result.ok).toBe(true)
    expect(JSON.parse(recordedBody)).toEqual({
      kind: 'domain.command',
      targetObjectIds: ['object:1'],
      payload: { value: 1 },
    })
  })

  test('sends clock updates through the Control Instance clock endpoint', async () => {
    let recordedBody = ''
    installFetch((input, init) => {
      expect(String(input)).toBe('/api/control-instances/control-instance%3Atest/clock')
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

    const response = await setControlInstanceClock('control-instance:test' as ControlInstanceId, { paused: true })

    expect(response.clock.paused).toBe(true)
    expect(JSON.parse(recordedBody)).toEqual({ paused: true })
  })

  test('passes scenario ids when creating or joining a control instance', async () => {
    const bodies: string[] = []
    installFetch((_input, init) => {
      bodies.push(String(init?.body ?? ''))
      return new Response(JSON.stringify({ id: 'control-instance:test', snapshot: { objects: [], seq: 0 } }), { status: 200 })
    })

    await createControlInstance({ scenarioId: 'oslo-ambulance' })
    await joinControlInstance('control-instance:test' as ControlInstanceId, { scenarioId: 'oslo-ambulance' })
    await resetControlInstance('control-instance:test' as ControlInstanceId, { scenarioId: 'oslo-ambulance' })

    expect(bodies.map(body => JSON.parse(body))).toEqual([
      { scenarioId: 'oslo-ambulance' },
      { scenarioId: 'oslo-ambulance' },
      { scenarioId: 'oslo-ambulance' },
    ])
  })

  test('throws visible errors for failed API responses', async () => {
    installFetch(() => new Response('nope', { status: 503 }))

    await expect(listControlInstances()).rejects.toThrow('control instance list failed: 503')
  })
})
