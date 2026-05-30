import { resolve, normalize } from 'node:path'
import type { ServerWebSocket } from 'bun'
import { controlInstanceIdSchema, type ControlInstanceId } from '../model/index.ts'
import type { ControlInstanceRegistry } from '../control-instances/registry.ts'
import {
  createMapArtifactConfigFromEnv,
  createMapArtifactStatus,
  currentPmtilesResponse,
  currentVectorTileResponse,
  mapGlyphResponse,
  mapCapabilitiesResponse,
  mapStyleResponse,
  referenceDatasetPmtilesResponse,
  referenceDatasetVectorTileResponse,
  type MapArtifactConfig,
} from '../../map/artifacts.ts'
import { handleControlInstanceApi } from './control-instance-routes.ts'
import { createControlInstanceRealtimeManager, emptyRealtimeStatus, type RealtimeStatus } from './realtime.ts'
import { json } from './responses.ts'
import { buildManifest } from './discovery.ts'
import { createSamsinnScreenshotConfigFromEnv } from './client-config.ts'

const frameAncestorsHeader = "frame-ancestors 'self' https://samsinn.app https://*.samsinn.app"

interface ServerConfig {
  readonly registry: ControlInstanceRegistry
  readonly port?: number
  readonly uiDistPath?: string
  readonly mapArtifacts?: MapArtifactConfig
}

interface WSData {
  readonly controlInstanceId: ControlInstanceId
}

const memoryStatus = (): {
  readonly rssBytes: number
  readonly heapTotalBytes: number
  readonly heapUsedBytes: number
  readonly externalBytes: number
  readonly arrayBuffersBytes: number
} => {
  const memory = process.memoryUsage()
  return {
    rssBytes: memory.rss,
    heapTotalBytes: memory.heapTotal,
    heapUsedBytes: memory.heapUsed,
    externalBytes: memory.external,
    arrayBuffersBytes: memory.arrayBuffers,
  }
}

export const createHealthDetails = async (config: {
  readonly registry: ControlInstanceRegistry
  readonly realtime?: RealtimeStatus
  readonly mapArtifacts: MapArtifactConfig
}): Promise<{
  readonly ok: true
  readonly generatedAt: string
  readonly process: {
    readonly pid: number
    readonly uptimeSeconds: number
    readonly memory: ReturnType<typeof memoryStatus>
  }
  readonly registry: Awaited<ReturnType<ControlInstanceRegistry['status']>>
  readonly realtime: RealtimeStatus
  readonly mapArtifacts: Awaited<ReturnType<typeof createMapArtifactStatus>>
}> => ({
  ok: true,
  generatedAt: new Date().toISOString(),
  process: {
    pid: process.pid,
    uptimeSeconds: process.uptime(),
    memory: memoryStatus(),
  },
  registry: await config.registry.status(),
  realtime: config.realtime ?? emptyRealtimeStatus(),
  mapArtifacts: await createMapArtifactStatus(config.mapArtifacts),
})

export const staticContentTypeForPath = (filePath: string): string =>
  filePath.endsWith('.html')
    ? 'text/html'
    : filePath.endsWith('.css')
      ? 'text/css'
      : filePath.endsWith('.js') || filePath.endsWith('.mjs')
        ? 'application/javascript'
        : 'application/octet-stream'

const serveStatic = async (pathname: string, uiDistPath: string): Promise<Response | null> => {
  const normalizedPath = pathname === '/' || pathname === '/i' || pathname.startsWith('/i/') ? '/index.html' : pathname
  const filePath = normalize(`${uiDistPath}${normalizedPath}`)
  if (!filePath.startsWith(uiDistPath)) return new Response('Forbidden', { status: 403 })
  const file = Bun.file(filePath)
  if (!await file.exists()) return null
  return new Response(file, { headers: { 'Content-Type': staticContentTypeForPath(filePath) } })
}

const discoveryEtag = async (manifest: ReturnType<typeof buildManifest>): Promise<string> => {
  const stableBody = JSON.stringify({
    ...manifest,
    generatedAt: undefined,
  })
  const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(stableBody))
  const hash = [...new Uint8Array(digest)]
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 16)
  return `W/"${hash}"`
}

const requestBaseUrl = (req: Request): string => {
  const url = new URL(req.url)
  const forwardedProto = req.headers.get('x-forwarded-proto')?.split(',')[0]?.trim()
  const forwardedHost = req.headers.get('x-forwarded-host')?.split(',')[0]?.trim()
  const protocol = forwardedProto ? `${forwardedProto}:` : url.protocol
  const host = forwardedHost ?? url.host
  return `${protocol}//${host}`
}

const acceptsEtag = (ifNoneMatch: string | null, etag: string): boolean =>
  ifNoneMatch?.split(',').map(candidate => candidate.trim()).includes(etag) ?? false

