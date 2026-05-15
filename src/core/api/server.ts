import { resolve, normalize } from 'node:path'
import { z } from 'zod'
import type { ServerWebSocket } from 'bun'
import { actorIdSchema, commandEnvelopeSchema, commandIdSchema, nowIso, sessionIdSchema, type CommandEnvelope, type DomainEvent, type SessionId } from '../model/index.ts'
import type { SessionRegistry } from '../sessions/registry.ts'
import type { Participant } from '../sessions/roles.ts'

interface ServerConfig {
  readonly registry: SessionRegistry
  readonly port?: number
  readonly uiDistPath?: string
}

interface WSData {
  readonly sessionId: SessionId
}

const commandRequestSchema = z.object({
  actorId: actorIdSchema.default('actor:operator'),
  kind: z.string().min(1),
  targetObjectIds: z.array(z.string().min(1)),
  payload: z.unknown(),
  expectedRevision: z.number().int().nonnegative().optional(),
})

const json = (body: unknown, init?: ResponseInit): Response =>
  new Response(JSON.stringify(body), {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  })

const readJson = async (req: Request): Promise<unknown> => {
  const text = await req.text()
  if (text.trim().length === 0) return {}
  return JSON.parse(text) as unknown
}

const buildParticipant = (actorId: string): Participant => ({
  id: actorId,
  label: actorId,
  role: 'operator',
})

const buildCommand = (sessionId: SessionId, raw: unknown): CommandEnvelope => {
  const parsed = commandRequestSchema.parse(raw)
  const candidate = {
    id: `command:${crypto.randomUUID()}`,
    sessionId,
    actorId: parsed.actorId,
    kind: parsed.kind,
    targetObjectIds: parsed.targetObjectIds,
    payload: parsed.payload,
    issuedAt: nowIso(),
    ...(parsed.expectedRevision === undefined ? {} : { expectedRevision: parsed.expectedRevision }),
  }
  return commandEnvelopeSchema.parse(candidate) as CommandEnvelope
}

const serveStatic = async (pathname: string, uiDistPath: string): Promise<Response | null> => {
  const normalizedPath = pathname === '/' ? '/index.html' : pathname
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
  const socketsBySession = new Map<SessionId, Set<ServerWebSocket<WSData>>>()
  const unsubscribersBySession = new Map<SessionId, () => void>()

  const broadcastToSession = (sessionId: SessionId, event: DomainEvent): void => {
    const sockets = socketsBySession.get(sessionId)
    if (!sockets) return
    const message = JSON.stringify({ type: 'event', event })
    for (const socket of sockets) socket.send(message)
  }

  const ensureSessionSubscription = (sessionId: SessionId): void => {
    if (unsubscribersBySession.has(sessionId)) return
    const session = config.registry.get(sessionId)
    if (!session) throw new Error(`cannot subscribe unknown session: ${sessionId}`)
    const unsubscribe = session.subscribe(event => broadcastToSession(sessionId, event))
    unsubscribersBySession.set(sessionId, unsubscribe)
  }

  const server = Bun.serve<WSData>({
    port,
    async fetch(req, serverApi) {
      const url = new URL(req.url)
      if (url.pathname === '/health') return json({ ok: true })

      if (url.pathname === '/api/session' && req.method === 'GET') {
        return json({ sessions: config.registry.list().map(session => ({ id: session.id, snapshot: session.snapshot() })) })
      }

      if (url.pathname === '/api/session' && req.method === 'POST') {
        const session = await config.registry.create()
        ensureSessionSubscription(session.id)
        return json({ id: session.id, snapshot: session.snapshot() }, { status: 201 })
      }

      const snapshotMatch = url.pathname.match(/^\/api\/session\/([^/]+)\/snapshot$/)
      if (snapshotMatch && req.method === 'GET') {
        const sessionId = sessionIdSchema.parse(decodeURIComponent(snapshotMatch[1] ?? ''))
        const session = config.registry.get(sessionId)
        if (!session) return json({ error: 'session not found' }, { status: 404 })
        return json({ id: session.id, snapshot: session.snapshot() })
      }

      const commandMatch = url.pathname.match(/^\/api\/session\/([^/]+)\/command$/)
      if (commandMatch && req.method === 'POST') {
        const sessionId = sessionIdSchema.parse(decodeURIComponent(commandMatch[1] ?? ''))
        const session = config.registry.get(sessionId)
        if (!session) return json({ error: 'session not found' }, { status: 404 })
        const raw = await readJson(req)
        const command = buildCommand(sessionId, raw)
        const participant = buildParticipant(command.actorId)
        const result = await session.issueCommand(participant, command)
        return json({ result })
      }

      if (url.pathname === '/ws') {
        const rawSessionId = url.searchParams.get('session')
        if (!rawSessionId) return new Response('Missing session', { status: 400 })
        const sessionId = sessionIdSchema.parse(rawSessionId)
        if (!config.registry.get(sessionId)) return new Response('Session not found', { status: 404 })
        ensureSessionSubscription(sessionId)
        const upgraded = serverApi.upgrade(req, { data: { sessionId } })
        return upgraded ? undefined : new Response('WebSocket upgrade failed', { status: 400 })
      }

      const staticResponse = await serveStatic(url.pathname, uiDistPath)
      if (staticResponse) return staticResponse
      return new Response('Not found', { status: 404 })
    },
    websocket: {
      open(socket) {
        const sockets = socketsBySession.get(socket.data.sessionId) ?? new Set<ServerWebSocket<WSData>>()
        sockets.add(socket)
        socketsBySession.set(socket.data.sessionId, sockets)
      },
      close(socket) {
        const sockets = socketsBySession.get(socket.data.sessionId)
        if (!sockets) return
        sockets.delete(socket)
        if (sockets.size === 0) socketsBySession.delete(socket.data.sessionId)
      },
      message() {
        // Browser-to-server commands use REST for validation, status codes, and auditability.
      },
    },
  })

  return {
    port,
    stop: () => {
      for (const unsubscribe of unsubscribersBySession.values()) unsubscribe()
      server.stop()
    },
  }
}
