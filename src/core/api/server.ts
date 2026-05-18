import { resolve, normalize } from 'node:path'
import type { ServerWebSocket } from 'bun'
import { controlInstanceIdSchema, type ControlInstanceId, type SimulationClockState } from '../model/index.ts'
import type { ControlInstanceRegistry } from '../control-instances/registry.ts'
import type { ControlInstanceEventNotification } from '../control-instances/runtime.ts'
import {
  createMapArtifactConfigFromEnv,
  createMapArtifactStatus,
  currentPmtilesResponse,
  mapCapabilitiesResponse,
  mapStyleResponse,
  type MapArtifactConfig,
} from '../../map/artifacts.ts'
import { handleControlInstanceApi } from './control-instance-routes.ts'
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

interface RealtimeSubscription {
  readonly runtime: NonNullable<ReturnType<ControlInstanceRegistry['get']>>
  readonly unsubscribe: () => void
}

interface SubscriptionReconciliation {
  readonly runtime: NonNullable<ReturnType<ControlInstanceRegistry['get']>> | null
  readonly changed: boolean
}

export interface RealtimeStatus {
  readonly websocketClientCount: number
  readonly subscribedControlInstanceCount: number
  readonly controlInstances: ReadonlyArray<{
    readonly id: ControlInstanceId
    readonly websocketClientCount: number
  }>
}

export interface RealtimeReadyMessage {
  readonly type: 'realtime.ready'
  readonly controlInstanceId: ControlInstanceId
  readonly scenarioId?: string
  readonly snapshotSeq: number
  readonly clock?: SimulationClockState
}

export interface RealtimeEventBatchMessage {
  readonly type: 'events'
  readonly controlInstanceId: ControlInstanceId
  readonly scenarioId?: string
  readonly snapshotSeq: number
  readonly events: ControlInstanceEventNotification['events']
}

