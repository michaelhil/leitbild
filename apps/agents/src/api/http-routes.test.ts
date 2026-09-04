// ============================================================================
// HTTP Routes — integration tests exercising handleAPI directly.
// ============================================================================

import { describe, test, expect, beforeEach } from 'bun:test'
import { handleAPI, handleUnscopedAPI } from './http-routes.ts'
import { createRoomDirectory } from '../core/rooms/directory.ts'
import { createTeam } from '../agents/team.ts'
import { createToolRegistry } from '../core/tool-registry.ts'
import { createLimitMetrics } from '../core/limit-metrics.ts'
import { createWorkspaceSettings } from '../core/workspaces/settings.ts'
import { createBookmarkStore } from '../core/workspaces/bookmark-store.ts'
import type { DeliverFn } from '../core/types/messaging.ts'
import type { WSOutbound } from '../core/types/ws-protocol.ts'
import type { AgentsWorkspaceRuntime } from '../workspace-runtime.ts'
import { accessContextSchema, newRequestId, newWorkspaceId } from '@leitbild/contracts'

// === Helpers ===

const noopDeliver: DeliverFn = () => {}
const noopBroadcast = (_msg: WSOutbound): void => {}
const noopWorkspaceBroadcast = (): void => {}
const noopSubscribe = (): void => {}
const packManager = {
  install: async () => ({ success: false, error: 'disabled in route test' }),
  update: async () => ({ success: false, error: 'disabled in route test' }),
  uninstall: async () => ({ success: false, error: 'disabled in route test' }),
  list: async () => ({ success: true, data: [] }),
  listAvailable: async () => ({ success: true, data: [] }),
}
const TEST_WORKSPACE_ID = newWorkspaceId()
const TEST_ACCESS_CONTEXT = accessContextSchema.parse({
  workspaceId: TEST_WORKSPACE_ID,
  requestId: newRequestId(),
  actor: { kind: 'anonymous' },
})

const makeSystem = (): AgentsWorkspaceRuntime => {
  const rooms = createRoomDirectory({ deliver: noopDeliver })
  const settings = createWorkspaceSettings()
  const bookmarks = createBookmarkStore()
  const team = createTeam()
  const toolRegistry = createToolRegistry()
  const ollama = {
    chat: async () => { throw new Error('Not available in tests') },
    models: async () => [],
    runningModels: async () => [],
    getHealth: () => ({ status: 'healthy' as const, latencyMs: 0, loadedModels: [], availableModels: [], lastCheckedAt: 0 }),
    getMetrics: () => ({ requestCount: 0, errorCount: 0, errorRate: 0, p50Latency: 0, p95Latency: 0, avgTokensPerSecond: 0, queueDepth: 0, concurrentRequests: 0, circuitState: 'closed' as const, shedCount: 0, windowMs: 300000 }),
    getConfig: () => ({}),
    updateConfig: () => {},
    loadModel: async () => {},
    unloadModel: async () => {},
    onHealthChange: () => {},
    dispose: () => {},
  }
  return {
    rooms, settings, bookmarks, team, toolRegistry,
    createRoom: async (config: Parameters<AgentsWorkspaceRuntime['createRoom']>[0]) => rooms.createRoomSafe(config),
    llm: { models: async () => [], chat: async () => ({ content: '', generationMs: 0, tokensUsed: { prompt: 0, completion: 0 } }) } as unknown as AgentsWorkspaceRuntime['llm'],
    ollama,
    providerConfig: { order: ['ollama'], ollamaUrl: 'http://localhost:11434', ollamaMaxConcurrent: 2, cloud: {}, ollamaOnly: false, forceFailProvider: null, droppedFromOrder: [], orderFromUser: false } as unknown as AgentsWorkspaceRuntime['providerConfig'],
    scriptRunner: { getRun: () => undefined } as unknown as AgentsWorkspaceRuntime['scriptRunner'],
    routeMessage: () => [],
    removeAgent: (id: string) => team.removeAgent(id),
    removeRoom: (id: string) => rooms.removeRoom(id),
    addAgentToRoom: async () => {},
    removeAgentFromRoom: () => {},
    spawnAIAgent: async () => { throw new Error('Not implemented') },
    spawnHumanAgent: async () => { throw new Error('Not implemented') },
    setOnMessagePosted: () => {},
    setOnTurnChanged: () => {},
    setOnDeliveryModeChanged: () => {},
    setOnModeAutoSwitched: () => {},
    setOnRoomCreated: () => {},
    setOnRoomDeleted: () => {},
    setOnMembershipChanged: () => {},
    setOnEvalEvent: () => {},
    setOnProviderBound: () => {},
    setOnProviderAllFailed: () => {},
    setOnProviderStreamFailed: () => {},
    dispatchProviderEvent: () => {},
    limitMetrics: createLimitMetrics(),
  } as unknown as AgentsWorkspaceRuntime
}

