import { resolve, normalize } from 'node:path'
import type { ServerWebSocket } from 'bun'
import { controlInstanceIdSchema, type ControlInstanceId } from '../model/index.ts'
import type { ControlInstanceRegistry } from '../control-instances/registry.ts'
import {
  createMapArtifactConfigFromEnv,
  createMapArtifactStatus,
  currentPmtilesResponse,
  mapCapabilitiesResponse,
  mapStyleResponse,
  type MapArtifactConfig,
} from '../../map/artifacts.ts'
import { handleControlInstanceApi } from './control-instance-routes.ts'
import { createControlInstanceRealtimeManager, emptyRealtimeStatus, type RealtimeStatus } from './realtime.ts'
import { json } from './responses.ts'

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

const serveStatic = async (pathname: string, uiDistPath: string): Promise<Response | null> => {
  const normalizedPath = pathname === '/' || pathname === '/i' || pathname.startsWith('/i/') ? '/index.html' : pathname
  const filePath = normalize(`${uiDistPath}${normalizedPath}`)
  if (!filePath.startsWith(uiDistPath)) return new Response('Forbidden', { status: 403 })
  const file = Bun.file(filePath)
  if (!await file.exists()) return null
  const contentType = filePath.endsWith('.html')
    ? 'text/html'
    : filePath.endsWith('.css')
      ? 'text/css'
      : filePath.endsWith('.js')
        ? 'application/javascript'
        : 'application/octet-stream'
  return new Response(file, { headers: { 'Content-Type': contentType } })
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
      const url = new URL(req.url)
      if (url.pathname === '/health') {
        return json({
          ok: true,
          mapArtifacts: await createMapArtifactStatus(mapArtifacts),
        })
      }
      if (url.pathname === '/health/details') {
        return json(await createHealthDetails({ registry: config.registry, realtime: realtime.status(), mapArtifacts }))
      }
      if (url.pathname === '/map/capabilities.json') return mapCapabilitiesResponse()
      if (url.pathname === '/map/style.json') return mapStyleResponse(url.searchParams.get('theme'))
      if (url.pathname === '/map/tiles/current.pmtiles') return currentPmtilesResponse(req, mapArtifacts)

      const controlInstanceApiResponse = await handleControlInstanceApi(req, url, {
        registry: config.registry,
        websocketClients: realtime.status().controlInstances,
      })
      if (controlInstanceApiResponse) {
        realtime.reconcile()
        return controlInstanceApiResponse
      }

      if (url.pathname === '/ws') {
        const rawControlInstanceId = url.searchParams.get('controlInstance')
        if (!rawControlInstanceId) return new Response('Missing controlInstance', { status: 400 })
        const controlInstanceId = controlInstanceIdSchema.parse(rawControlInstanceId)
        if (!config.registry.get(controlInstanceId)) return new Response('Control instance not found', { status: 404 })
        const upgraded = serverApi.upgrade(req, { data: { controlInstanceId } })
        return upgraded ? undefined : new Response('WebSocket upgrade failed', { status: 400 })
      }

      const staticResponse = await serveStatic(url.pathname, uiDistPath)
      if (staticResponse) return staticResponse
      return new Response('Not found', { status: 404 })
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
