import { describe, expect, test } from 'bun:test'
import { moduleDiscoverySchema } from '@samsinn-leitbild/platform-contracts'
import { buildManifest, discoveryManifestSchema, type DiscoveryManifest } from '../src/core/api/discovery.ts'
import { handleDiscoveryRoute } from '../src/core/api/server.ts'

describe('Leitbild module discovery', () => {
  test('uses the shared strict contract', () => {
    const manifest = buildManifest('https://leitbild.example')
    expect(discoveryManifestSchema.safeParse(manifest).success).toBe(true)
    expect(moduleDiscoverySchema.safeParse(manifest).success).toBe(true)
    expect(discoveryManifestSchema.safeParse({ ...manifest, identity: {} }).success).toBe(false)
  })

  test('publishes only canonical Workspace-scoped endpoints', () => {
    const manifest = buildManifest('https://leitbild.example/')
    expect(String(manifest.module.id)).toBe('leitbild')
    expect(manifest.workspaceScope).toEqual({
      mode: 'path',
      pathTemplate: 'https://leitbild.example/api/workspaces/{workspaceId}',
    })
    expect(manifest.links.self).toBe('https://leitbild.example/.well-known/leitbild')
    expect(manifest.links.workspaces).toBe('https://leitbild.example/api/workspaces')
    expect(manifest.links.workspaceUi).toBe('https://leitbild.example/workspaces/{workspaceId}')
    expect(manifest.links.simulationRun).toBe('https://leitbild.example/api/workspaces/{workspaceId}/simulation-runs/{simulationRunId}')
    expect(manifest.links.simulationRunEvents).toBe('https://leitbild.example/api/workspaces/{workspaceId}/simulation-runs/{simulationRunId}/events{?afterSeq}')
    expect(manifest.links.realtime).toBe('wss://leitbild.example/api/workspaces/{workspaceId}/ws?simulationRun={simulationRunId}')
    expect(Object.values(manifest.links).some(link => link.includes('/api/simulation-runs'))).toBe(false)
    expect(Object.hasOwn(manifest.links, 'simulationRunEnsure')).toBe(false)
  })

  test('serves discovery with conditional caching', async () => {
    const baseUrl = 'http://leitbild.test'
    const callRoute = async (init?: RequestInit): Promise<Response> => {
      const request = new Request(`${baseUrl}/.well-known/leitbild`, init)
      const response = await handleDiscoveryRoute(request, new URL(request.url))
      if (!response) throw new Error('discovery route did not handle GET /.well-known/leitbild')
      return response
    }

    const response = await callRoute()
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('application/json')
    expect(response.headers.get('cache-control')).toBe('max-age=60, must-revalidate')
    const etag = response.headers.get('etag')
    expect(etag).toMatch(/^W\/"[a-f0-9]{16}"$/)

    const manifest = await response.json() as DiscoveryManifest
    expect(discoveryManifestSchema.safeParse(manifest).success).toBe(true)
    expect(manifest.links.self).toBe(`${baseUrl}/.well-known/leitbild`)

    const notModified = await callRoute({ headers: { 'If-None-Match': etag ?? '' } })
    expect(notModified.status).toBe(304)
    expect(notModified.headers.get('etag')).toBe(etag)
  })

  test('uses forwarded proto and host for reverse-proxied URLs', async () => {
    const request = new Request('http://127.0.0.1:3000/.well-known/leitbild', {
      headers: {
        'X-Forwarded-Proto': 'https',
        'X-Forwarded-Host': 'leitbild.samsinn.app',
      },
    })
    const response = await handleDiscoveryRoute(request, new URL(request.url))
    if (!response) throw new Error('discovery route did not handle GET /.well-known/leitbild')

    const manifest = await response.json() as DiscoveryManifest
    expect(manifest.links.self).toBe('https://leitbild.samsinn.app/.well-known/leitbild')
    expect(manifest.links.realtime).toBe('wss://leitbild.samsinn.app/api/workspaces/{workspaceId}/ws?simulationRun={simulationRunId}')
  })

  test('uses request scheme and host without forwarding headers', async () => {
    const request = new Request('http://localhost:3000/.well-known/leitbild')
    const response = await handleDiscoveryRoute(request, new URL(request.url))
    if (!response) throw new Error('discovery route did not handle GET /.well-known/leitbild')

    const manifest = await response.json() as DiscoveryManifest
    expect(manifest.links.self).toBe('http://localhost:3000/.well-known/leitbild')
    expect(manifest.links.realtime).toBe('ws://localhost:3000/api/workspaces/{workspaceId}/ws?simulationRun={simulationRunId}')
  })
})