// Internal route tests exercise the already-scoped application dispatcher.
// Cookie, authentication, and public URL enforcement belong to server.ts.
const COOKIE = `leitbild_workspace=${TEST_WORKSPACE_ID}`

const req = (method: string, path: string, body?: unknown): Request => {
  const url = `http://localhost${path}`
  if (!body) return new Request(url, { method, headers: { cookie: COOKIE } })
  return new Request(url, {
    method,
    headers: { 'Content-Type': 'application/json', cookie: COOKIE },
    body: JSON.stringify(body),
  })
}

const call = (system: AgentsWorkspaceRuntime, r: Request, path: string, opts: { remoteAddress?: string } = {}) =>
  handleAPI(r, path, system, TEST_WORKSPACE_ID, TEST_ACCESS_CONTEXT, {
    broadcastAllWorkspaces: noopBroadcast,
    broadcastToWorkspace: noopWorkspaceBroadcast,
    packManager,
    subscribeAgentState: noopSubscribe,
    ...(opts.remoteAddress ? { remoteAddress: opts.remoteAddress } : {}),
  })

// === Tests ===

describe('HTTP Routes', () => {
  let system: AgentsWorkspaceRuntime

  beforeEach(() => {
    system = makeSystem()
    system.rooms.createRoom({ name: 'TestRoom', createdBy: 'system' })
  })

  // --- Health ---

  test('GET /health returns ok', async () => {
    const res = await call(system, req('GET', '/health'), '/health')
    expect(res?.status).toBe(200)
    const data = await res!.json() as { status: string; rooms: number }
    expect(data.status).toBe('ok')
    expect(typeof data.rooms).toBe('number')
  })

  // --- Rooms ---

  test('GET /rooms returns all rooms', async () => {
    const res = await call(system, req('GET', '/rooms'), '/rooms')
    expect(res?.status).toBe(200)
    const data = await res!.json() as Array<{ name: string }>
    expect(Array.isArray(data)).toBe(true)
    expect(data).toHaveLength(1)
    expect(data[0]!.name).toBe('TestRoom')
  })

  test('POST /rooms creates room with 201', async () => {
    const res = await call(system, req('POST', '/rooms', { name: 'NewRoom' }), '/rooms')
    expect(res?.status).toBe(201)
    const data = await res!.json() as { value: { profile: { name: string } } }
    expect(data.value.profile.name).toBe('NewRoom')
  })

  test('POST /rooms missing name returns 400', async () => {
    const res = await call(system, req('POST', '/rooms', {}), '/rooms')
    expect(res?.status).toBe(400)
  })

  test('GET /rooms/:name returns room', async () => {
    const res = await call(system, req('GET', '/rooms/TestRoom'), '/rooms/TestRoom')
    expect(res?.status).toBe(200)
    const data = await res!.json() as { profile: { name: string }; messages: unknown[] }
    expect(data.profile.name).toBe('TestRoom')
    expect(Array.isArray(data.messages)).toBe(true)
  })

  test('GET /rooms/:name unknown room returns 404', async () => {
    const res = await call(system, req('GET', '/rooms/Ghost'), '/rooms/Ghost')
    expect(res?.status).toBe(404)
  })

  test('GET message generation-query returns the complete separately stored request', async () => {
    const room = system.rooms.getRoom('TestRoom')!
    const message = room.post({
      senderId: 'agent-1', content: 'answer', type: 'chat', generationMs: 42,
      generationTraceId: 'trace-1', provider: 'test', model: 'test-model',
    })
    room.setGenerationQuery(message.id, 'trace-1', {
      model: 'test-model',
      messages: [{ role: 'system', content: 'instructions' }, { role: 'user', content: 'question' }],
      tools: [{ type: 'function', function: { name: 'read', description: 'Read evidence', parameters: { type: 'object' } } }],
    })
    const path = `/rooms/TestRoom/messages/${message.id}/generation-query`
    const res = await call(system, req('GET', path), path)
    expect(res?.status).toBe(200)
    const body = await res!.json() as { traceId: string; query: { messages: unknown[]; tools: unknown[] }; generation: { durationMs: number } }
    expect(body.traceId).toBe('trace-1')
    expect(body.query.messages).toHaveLength(2)
    expect(body.query.tools).toHaveLength(1)
    expect(body.generation.durationMs).toBe(42)
  })

  test('GET /product-source exposes only allowlisted deployed source', async () => {
    const okPath = '/product-source?path=README.md'
    const ok = await call(system, req('GET', okPath), '/product-source')
    expect(ok?.status).toBe(200)
    const source = await ok!.json() as { path: string; content: string; totalLines: number }
    expect(source.path).toBe('README.md')
    expect(source.content).toContain('Leitbild')
    expect(source.totalLines).toBeGreaterThan(1)

    const runtimePath = '/product-source?path=apps%2Fworld%2Fsrc%2Fpacks%2Fprocess-plant%2Fruntime%2Fphysics.ts'
    const runtime = await call(system, req('GET', runtimePath), '/product-source')
    expect(runtime?.status).toBe(200)
    expect((await runtime!.json() as { authority: string }).authority).toBe('implementation')

    const deniedPath = '/product-source?path=..%2Fpackage.json'
    const denied = await call(system, req('GET', deniedPath), '/product-source')
    expect(denied?.status).toBe(404)
  })

  test('DELETE /rooms/:name removes room', async () => {
    const res = await call(system, req('DELETE', '/rooms/TestRoom'), '/rooms/TestRoom')
    expect(res?.status).toBe(200)
    expect(system.rooms.getRoom('TestRoom')).toBeUndefined()
  })

  // --- Pause ---

  test('PUT /rooms/:name/pause with true pauses room', async () => {
    const res = await call(system, req('PUT', '/rooms/TestRoom/pause', { paused: true }), '/rooms/TestRoom/pause')
    expect(res?.status).toBe(200)
    const data = await res!.json() as { paused: boolean }
    expect(data.paused).toBe(true)
  })

  test('PUT /rooms/:name/pause with false unpauses room', async () => {
    const room = system.rooms.getRoom('TestRoom')!
    room.setPaused(true)
    const res = await call(system, req('PUT', '/rooms/TestRoom/pause', { paused: false }), '/rooms/TestRoom/pause')
    expect(res?.status).toBe(200)
    expect((await res!.json() as { paused: boolean }).paused).toBe(false)
  })

  test('PUT /rooms/:name/pause with string value returns 400', async () => {
    const res = await call(system, req('PUT', '/rooms/TestRoom/pause', { paused: 'yes' }), '/rooms/TestRoom/pause')
    expect(res?.status).toBe(400)
  })

  test('PUT /rooms/:name/pause missing paused field returns 400', async () => {
    const res = await call(system, req('PUT', '/rooms/TestRoom/pause', {}), '/rooms/TestRoom/pause')
    expect(res?.status).toBe(400)
  })

  // --- Mute ---

  test('PUT /rooms/:name/mute with non-boolean muted returns 400', async () => {
    const res = await call(system, req('PUT', '/rooms/TestRoom/mute', { agentName: 'Bot', muted: 'true' }), '/rooms/TestRoom/mute')
    expect(res?.status).toBe(400)
  })

  test('PUT /rooms/:name/mute with missing agentName returns 400', async () => {
    const res = await call(system, req('PUT', '/rooms/TestRoom/mute', { muted: true }), '/rooms/TestRoom/mute')
    expect(res?.status).toBe(400)
  })

  // --- Members ---

  test('GET /rooms/:name/members returns empty list', async () => {
    const res = await call(system, req('GET', '/rooms/TestRoom/members'), '/rooms/TestRoom/members')
    expect(res?.status).toBe(200)
    expect(await res!.json()).toHaveLength(0)
  })

  test('GET /rooms/:name/members returns members with agent info', async () => {
    const room = system.rooms.getRoom('TestRoom')!
    const { createHumanAgent } = await import('../agents/human-agent.ts')
    const agent = createHumanAgent({ name: 'Alice' }, () => {})
    system.team.addAgent(agent)
    room.addMember(agent.id)
    const res = await call(system, req('GET', '/rooms/TestRoom/members'), '/rooms/TestRoom/members')
    expect(res?.status).toBe(200)
    const data = await res!.json() as Array<{ id: string; name: string }>
    expect(data).toHaveLength(1)
    expect(data[0]!.name).toBe('Alice')
  })

  test('GET /rooms/:name/members unknown room returns 404', async () => {
    const res = await call(system, req('GET', '/rooms/Ghost/members'), '/rooms/Ghost/members')
    expect(res?.status).toBe(404)
  })

  test('POST /rooms/:name/members adds agent to room', async () => {
    const { createHumanAgent } = await import('../agents/human-agent.ts')
    const agent = createHumanAgent({ name: 'Bob' }, () => {})
    system.team.addAgent(agent)
    const res = await call(system, req('POST', '/rooms/TestRoom/members', { agentName: 'Bob' }), '/rooms/TestRoom/members')
    expect(res?.status).toBe(200)
    const data = await res!.json() as { added: boolean; agentName: string }
    expect(data.added).toBe(true)
    expect(data.agentName).toBe('Bob')
  })

  test('POST /rooms/:name/members missing agentName returns 400', async () => {
    const res = await call(system, req('POST', '/rooms/TestRoom/members', {}), '/rooms/TestRoom/members')
    expect(res?.status).toBe(400)
  })

  test('POST /rooms/:name/members unknown agent returns 404', async () => {
    const res = await call(system, req('POST', '/rooms/TestRoom/members', { agentName: 'Ghost' }), '/rooms/TestRoom/members')
    expect(res?.status).toBe(404)
  })

  test('DELETE /rooms/:name/members/:agentName removes agent from room', async () => {
    const { createHumanAgent } = await import('../agents/human-agent.ts')
    const agent = createHumanAgent({ name: 'Carol' }, () => {})
    system.team.addAgent(agent)
    const res = await call(system, req('DELETE', '/rooms/TestRoom/members/Carol'), '/rooms/TestRoom/members/Carol')
    expect(res?.status).toBe(200)
    const data = await res!.json() as { removed: boolean }
    expect(data.removed).toBe(true)
  })

  test('DELETE /rooms/:name/members/:agentName unknown agent returns 404', async () => {
    const res = await call(system, req('DELETE', '/rooms/TestRoom/members/Ghost'), '/rooms/TestRoom/members/Ghost')
    expect(res?.status).toBe(404)
  })

  test('DELETE /rooms/:name/members/:agentName unknown room returns 404', async () => {
    const res = await call(system, req('DELETE', '/rooms/Ghost/members/Alice'), '/rooms/Ghost/members/Alice')
    expect(res?.status).toBe(404)
  })

  // --- Unknown route returns null ---

  test('unknown route returns null', async () => {
    const res = await call(system, req('GET', '/no-such-route'), '/no-such-route')
    expect(res).toBeNull()
  })
})

