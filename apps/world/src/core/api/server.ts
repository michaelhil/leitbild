import { resolve, normalize } from 'node:path'
import type { ServerWebSocket } from 'bun'
import { z } from 'zod'
import { actorIdSchema, clientIdSchema, simulationRunIdSchema, nowIso, type CommandResult, type SimulationRunId } from '../model/index.ts'
import type { SimulationRunRegistry } from '../simulation-runs/registry.ts'
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
  buildSimulationRunActor,
  buildSimulationRunCommand,
  handleSimulationRunApi,
} from './simulation-run-routes.ts'
import {
  commandIdempotencyConfigFromEnv,
  commandIdempotencyStoreForRuntime,
  issueCommandWithIdempotency,
} from './command-idempotency.ts'
import { createSimulationRunRealtimeManager, emptyRealtimeStatus, type RealtimeStatus, type SimulationRunRealtimeManager } from './realtime.ts'
import { apiError, json } from './responses.ts'
import { workspaceIdSchema, type WorkspaceId } from '@leitbild/contracts'
import { createOpenAccessContext } from '../workspaces/request-context.ts'
import type { WorldWorkspaceRuntime, WorldWorkspaceRuntimeRegistry } from '../workspaces/runtime-registry.ts'
import { handleWorldModuleApi } from './workspace-module-api.ts'

const frameAncestorsHeader = "frame-ancestors 'self'"
const defaultRealtimeInputActorId = actorIdSchema.parse('actor:operator')

interface ServerConfig {
  readonly workspaces: WorldWorkspaceRuntimeRegistry
  readonly port?: number
  readonly bindHost?: string
  readonly uiDistPath?: string
  readonly mapArtifacts?: MapArtifactConfig
  readonly workspaceHostUrl?: string
}

interface WSData {
  readonly workspaceId: WorkspaceId
  readonly simulationRunId: SimulationRunId
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
  readonly registry: SimulationRunRegistry
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
  readonly registry: Awaited<ReturnType<SimulationRunRegistry['status']>>
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
  const normalizedPath = pathname.startsWith('/workspaces/') ? '/index.html' : pathname
  const filePath = normalize(`${uiDistPath}${normalizedPath}`)
  if (!filePath.startsWith(uiDistPath)) return new Response('Forbidden', { status: 403 })
  const file = Bun.file(filePath)
  if (!await file.exists()) return null
  return new Response(file, { headers: { 'Content-Type': staticContentTypeForPath(filePath) } })
}

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