const withSecurityHeaders = (response: Response): Response => {
  const headers = new Headers(response.headers)
  headers.set('Content-Security-Policy', frameAncestorsHeader)
  headers.delete('X-Frame-Options')
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

const discoveryResponse = async (req: Request): Promise<Response> => {
  const manifest = buildManifest(requestBaseUrl(req))
  const etag = await discoveryEtag(manifest)
  const headers = {
    'Content-Type': 'application/json',
    'Cache-Control': 'max-age=60, must-revalidate',
    ETag: etag,
  }
  if (acceptsEtag(req.headers.get('if-none-match'), etag)) {
    return new Response(null, { status: 304, headers })
  }
  return json(manifest, { headers })
}

export const handleDiscoveryRoute = async (req: Request, url: URL): Promise<Response | null> => {
  if (url.pathname === '/.well-known/leitbild' && req.method === 'GET') return discoveryResponse(req)
  return null
}

export const createServer = (config: ServerConfig): { readonly stop: () => void; readonly port: number } => {
  const port = config.port ?? Number(process.env.PORT ?? 3000)
  const uiDistPath = resolve(config.uiDistPath ?? `${import.meta.dir}/../../ui/dist`)
  const mapArtifacts = config.mapArtifacts ?? createMapArtifactConfigFromEnv()
  const realtime = createControlInstanceRealtimeManager<ServerWebSocket<WSData>>({
    registry: config.registry,
    send: (socket, message) => {
      socket.send(JSON.stringify(message))
    },
    sendReady: (socket, message) => {
      socket.send(JSON.stringify(message))
    },
  })

  const server = Bun.serve<WSData>({
    port,
    async fetch(req, serverApi) {
      const secure = (response: Response): Response => withSecurityHeaders(response)
      const url = new URL(req.url)
      if (url.pathname === '/health') {
        return secure(json({
          ok: true,
          mapArtifacts: await createMapArtifactStatus(mapArtifacts),
        }))
      }
      if (url.pathname === '/health/details') {
        return secure(json(await createHealthDetails({ registry: config.registry, realtime: realtime.status(), mapArtifacts })))
      }
      if (url.pathname === '/api/client-config' && req.method === 'GET') {
        return secure(json({ samsinnScreenshot: createSamsinnScreenshotConfigFromEnv() }))
      }
      const discoveryRouteResponse = await handleDiscoveryRoute(req, url)
      if (discoveryRouteResponse) return secure(discoveryRouteResponse)
      if (url.pathname === '/map/capabilities.json') return secure(await mapCapabilitiesResponse())
      if (url.pathname === '/map/style.json') return secure(mapStyleResponse(url.searchParams.get('theme')))
      if (url.pathname.startsWith('/map/tiles/current/')) {
        const tileResponse = await currentVectorTileResponse(url, mapArtifacts)
        if (tileResponse) return secure(tileResponse)
      }
      if (url.pathname === '/map/tiles/current.pmtiles') return secure(await currentPmtilesResponse(req, mapArtifacts))
      if (url.pathname.startsWith('/map/datasets/')) {
        const referenceVectorTileResponse = await referenceDatasetVectorTileResponse(url)
        if (referenceVectorTileResponse) return secure(referenceVectorTileResponse)
        const referenceTilesResponse = await referenceDatasetPmtilesResponse(req, url)
        if (referenceTilesResponse) return secure(referenceTilesResponse)
      }
      if (url.pathname.startsWith('/map/fonts/')) {
        const glyphResponse = await mapGlyphResponse(url, mapArtifacts)
        if (glyphResponse) return secure(glyphResponse)
      }

      const controlInstanceApiResponse = await handleControlInstanceApi(req, url, {
        registry: config.registry,
        websocketClients: realtime.status().controlInstances,
      })
      if (controlInstanceApiResponse) {
        realtime.reconcile()
        return secure(controlInstanceApiResponse)
      }

      if (url.pathname === '/ws') {
        const rawControlInstanceId = url.searchParams.get('controlInstance')
        if (!rawControlInstanceId) return secure(new Response('Missing controlInstance', { status: 400 }))
        const controlInstanceId = controlInstanceIdSchema.parse(rawControlInstanceId)
        if (!config.registry.get(controlInstanceId)) return secure(new Response('Control instance not found', { status: 404 }))
        const upgraded = serverApi.upgrade(req, { data: { controlInstanceId } })
        return upgraded ? undefined : secure(new Response('WebSocket upgrade failed', { status: 400 }))
      }

      const staticResponse = await serveStatic(url.pathname, uiDistPath)
      if (staticResponse) return secure(staticResponse)
      return secure(new Response('Not found', { status: 404 }))
    },
    websocket: {
      open(socket) {
        realtime.addClient(socket.data.controlInstanceId, socket)
      },
      close(socket) {
        realtime.removeClient(socket.data.controlInstanceId, socket)
      },
      message() {
        // Browser-to-server commands use REST for validation, status codes, and auditability.
      },
    },
  })

  return {
    port,
    stop: () => {
      realtime.stop()
      server.stop()
    },
  }
}