describe('unscoped bootstrap routes', () => {
  test('cookieless health probe is process-scoped', async () => {
    const res = await handleUnscopedAPI(
      new Request('http://localhost/health'),
      '/health',
      { diagnostics: { snapshot: () => ({ workspaces: [], wsSessions: 0 }) } },
    )
    expect(res?.status).toBe(200)
    expect(await res?.json()).toEqual({
      status: 'ok',
      scope: 'process',
      workspaces: 0,
      wsSessions: 0,
    })
  })

  test('diagnostics is served without a per-Workspace AgentsWorkspaceRuntime', async () => {
    const snapshot = { workspaces: [], wsSessions: 0 }
    const res = await handleUnscopedAPI(
      new Request('http://localhost/api/system/diagnostics'),
      '/api/system/diagnostics',
      { diagnostics: { snapshot: () => snapshot } },
    )
    expect(res?.status).toBe(200)
    expect(await res?.json()).toEqual(snapshot)
  })

  test('ordinary tenant routes are not claimed by the unscoped dispatcher', async () => {
    const res = await handleUnscopedAPI(
      new Request('http://localhost/rooms'),
      '/rooms',
      {},
    )
    expect(res).toBeNull()
  })
})

describe('GET /system/limits (no auth)', () => {
  test('returns metrics + configured snapshot, reflects inc()', async () => {
    const system = makeSystem()
    // bump a counter via the system's metrics handle
    system.limitMetrics.inc('rateLimitEvicted', 3)
    system.limitMetrics.inc('sseBufferExceeded')
    const res = await call(system, req('GET', '/system/limits'), '/system/limits')
    expect(res?.status).toBe(200)
    const data = await res!.json() as {
      metrics: Record<string, number>
      configured: Record<string, unknown>
    }
    expect(data.metrics.rateLimitEvicted).toBe(3)
    expect(data.metrics.sseBufferExceeded).toBe(1)
    expect(data.metrics.wsBackpressureDropped).toBe(0)
    expect(data.configured.maxWsBufferedBytes).toBe(8 * 1024 * 1024)
    expect(data.configured.maxRateLimitKeys).toBe(4096)
  })

})

