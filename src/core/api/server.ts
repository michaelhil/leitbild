import { resolve, normalize } from 'node:path'
import type { ServerWebSocket } from 'bun'
import { z } from 'zod'
import { actorIdSchema, clientIdSchema, controlInstanceIdSchema, nowIso, type CommandResult, type ControlInstanceId } from '../model/index.ts'
import type { ControlInstanceRegistry } from '../control-instances/registry.ts'
import {
  createMapArtifactConfigFromEnv,
  createMapArtifactStatus,
  currentPmtilesResponse,
  currentTerrainPmtilesResponse,
  currentTerrainRasterTileResponse,
  currentTerrainTileJsonResponse,
  currentVectorTileResponse,
  currentSceneryTilesetResponse,
  currentSceneryTileResponse,
  mapGlyphResponse,
  mapCapabilitiesResponse,
  mapStyleResponse,
  referenceDatasetPmtilesResponse,
  referenceDatasetVectorTileResponse,
  type MapArtifactConfig,
} from '../../map/artifacts.ts'
import {
  buildControlInstanceActor,
  buildControlInstanceCommand,
  handleControlInstanceApi,
} from './control-instance-routes.ts'
import {
  commandIdempotencyConfigFromEnv,
  commandIdempotencyStoreForRuntime,
  issueCommandWithIdempotency,
} from './command-idempotency.ts'
import { createControlInstanceRealtimeManager, emptyRealtimeStatus, type RealtimeStatus } from './realtime.ts'
import { json } from './responses.ts'
import { buildManifest } from './discovery.ts'
import { createSamsinnScreenshotConfigFromEnv } from './client-config.ts'

const frameAncestorsHeader = "frame-ancestors 'self' https://samsinn.app https://*.samsinn.app"
const defaultRealtimeInputActorId = actorIdSchema.parse('actor:operator')

interface ServerConfig {
  readonly registry: ControlInstanceRegistry
  readonly port?: number
  readonly bindHost?: string
  readonly uiDistPath?: string
  readonly mapArtifacts?: MapArtifactConfig
}

interface WSData {
  readonly controlInstanceId: ControlInstanceId
}

const realtimeClientCommandMessageSchema = z.object({
  type: z.literal('command'),
  requestId: z.string().min(1).max(128),
  command: z.unknown(),
}).strict()

const realtimeClientRuntimeInputMessageSchema = z.object({
  type: z.literal('runtime.input'),
  input: z.object({
    type: z.string().min(1).max(128),
    actorId: actorIdSchema.default(defaultRealtimeInputActorId),
    clientId: clientIdSchema.optional(),
    payload: z.unknown(),
  }).strict(),
}).strict()

const realtimeClientMessageSchema = z.union([
  realtimeClientCommandMessageSchema,
  realtimeClientRuntimeInputMessageSchema,
])

const websocketText = (message: string | Buffer): string =>
  typeof message === 'string' ? message : message.toString('utf8')

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

const staticContentTypes: Readonly<Record<string, string>> = {
  '.avif': 'image/avif',
  '.css': 'text/css',
  '.html': 'text/html',
  '.ico': 'image/x-icon',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.map': 'application/json',
  '.mjs': 'application/javascript',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
}

