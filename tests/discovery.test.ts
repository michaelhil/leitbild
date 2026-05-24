import { describe, expect, test } from 'bun:test'
import { buildManifest, discoveryManifestSchema, type DiscoveryManifest } from '../src/core/api/discovery.ts'
import { handleDiscoveryRoute } from '../src/core/api/server.ts'

const withEnv = async <T>(
  values: { readonly LEITBILD_OPERATOR?: string; readonly LEITBILD_DEPLOYMENT_ID?: string },
  run: () => Promise<T>,
): Promise<T> => {
  const previousOperator = process.env.LEITBILD_OPERATOR
  const previousDeploymentId = process.env.LEITBILD_DEPLOYMENT_ID
  try {
    if (values.LEITBILD_OPERATOR === undefined) {
      delete process.env.LEITBILD_OPERATOR
    } else {
      process.env.LEITBILD_OPERATOR = values.LEITBILD_OPERATOR
    }
    if (values.LEITBILD_DEPLOYMENT_ID === undefined) {
      delete process.env.LEITBILD_DEPLOYMENT_ID
    } else {
      process.env.LEITBILD_DEPLOYMENT_ID = values.LEITBILD_DEPLOYMENT_ID
    }
    return await run()
  } finally {
    if (previousOperator === undefined) {
      delete process.env.LEITBILD_OPERATOR
    } else {
      process.env.LEITBILD_OPERATOR = previousOperator
    }
    if (previousDeploymentId === undefined) {
      delete process.env.LEITBILD_DEPLOYMENT_ID
    } else {
      process.env.LEITBILD_DEPLOYMENT_ID = previousDeploymentId
    }
  }
}

describe('discovery manifest', () => {
  test('validates the generated shape and rejects malformed input', () => {
    const manifest = buildManifest('https://leitbild.example')
    expect(discoveryManifestSchema.safeParse(manifest).success).toBe(true)

    const malformed = {
      ...manifest,
      manifestSchemaVersion: '2.0.0',
      links: {
        ...manifest.links,
        self: { href: '/relative' },
      },
    }
    expect(discoveryManifestSchema.safeParse(malformed).success).toBe(false)
  })

  test('builds deployment-aware absolute URLs and applies env defaults', async () => {
    await withEnv({}, async () => {
      const manifest = buildManifest('https://leitbild.example/')
      expect(manifest.identity.operator).toBe('unknown')
      expect(manifest.identity.deploymentId).toBe('unknown')
      expect(manifest.links.self.href).toBe('https://leitbild.example/.well-known/leitbild')
      expect(manifest.links.controlInstance.hrefTemplate).toBe('https://leitbild.example/api/control-instances/{id}')
      expect(manifest.links.controlInstanceEvents.hrefTemplate).toBe('https://leitbild.example/api/control-instances/{id}/events{?afterSeq}')
      expect(manifest.links.realtime.href).toBe('wss://leitbild.example/ws')
      expect(manifest.links.realtime.hrefTemplate).toBe('wss://leitbild.example/ws?controlInstance={id}')
      expect(manifest.protocols.http.baseUrl).toBe('https://leitbild.example')
    })

    await withEnv({ LEITBILD_OPERATOR: 'ife', LEITBILD_DEPLOYMENT_ID: 'sandbox-a' }, async () => {
      const manifest = buildManifest('http://localhost:3000')
      expect(manifest.identity.operator).toBe('ife')
      expect(manifest.identity.deploymentId).toBe('sandbox-a')
      expect(manifest.links.realtime.href).toBe('ws://localhost:3000/ws')
    })
  })

  test('serves the well-known endpoint with validation and conditional caching', async () => {
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
    expect(manifest.links.self.href).toBe(`${baseUrl}/.well-known/leitbild`)
    expect(manifest.protocols.http.baseUrl).toBe(baseUrl)

    const notModified = await callRoute({
      headers: { 'If-None-Match': etag ?? '' },
    })
    expect(notModified.status).toBe(304)
    expect(notModified.headers.get('etag')).toBe(etag)

    const changed = await callRoute({
      headers: { 'If-None-Match': 'W/"different"' },
    })
    expect(changed.status).toBe(200)
    expect(discoveryManifestSchema.safeParse(await changed.json()).success).toBe(true)
  })
})