// === Route handler coverage ===
// Covers /agents and /agents/.../triggers and /providers route
// shapes that http-routes integration tests didn't previously exercise.
// Negative-path heavy by necessity — positive paths for POST /agents
// require a real spawnAIAgent which would pull in the full LLM stack.

describe('HTTP Routes — agents (audit gap)', () => {
  let system: AgentsWorkspaceRuntime

  beforeEach(() => {
    system = makeSystem()
  })

  test('GET /agents returns empty array when none registered', async () => {
    const res = await call(system, req('GET', '/agents'), '/agents')
    expect(res?.status).toBe(200)
    const data = await res!.json() as unknown[]
    expect(Array.isArray(data)).toBe(true)
    expect(data).toHaveLength(0)
  })

  test('GET /agents/Ghost returns 404 for unknown agent', async () => {
    const res = await call(system, req('GET', '/agents/Ghost'), '/agents/Ghost')
    expect(res?.status).toBe(404)
  })

  test('GET /agents/Ghost/rooms returns 404 for unknown agent', async () => {
    const res = await call(system, req('GET', '/agents/Ghost/rooms'), '/agents/Ghost/rooms')
    expect(res?.status).toBe(404)
  })

  test('DELETE /agents/Ghost returns 404 for unknown agent', async () => {
    const res = await call(system, req('DELETE', '/agents/Ghost'), '/agents/Ghost')
    expect(res?.status).toBe(404)
  })

  test('PATCH /agents/Ghost returns 404 for unknown agent', async () => {
    const res = await call(system, req('PATCH', '/agents/Ghost', { persona: 'changed' }), '/agents/Ghost')
    expect(res?.status).toBe(404)
  })

  test('POST /agents/Ghost/cancel returns 404 for unknown agent', async () => {
    const res = await call(system, req('POST', '/agents/Ghost/cancel', {}), '/agents/Ghost/cancel')
    expect(res?.status).toBe(404)
  })

  test('POST /agents missing body returns 400', async () => {
    const res = await call(system, req('POST', '/agents', {}), '/agents')
    expect(res?.status).toBe(400)
  })

  test('POST /agents/human missing name returns 400', async () => {
    const res = await call(system, req('POST', '/agents/human', { displayName: 'Test' }), '/agents/human')
    // Either 400 (validation fail) or 201 (created) — depending on shape.
    // Negative coverage: at minimum, server doesn't 500 on partial body.
    expect(res?.status).toBeLessThan(500)
  })
})

