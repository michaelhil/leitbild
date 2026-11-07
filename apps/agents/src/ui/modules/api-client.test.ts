import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { apiPath, workspaceRealtimeUrl } from './api-client.ts'

const workspaceId = '11111111-1111-4111-8111-111111111111'

describe('Agents browser API paths', () => {
  let originalLocation: Location | undefined

  beforeEach(() => {
    originalLocation = globalThis.location
    Object.defineProperty(globalThis, 'location', {
      configurable: true,
      value: { pathname: `/workspaces/${workspaceId}/agents` },
      writable: true,
    })
  })

  afterEach(() => {
    if (originalLocation) globalThis.location = originalLocation
    else delete (globalThis as typeof globalThis & { location?: Location }).location
  })

  test('keeps only bootstrap APIs deployment-scoped', () => {
    expect(apiPath('/auth')).toBe('/api/auth')
    expect(apiPath('/system/info')).toBe('/api/system/info')
  })

  test('routes the Pack catalog through the current Workspace', () => {
    expect(apiPath('/packs')).toBe(`/api/workspaces/${workspaceId}/agents/packs`)
    expect(apiPath('/packs/registry')).toBe(`/api/workspaces/${workspaceId}/agents/packs/registry`)
  })
  test('only focused Rooms bind the socket to the exact Room', () => {
    const path = `/workspaces/${workspaceId}/agents`
    const ws = `wss://example.test/api${path}/ws`
    const at = (query: string): void => {
      Object.assign(location, { protocol: 'https:', host: 'example.test', href: `https://example.test${path}?${query}` })
    }

    at('room=ordinary-room')
    expect(workspaceRealtimeUrl('session-id')).toBe(`${ws}?session=session-id`)
    at('view=focused&room=%20run-room%20')
    expect(workspaceRealtimeUrl('session-id')).toBe(`${ws}?session=session-id&room=run-room`)
    at('view=focused&room=%20')
    expect(() => workspaceRealtimeUrl('session-id')).toThrow('Focused Room URL is missing its Room ID')
  })
})