export interface ControlInstanceRealtimeManager<Client> {
  readonly addClient: (controlInstanceId: ControlInstanceId, client: Client) => void
  readonly removeClient: (controlInstanceId: ControlInstanceId, client: Client) => void
  readonly reconcile: () => void
  readonly status: () => RealtimeStatus
  readonly stop: () => void
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

const emptyRealtimeStatus = (): RealtimeStatus => ({
  websocketClientCount: 0,
  subscribedControlInstanceCount: 0,
  controlInstances: [],
})

const realtimeStatusFromClients = <Client>(
  clientsByControlInstance: ReadonlyMap<ControlInstanceId, ReadonlySet<Client>>,
  subscribedControlInstanceCount: number,
): RealtimeStatus => {
  const controlInstances = [...clientsByControlInstance.entries()]
    .map(([id, clients]) => ({ id, websocketClientCount: clients.size }))
    .sort((left, right) => left.id.localeCompare(right.id))
  return {
    websocketClientCount: controlInstances.reduce((count, item) => count + item.websocketClientCount, 0),
    subscribedControlInstanceCount,
    controlInstances,
  }
}

export const createControlInstanceRealtimeManager = <Client>(config: {
  readonly registry: ControlInstanceRegistry
  readonly send: (client: Client, message: RealtimeEventBatchMessage) => void
  readonly sendReady: (client: Client, message: RealtimeReadyMessage) => void
}): ControlInstanceRealtimeManager<Client> => {
  const clientsByControlInstance = new Map<ControlInstanceId, Set<Client>>()
  const subscriptionsByControlInstance = new Map<ControlInstanceId, RealtimeSubscription>()

  const messageContextForRuntime = (
    controlInstanceId: ControlInstanceId,
    runtime: NonNullable<ReturnType<ControlInstanceRegistry['get']>>,
  ): Omit<RealtimeReadyMessage, 'type' | 'clock'> => {
    const snapshot = runtime.snapshot()
    return {
      controlInstanceId,
      ...(snapshot.scenario?.scenarioId === undefined ? {} : { scenarioId: snapshot.scenario.scenarioId }),
      snapshotSeq: snapshot.seq,
    }
  }

  const broadcastToControlInstance = (
    controlInstanceId: ControlInstanceId,
    runtime: NonNullable<ReturnType<ControlInstanceRegistry['get']>>,
    notification: ControlInstanceEventNotification,
  ): void => {
    const subscription = subscriptionsByControlInstance.get(controlInstanceId)
    if (subscription?.runtime !== runtime) return
    const clients = clientsByControlInstance.get(controlInstanceId)
    if (!clients) return
    const message: RealtimeEventBatchMessage = {
      type: 'events',
      ...messageContextForRuntime(controlInstanceId, runtime),
      events: notification.events,
    }
    for (const client of clients) config.send(client, message)
  }

  const readyMessageForRuntime = (
    controlInstanceId: ControlInstanceId,
    runtime: NonNullable<ReturnType<ControlInstanceRegistry['get']>>,
  ): RealtimeReadyMessage => {
    const snapshot = runtime.snapshot()
    return {
      type: 'realtime.ready',
      ...messageContextForRuntime(controlInstanceId, runtime),
      ...(snapshot.clock === undefined ? {} : { clock: snapshot.clock }),
    }
  }

  const sendReadyToControlInstance = (
    controlInstanceId: ControlInstanceId,
    runtime: NonNullable<ReturnType<ControlInstanceRegistry['get']>>,
  ): void => {
    const clients = clientsByControlInstance.get(controlInstanceId)
    if (!clients) return
    const message = readyMessageForRuntime(controlInstanceId, runtime)
    for (const client of clients) config.sendReady(client, message)
  }

  const sendReadyToClient = (
    controlInstanceId: ControlInstanceId,
    runtime: NonNullable<ReturnType<ControlInstanceRegistry['get']>>,
    client: Client,
  ): void => {
    config.sendReady(client, readyMessageForRuntime(controlInstanceId, runtime))
  }

  const reconcileControlInstanceSubscription = (controlInstanceId: ControlInstanceId): SubscriptionReconciliation => {
    const clients = clientsByControlInstance.get(controlInstanceId)
    const existing = subscriptionsByControlInstance.get(controlInstanceId)
    if (!clients || clients.size === 0) {
      existing?.unsubscribe()
      subscriptionsByControlInstance.delete(controlInstanceId)
      return { runtime: null, changed: existing !== undefined }
    }
    const runtime = config.registry.get(controlInstanceId)
    if (!runtime) {
      existing?.unsubscribe()
      subscriptionsByControlInstance.delete(controlInstanceId)
      return { runtime: null, changed: existing !== undefined }
    }
    if (existing?.runtime === runtime) return { runtime, changed: false }
    existing?.unsubscribe()
    const unsubscribe = runtime.subscribe(event => broadcastToControlInstance(controlInstanceId, runtime, event))
    subscriptionsByControlInstance.set(controlInstanceId, { runtime, unsubscribe })
    return { runtime, changed: true }
  }

  return {
    addClient: (controlInstanceId, client): void => {
      const clients = clientsByControlInstance.get(controlInstanceId) ?? new Set<Client>()
      clients.add(client)
      clientsByControlInstance.set(controlInstanceId, clients)
      const { runtime } = reconcileControlInstanceSubscription(controlInstanceId)
      if (runtime) sendReadyToClient(controlInstanceId, runtime, client)
    },
    removeClient: (controlInstanceId, client): void => {
      const clients = clientsByControlInstance.get(controlInstanceId)
      if (!clients) return
      clients.delete(client)
      if (clients.size === 0) clientsByControlInstance.delete(controlInstanceId)
      reconcileControlInstanceSubscription(controlInstanceId)
    },
    reconcile: (): void => {
      for (const controlInstanceId of clientsByControlInstance.keys()) {
        const { runtime, changed } = reconcileControlInstanceSubscription(controlInstanceId)
        if (runtime && changed) sendReadyToControlInstance(controlInstanceId, runtime)
      }
    },
    status: () => realtimeStatusFromClients(clientsByControlInstance, subscriptionsByControlInstance.size),
    stop: (): void => {
      for (const { unsubscribe } of subscriptionsByControlInstance.values()) unsubscribe()
      subscriptionsByControlInstance.clear()
      clientsByControlInstance.clear()
    },
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