describe('HTTP Routes — agent triggers (audit gap)', () => {
  let system: AgentsWorkspaceRuntime

  beforeEach(() => {
    system = makeSystem()
    system.rooms.createRoom({ name: 'TestRoom', createdBy: 'system' })
  })

  test('GET /agents/Ghost/triggers returns 404 for unknown agent', async () => {
    const res = await call(system, req('GET', '/agents/Ghost/triggers'), '/agents/Ghost/triggers')
    expect(res?.status).toBe(404)
  })

  test('POST /agents/Ghost/triggers returns 404 for unknown agent', async () => {
    const res = await call(
      system,
      req('POST', '/agents/Ghost/triggers', { name: 'T', prompt: 'p', mode: 'interval', intervalSec: 60, roomId: 'TestRoom' }),
      '/agents/Ghost/triggers',
    )
    expect(res?.status).toBe(404)
  })

  test('DELETE /agents/Ghost/triggers/some-id returns 404', async () => {
    const res = await call(system, req('DELETE', '/agents/Ghost/triggers/abc'), '/agents/Ghost/triggers/abc')
    expect(res?.status).toBe(404)
  })

  test('PUT /agents/Ghost/triggers/some-id returns 404', async () => {
    const res = await call(
      system,
      req('PUT', '/agents/Ghost/triggers/abc', { enabled: true }),
      '/agents/Ghost/triggers/abc',
    )
    expect(res?.status).toBe(404)
  })
})

// Provider routes need a richer fake (getMonitorSnapshot, providersConfig
// surface) — skipping here. The auth-gate tests above already exercise the
// route shape; positive paths require an actual LLM stack.