export const staticContentTypeForPath = (filePath: string): string => {
  const lowerPath = filePath.toLowerCase()
  const extension = Object.keys(staticContentTypes)
    .find(candidate => lowerPath.endsWith(candidate))
  return extension ? staticContentTypes[extension]! : 'application/octet-stream'
}

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
  const bindHost = config.bindHost ?? process.env.LEITBILD_BIND_HOST ?? '0.0.0.0'
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

  const sendRealtimeCommandError = (
    socket: ServerWebSocket<WSData>,
    requestId: string | undefined,
    message: string,
  ): void => {
    socket.send(JSON.stringify({
      type: 'command.error',
      controlInstanceId: socket.data.controlInstanceId,
      ...(requestId === undefined ? {} : { requestId }),
      message,
    }))
  }

  const sendRealtimeInputError = (
    socket: ServerWebSocket<WSData>,
    inputType: string | undefined,
    message: string,
  ): void => {
    socket.send(JSON.stringify({
      type: 'runtime.input.error',
      controlInstanceId: socket.data.controlInstanceId,
      ...(inputType === undefined ? {} : { inputType }),
      message,
    }))
  }

  const issueRealtimeCommand = async (
    controlInstanceId: ControlInstanceId,
    rawCommand: unknown,
  ): Promise<CommandResult> => {
    const runtime = config.registry.get(controlInstanceId)
    if (!runtime) {
      return {
        ok: false,
        commandId: `command:${crypto.randomUUID()}` as CommandResult['commandId'],
        rejectedAt: nowIso(),
        reason: 'control instance not found',
      }
    }
    const command = buildControlInstanceCommand(controlInstanceId, rawCommand)
    const actor = buildControlInstanceActor(command.actorId)
    const issued = await issueCommandWithIdempotency({
      store: commandIdempotencyStoreForRuntime(controlInstanceId),
      idempotency: commandIdempotencyConfigFromEnv(),
      actor,
      command,
      issue: runtime.issueCommand,
    })
    if (!issued.ok) {
      return {
        ok: false,
        commandId: command.id,
        rejectedAt: nowIso(),
        reason: issued.message,
      }
    }
    return issued.result
  }

  const handleRealtimeClientMessage = async (
    socket: ServerWebSocket<WSData>,
    message: string | Buffer,
  ): Promise<void> => {
    let parsed
    try {
      parsed = realtimeClientMessageSchema.parse(JSON.parse(websocketText(message)) as unknown)
    } catch (err) {
      sendRealtimeCommandError(socket, undefined, err instanceof Error ? err.message : String(err))
      return
    }
    if (parsed.type === 'runtime.input') {
      try {
        const runtime = config.registry.get(socket.data.controlInstanceId)
        if (!runtime) {
          sendRealtimeInputError(socket, parsed.input.type, 'control instance not found')
          return
        }
        await runtime.receiveRealtimeInput({
          type: parsed.input.type,
          at: nowIso(),
          ...(parsed.input.actorId === undefined ? {} : { actorId: parsed.input.actorId }),
          ...(parsed.input.clientId === undefined ? {} : { clientId: parsed.input.clientId }),
          payload: parsed.input.payload,
        })
      } catch (err) {
        sendRealtimeInputError(socket, parsed.input.type, err instanceof Error ? err.message : String(err))
      }
      return
    }
    try {
      const result = await issueRealtimeCommand(socket.data.controlInstanceId, parsed.command)
      socket.send(JSON.stringify({
        type: 'command.result',
        controlInstanceId: socket.data.controlInstanceId,
        requestId: parsed.requestId,
        result,
      }))
    } catch (err) {
      sendRealtimeCommandError(socket, parsed.requestId, err instanceof Error ? err.message : String(err))
    }
  }

  const server = Bun.serve<WSData>({
    port,
    hostname: bindHost,
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
      if (url.pathname === '/map/capabilities.json') return secure(await mapCapabilitiesResponse(mapArtifacts))
      if (url.pathname === '/map/style.json') return secure(mapStyleResponse(url.searchParams.get('theme')))
      if (url.pathname.startsWith('/map/tiles/current/')) {
        const tileResponse = await currentVectorTileResponse(url, mapArtifacts)
        if (tileResponse) return secure(tileResponse)
      }
      if (url.pathname === '/map/tiles/current.pmtiles') return secure(await currentPmtilesResponse(req, mapArtifacts))
      if (url.pathname === '/map/terrain/current.pmtiles') return secure(await currentTerrainPmtilesResponse(req, mapArtifacts))
      if (url.pathname === '/map/terrain/current/tiles.json') return secure(await currentTerrainTileJsonResponse(mapArtifacts))
      if (url.pathname.startsWith('/map/terrain/current/')) {
        const terrainResponse = await currentTerrainRasterTileResponse(url, mapArtifacts)
        if (terrainResponse) return secure(terrainResponse)
      }
      if (url.pathname === '/map/scenery/current/tileset.json') return secure(await currentSceneryTilesetResponse(mapArtifacts))
      if (url.pathname.startsWith('/map/scenery/current/')) {
        const sceneryResponse = await currentSceneryTileResponse(url, mapArtifacts)
        if (sceneryResponse) return secure(sceneryResponse)
      }
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
      message(socket, message) {
        void handleRealtimeClientMessage(socket, message)
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
