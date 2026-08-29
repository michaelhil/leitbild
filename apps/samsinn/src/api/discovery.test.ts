import { describe, expect, test } from 'bun:test'
import { moduleDiscoverySchema } from '@samsinn-leitbild/platform-contracts'
import { buildSamsinnDiscovery } from './discovery.ts'

describe('Samsinn discovery', () => {
  test('advertises the canonical Workspace-scoped API without URL versions', () => {
    const discovery = buildSamsinnDiscovery('https://samsinn.test/')
    expect(moduleDiscoverySchema.safeParse(discovery).success).toBe(true)
    expect(discovery.workspaceScope.pathTemplate).toBe('https://samsinn.test/api/workspaces/{workspaceId}')
    expect(discovery.links.workspaceUi).toBe('https://samsinn.test/workspaces/{workspaceId}')
    expect(discovery.links.rooms).toBe('https://samsinn.test/api/workspaces/{workspaceId}/rooms')
    expect(discovery.links.realtime).toBe('wss://samsinn.test/api/workspaces/{workspaceId}/ws')
    expect(JSON.stringify(discovery)).not.toContain('/api/v')
  })
})