export const createServer = (config: ServerConfig): { readonly stop: () => void; readonly port: number } => {
  const port = config.port ?? Number(process.env.PORT ?? 3000)
  const bindHost = config.bindHost ?? process.env.LEITBILD_BIND_HOST ?? '0.0.0.0'
  const uiDistPath = resolve(config.uiDistPath ?? `${import.meta.dir}/../../ui/dist`)
  const mapArtifacts = config.mapArtifacts ?? createMapArtifactConfigFromEnv()
  const realtimeByWorkspace = new Map<WorkspaceId, SimulationRunRealtimeManager<ServerWebSocket<WSData>>>()

  const realtimeFor = (workspaceRuntime: WorldWorkspaceRuntime): SimulationRunRealtimeManager<ServerWebSocket<WSData>> => {
    const current = realtimeByWorkspace.get(workspaceRuntime.workspaceId)
    if (current) return current
    const realtime = createSimulationRunRealtimeManager<ServerWebSocket<WSData>>({
      registry: workspaceRuntime.simulationRuns,
      send: (socket, message) => socket.send(JSON.stringify(message)),
      sendReady: (socket, message) => socket.send(JSON.stringify(message)),
    })
    realtimeByWorkspace.set(workspaceRuntime.workspaceId, realtime)
    return realtime
  }

  const sendRealtimeCommandError = (
    socket: ServerWebSocket<WSData>,
    requestId: string | undefined,
    message: string,
  ): void => {
    socket.send(JSON.stringify({
      type: 'command.error',
      workspaceId: socket.data.workspaceId,
      simulationRunId: socket.data.simulationRunId,
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
      workspaceId: socket.data.workspaceId,
      simulationRunId: socket.data.simulationRunId,
      ...(inputType === undefined ? {} : { inputType }),
      message,
    }))
  }

  const issueRealtimeCommand = async (
    workspaceId: WorkspaceId,
    simulationRunId: SimulationRunId,
    rawCommand: unknown,
  ): Promise<CommandResult> => {
    const runtime = config.workspaces.getLoaded(workspaceId)?.simulationRuns.get(simulationRunId)
    if (!runtime) {
      return {
        ok: false,
        commandId: `command:${crypto.randomUUID()}` as CommandResult['commandId'],
        rejectedAt: nowIso(),
        reason: 'simulation run not found',
      }
    }
    const command = buildSimulationRunCommand(simulationRunId, rawCommand)
    const actor = buildSimulationRunActor(command.actorId)
    const issued = await issueCommandWithIdempotency({
      store: commandIdempotencyStoreForRuntime(workspaceId, simulationRunId),
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
        const runtime = config.workspaces.getLoaded(socket.data.workspaceId)?.simulationRuns.get(socket.data.simulationRunId)
        if (!runtime) {
          sendRealtimeInputError(socket, parsed.input.type, 'simulation run not found')
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
      const result = await issueRealtimeCommand(socket.data.workspaceId, socket.data.simulationRunId, parsed.command)
      socket.send(JSON.stringify({
        type: 'command.result',
        workspaceId: socket.data.workspaceId,
        simulationRunId: socket.data.simulationRunId,
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
        const workspaces = await config.workspaces.list()
        return secure(json({
          ok: true,
          generatedAt: new Date().toISOString(),
          process: { pid: process.pid, uptimeSeconds: process.uptime(), memory: memoryStatus() },
          mapArtifacts: await createMapArtifactStatus(mapArtifacts),
          workspaces: await Promise.all(workspaces.map(async workspace => {
            const runtime = config.workspaces.getLoaded(workspace.workspaceId)
            return {
              workspaceId: workspace.workspaceId,
              moduleId: workspace.moduleId,
              createdAt: workspace.createdAt,
              loaded: runtime !== undefined,
              ...(runtime === undefined ? {} : { registry: await runtime.simulationRuns.status() }),
              realtime: realtimeByWorkspace.get(workspace.workspaceId)?.status() ?? emptyRealtimeStatus(),
            }
          })),
        }))
      }
      const workspaceModuleResponse = await handleWorldModuleApi(req, url, config.workspaces)
      if (workspaceModuleResponse) return secure(workspaceModuleResponse)
      if ((url.pathname === '/' || url.pathname === '/index.html') && req.method === 'GET') {
        const location = config.workspaceHostUrl ?? process.env.WORKSPACE_HOST_URL
        return location
          ? secure(new Response(null, { status: 303, headers: { Location: location } }))
          : secure(apiError(404, 'workspace_host_required', 'Open this Module through the Workspace Host'))
      }
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

      const workspaceScopeMatch = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/world(?:\/|$)/)
      if (workspaceScopeMatch) {
        const workspaceIdResult = workspaceIdSchema.safeParse(decodeURIComponent(workspaceScopeMatch[1] ?? ''))
        if (!workspaceIdResult.success) return secure(apiError(400, 'invalid_request', workspaceIdResult.error.message))
        const workspaceId = workspaceIdResult.data
        let workspaceRuntime: WorldWorkspaceRuntime
        try {
          workspaceRuntime = await config.workspaces.getOrLoad(workspaceId)
        } catch (err) {
          if ((err as Error).message.startsWith('World Module not provisioned:')) {
            return secure(apiError(404, 'workspace_not_found', 'World is not enabled in this Workspace'))
          }
          throw err
        }
        const realtime = realtimeFor(workspaceRuntime)
      const simulationRunApiResponse = await handleSimulationRunApi(req, url, {
          registry: workspaceRuntime.simulationRuns,
          accessContext: createOpenAccessContext(workspaceId, req),
      })
      if (simulationRunApiResponse) {
        realtime.reconcile()
        return secure(simulationRunApiResponse)
      }

        if (url.pathname === `/api/workspaces/${encodeURIComponent(workspaceId)}/world/ws`) {
        const rawSimulationRunId = url.searchParams.get('simulationRun')
        if (!rawSimulationRunId) return secure(new Response('Missing simulationRun', { status: 400 }))
          const simulationRunIdResult = simulationRunIdSchema.safeParse(rawSimulationRunId)
          if (!simulationRunIdResult.success) return secure(new Response('Invalid Simulation Run id', { status: 400 }))
          const simulationRunId = simulationRunIdResult.data
          try {
            await workspaceRuntime.simulationRuns.load(simulationRunId)
          } catch (err) {
            if ((err as Error).message.startsWith('Simulation Run not found:')) {
              return secure(new Response('Simulation Run not found', { status: 404 }))
            }
            throw err
          }
        const upgraded = serverApi.upgrade(req, { data: { workspaceId, simulationRunId } })
        return upgraded ? undefined : secure(new Response('WebSocket upgrade failed', { status: 400 }))
        }
      }

      const staticResponse = await serveStatic(url.pathname, uiDistPath)
      if (staticResponse) return secure(staticResponse)
      return secure(new Response('Not found', { status: 404 }))
    },
    websocket: {
      open(socket) {
        const workspaceRuntime = config.workspaces.getLoaded(socket.data.workspaceId)
        if (!workspaceRuntime) return socket.close(1011, 'Workspace runtime unavailable')
        realtimeFor(workspaceRuntime).addClient(socket.data.simulationRunId, socket)
      },
      close(socket) {
        realtimeByWorkspace.get(socket.data.workspaceId)?.removeClient(socket.data.simulationRunId, socket)
      },
      message(socket, message) {
        void handleRealtimeClientMessage(socket, message)
      },
    },
  })

  return {
    port: server.port ?? port,
    stop: () => {
      for (const realtime of realtimeByWorkspace.values()) realtime.stop()
      realtimeByWorkspace.clear()
      void config.workspaces.shutdown()
      server.stop()
    },
  }
}
