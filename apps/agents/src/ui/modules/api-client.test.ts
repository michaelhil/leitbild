import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { apiPath } from './api-client.ts'

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
})
