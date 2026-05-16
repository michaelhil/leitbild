import { resolve, normalize } from 'node:path'
import type { ServerWebSocket } from 'bun'
import { controlInstanceIdSchema, type ControlInstanceId } from '../model/index.ts'
import type { ControlInstanceRegistry } from '../control-instances/registry.ts'
import type { ControlInstanceEventNotification } from '../control-instances/runtime.ts'
import { handleControlInstanceApi } from './control-instance-routes.ts'
import { json } from './responses.ts'

interface ServerConfig {
  readonly registry: ControlInstanceRegistry
  readonly port?: number
  readonly uiDistPath?: string
}

interface WSData {
  readonly controlInstanceId: ControlInstanceId
}

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
  const socketsByControlInstance = new Map<ControlInstanceId, Set<ServerWebSocket<WSData>>>()
  const unsubscribersByControlInstance = new Map<ControlInstanceId, () => void>()

  const broadcastToControlInstance = (controlInstanceId: ControlInstanceId, notification: ControlInstanceEventNotification): void => {
    const sockets = socketsByControlInstance.get(controlInstanceId)
    if (!sockets) return
    const message = JSON.stringify({ type: 'events', events: notification.events })
    for (const socket of sockets) socket.send(message)
  }

  const ensureControlInstanceSubscription = (controlInstanceId: ControlInstanceId): void => {
    if (unsubscribersByControlInstance.has(controlInstanceId)) return
    const runtime = config.registry.get(controlInstanceId)
    if (!runtime) throw new Error(`cannot subscribe unknown control instance: ${controlInstanceId}`)
    const unsubscribe = runtime.subscribe(event => broadcastToControlInstance(controlInstanceId, event))
    unsubscribersByControlInstance.set(controlInstanceId, unsubscribe)
  }

  const server = Bun.serve<WSData>({
    port,
    async fetch(req, serverApi) {
      const url = new URL(req.url)
      if (url.pathname === '/health') return json({ ok: true })

      const controlInstanceApiResponse = await handleControlInstanceApi(req, url, { registry: config.registry })
      if (controlInstanceApiResponse) return controlInstanceApiResponse

      if (url.pathname === '/ws') {
        const rawControlInstanceId = url.searchParams.get('controlInstance')
        if (!rawControlInstanceId) return new Response('Missing controlInstance', { status: 400 })
        const controlInstanceId = controlInstanceIdSchema.parse(rawControlInstanceId)
        if (!config.registry.get(controlInstanceId)) return new Response('Control instance not found', { status: 404 })
        ensureControlInstanceSubscription(controlInstanceId)
        const upgraded = serverApi.upgrade(req, { data: { controlInstanceId } })
        return upgraded ? undefined : new Response('WebSocket upgrade failed', { status: 400 })
      }

      const staticResponse = await serveStatic(url.pathname, uiDistPath)
      if (staticResponse) return staticResponse
      return new Response('Not found', { status: 404 })
    },
    websocket: {
      open(socket) {
        const sockets = socketsByControlInstance.get(socket.data.controlInstanceId) ?? new Set<ServerWebSocket<WSData>>()
        sockets.add(socket)
        socketsByControlInstance.set(socket.data.controlInstanceId, sockets)
      },
      close(socket) {
        const sockets = socketsByControlInstance.get(socket.data.controlInstanceId)
        if (!sockets) return
        sockets.delete(socket)
        if (sockets.size === 0) socketsByControlInstance.delete(socket.data.controlInstanceId)
      },
      message() {
        // Browser-to-server commands use REST for validation, status codes, and auditability.
      },
    },
  })

  return {
    port,
    stop: () => {
      for (const unsubscribe of unsubscribersByControlInstance.values()) unsubscribe()
      server.stop()
    },
  }
}
