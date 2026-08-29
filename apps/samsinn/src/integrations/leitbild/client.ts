import {
  moduleBindingSchema,
  moduleDiscoverySchema,
  type ModuleBinding,
} from '@samsinn-leitbild/platform-contracts'
import type {
  LeitbildEvent,
  LeitbildEventHandler,
  LeitbildManifestSummary,
  LeitbildWorkspaceConnection,
  ScenarioSummary,
  SimulationRunSnapshot,
  SimulationRunSummary,
  SubscriptionHandle,
} from './types.ts'
import { REQUIRED_LINK_RELS } from './types.ts'

const CLIENT_HEADER = 'samsinn'
const DEFAULT_SCOPE = '__global__'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const requireRecord = (value: unknown, label: string): Record<string, unknown> => {
  if (!isRecord(value)) throw new Error(`${label} must be a JSON object`)
  return value
}

const requireString = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} must be a non-empty string`)
  return value
}

const requireNumber = (value: unknown, label: string): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${label} must be a finite number`)
  return value
}

const expandTemplate = (template: string, vars: Record<string, string | number | undefined>): string => {
  const expanded = template.replace(/\{([?]?)(\w+)\}/g, (match, prefix: string, name: string) => {
    const value = vars[name]
    if (value === undefined || value === '') {
      if (prefix === '?') return ''
      throw new Error(`Leitbild URI template requires variable "${name}": ${match}`)
    }
    const encoded = encodeURIComponent(String(value))
    return prefix === '?' ? `?${name}=${encoded}` : encoded
  })
  if (/\{[^}]+\}/.test(expanded)) throw new Error(`Unsupported Leitbild URI template: ${template}`)
  return expanded
}

const normalizeBaseUrl = (raw: string): string => {
  const url = new URL(raw)
  url.search = ''
  url.hash = ''
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/$/, '')}`
}

const parseMaxAgeMs = (cacheControl: string | null): number | null => {
  const match = cacheControl?.match(/max-age=(\d+)/)
  return match ? Number(match[1]) * 1_000 : null
}

interface ManifestCacheEntry {
  readonly manifest: LeitbildManifestSummary
  readonly etag: string | null
  readonly expiresAtMs: number
}

interface SubscriberRecord {
  readonly handler: LeitbildEventHandler
  lastSeq: number
}

interface RunSubscription {
  ws: WebSocket | null
  readonly subscribers: Set<SubscriberRecord>
  lastSeq: number
  reconnectDelayMs: number
  closed: boolean
  reconnectTimer?: ReturnType<typeof setTimeout>
}

export interface LeitbildClient {
  readonly connection: LeitbildWorkspaceConnection
  readonly getManifest: () => Promise<LeitbildManifestSummary>
  readonly provisionWorkspace: (displayName: string) => Promise<void>
  readonly listSimulationRuns: () => Promise<ReadonlyArray<SimulationRunSummary>>
  readonly createSimulationRun: (scenarioId: string) => Promise<{ readonly id: string }>
  readonly getSnapshot: (simulationRunId: string) => Promise<SimulationRunSnapshot>
  readonly getScenario: (scenarioId: string) => Promise<ScenarioSummary | undefined>
  readonly getEvents: (simulationRunId: string, afterSeq: number) => Promise<ReadonlyArray<LeitbildEvent>>
  readonly subscribe: (simulationRunId: string, onEvent: LeitbildEventHandler, startSeq: number) => SubscriptionHandle
  readonly callPackQuery: (simulationRunId: string, packId: string, kind: string, payload: Record<string, unknown>) => Promise<unknown>
  readonly callCommand: (simulationRunId: string, body: Record<string, unknown>) => Promise<unknown>
  readonly getCapabilities: (simulationRunId: string) => Promise<Record<string, unknown>>
  readonly baseUrl: string
}

export interface CreateLeitbildClientOptions {
  readonly scope?: string
}

const clientPool = new Map<string, LeitbildClient>()
const poolKey = (scope: string, baseUrl: string, workspaceId: string): string =>
  `${scope}::${baseUrl}::${workspaceId}`

const validateManifest = (raw: unknown): LeitbildManifestSummary => {
  const manifest = moduleDiscoverySchema.parse(raw)
  if (manifest.module.id !== 'leitbild') {
    throw new Error(`Expected Leitbild discovery, received module "${manifest.module.id}"`)
  }
  const missing = REQUIRED_LINK_RELS.filter(rel => !manifest.links[rel])
  if (missing.length > 0) throw new Error(`Leitbild discovery missing link rels: ${missing.join(', ')}`)
  return manifest
}

export const createLeitbildClient = (
  rawConnection: LeitbildWorkspaceConnection,
  options: CreateLeitbildClientOptions = {},
): LeitbildClient => {
  const parsedBinding = moduleBindingSchema.parse(rawConnection.moduleBinding)
  if (parsedBinding.moduleId !== 'leitbild') throw new Error('Leitbild client requires the leitbild module binding')
  const baseUrl = normalizeBaseUrl(parsedBinding.baseUrl)
  const connection: LeitbildWorkspaceConnection = {
    moduleBinding: { ...parsedBinding, baseUrl },
    workspaceId: rawConnection.workspaceId,
  }
  const scope = options.scope ?? DEFAULT_SCOPE
  const key = poolKey(scope, baseUrl, connection.workspaceId)
  const cached = clientPool.get(key)
  if (cached) return cached

  let manifestCache: ManifestCacheEntry | null = null
  const runSubscriptions = new Map<string, RunSubscription>()

  const defaultHeaders = (): Record<string, string> => ({
    'Leitbild-Client': CLIENT_HEADER,
    Accept: 'application/json',
  })

  const fetchManifest = async (): Promise<LeitbildManifestSummary> => {
    const now = Date.now()
    if (manifestCache && manifestCache.expiresAtMs > now) return manifestCache.manifest
    const headers = defaultHeaders()
    if (manifestCache?.etag) headers['If-None-Match'] = manifestCache.etag
    const response = await fetch(parsedBinding.discoveryUrl, { headers })
    if (response.status === 304 && manifestCache) {
      const ttl = parseMaxAgeMs(response.headers.get('Cache-Control')) ?? 60_000
      manifestCache = { ...manifestCache, expiresAtMs: Date.now() + ttl }
      return manifestCache.manifest
    }
    if (!response.ok) throw new Error(`Leitbild discovery fetch failed: ${response.status} ${response.statusText}`)
    const manifest = validateManifest(await response.json())
    const ttl = parseMaxAgeMs(response.headers.get('Cache-Control')) ?? 60_000
    manifestCache = { manifest, etag: response.headers.get('ETag'), expiresAtMs: Date.now() + ttl }
    return manifest
  }

  const resolveLink = async (
    rel: string,
    vars: Record<string, string | number | undefined> = {},
  ): Promise<string> => {
    const manifest = await fetchManifest()
    const template = manifest.links[rel]
    if (!template) throw new Error(`Leitbild discovery missing link rel: ${rel}`)
    return expandTemplate(template, { workspaceId: connection.workspaceId, ...vars })
  }

  const postJson = (url: string, body: Record<string, unknown>): Promise<Response> => fetch(url, {
    method: 'POST',
    headers: { ...defaultHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

  const provisionWorkspace = async (displayName: string): Promise<void> => {
    const url = await resolveLink('workspace')
    const response = await fetch(url, {
      method: 'PUT',
      headers: { ...defaultHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName }),
    })
    if (!response.ok) throw new Error(`Leitbild Workspace provision failed: HTTP ${response.status}`)
    const body = requireRecord(await response.json(), 'Leitbild Workspace response')
    const workspace = requireRecord(body.workspace, 'Leitbild Workspace response.workspace')
    if (workspace.id !== connection.workspaceId) throw new Error('Leitbild provisioned a different Workspace id')
  }

  const listSimulationRuns = async (): Promise<ReadonlyArray<SimulationRunSummary>> => {
    const response = await fetch(await resolveLink('simulationRuns'), { headers: defaultHeaders() })
    if (!response.ok) throw new Error(`Leitbild Simulation Run list failed: HTTP ${response.status}`)
    const body = requireRecord(await response.json(), 'Leitbild Simulation Run list')
    if (!Array.isArray(body.simulationRuns)) throw new Error('Leitbild Simulation Run list must contain simulationRuns[]')
    return body.simulationRuns.map((raw, index) => {
      const run = requireRecord(raw, `simulationRuns[${index}]`)
      return {
        id: requireString(run.id, `simulationRuns[${index}].id`),
        scenarioId: run.scenarioId === null ? null : requireString(run.scenarioId, `simulationRuns[${index}].scenarioId`),
        scenarioRevisionId: run.scenarioRevisionId === null ? null : requireString(run.scenarioRevisionId, `simulationRuns[${index}].scenarioRevisionId`),
        createdAt: run.createdAt === null ? null : requireString(run.createdAt, `simulationRuns[${index}].createdAt`),
        loaded: run.loaded === true,
        snapshotSeq: run.snapshotSeq === null ? null : requireNumber(run.snapshotSeq, `simulationRuns[${index}].snapshotSeq`),
        objectCount: run.objectCount === null ? null : requireNumber(run.objectCount, `simulationRuns[${index}].objectCount`),
        ...(typeof run.loadError === 'string' ? { loadError: run.loadError } : {}),
        websocketClientCount: requireNumber(run.websocketClientCount, `simulationRuns[${index}].websocketClientCount`),
      }
    })
  }

  const createSimulationRun = async (scenarioId: string): Promise<{ readonly id: string }> => {
    const response = await postJson(await resolveLink('simulationRuns'), { scenarioId })
    if (!response.ok) throw new Error(`Leitbild Simulation Run create failed: HTTP ${response.status}`)
    const body = requireRecord(await response.json(), 'Leitbild Simulation Run create response')
    return { id: requireString(body.id, 'Leitbild Simulation Run create response.id') }
  }

  const getSnapshot = async (simulationRunId: string): Promise<SimulationRunSnapshot> => {
    const response = await fetch(await resolveLink('simulationRunSnapshot', { simulationRunId }), { headers: defaultHeaders() })
    if (!response.ok) throw new Error(`Leitbild snapshot fetch failed for ${simulationRunId}: HTTP ${response.status}`)
    const body = requireRecord(await response.json(), 'Leitbild snapshot response')
    if (body.id !== simulationRunId) throw new Error('Leitbild snapshot response has the wrong Simulation Run id')
    const snapshot = requireRecord(body.snapshot, 'Leitbild snapshot response.snapshot')
    const seq = requireNumber(snapshot.seq, 'Leitbild snapshot response.snapshot.seq')
    const scenario = snapshot.scenario === undefined ? undefined : requireRecord(snapshot.scenario, 'snapshot.scenario')
    const scenarioId = scenario === undefined || scenario.scenarioId === undefined
      ? undefined
      : requireString(scenario.scenarioId, 'snapshot.scenario.scenarioId')
    return { ...snapshot, seq, ...(scenarioId === undefined ? {} : { scenarioId }) } as SimulationRunSnapshot
  }

  const getScenario = async (scenarioId: string): Promise<ScenarioSummary | undefined> => {
    const response = await fetch(await resolveLink('scenario', { scenarioId }), { headers: defaultHeaders() })
    if (response.status === 404) return undefined
    if (!response.ok) throw new Error(`Leitbild Scenario fetch failed: HTTP ${response.status}`)
    const body = requireRecord(await response.json(), 'Leitbild Scenario response')
    const scenario = requireRecord(body.scenario, 'Leitbild Scenario response.scenario')
    if (scenario.id !== scenarioId) throw new Error('Leitbild Scenario response has the wrong Scenario id')
    return scenario as ScenarioSummary
  }

  const parseEvents = (raw: unknown): ReadonlyArray<LeitbildEvent> => {
    const body = requireRecord(raw, 'Leitbild events response')
    if (!Array.isArray(body.events)) throw new Error('Leitbild events response must contain events[]')
    return body.events.map((rawEvent, index) => {
      const event = requireRecord(rawEvent, `events[${index}]`)
      return {
        ...event,
        seq: requireNumber(event.seq, `events[${index}].seq`),
        type: requireString(event.type, `events[${index}].type`),
      } as LeitbildEvent
    })
  }

  const getEvents = async (simulationRunId: string, afterSeq: number): Promise<ReadonlyArray<LeitbildEvent>> => {
    const response = await fetch(await resolveLink('simulationRunEvents', { simulationRunId, afterSeq }), { headers: defaultHeaders() })
    if (!response.ok) throw new Error(`Leitbild events fetch failed for ${simulationRunId}: HTTP ${response.status}`)
    return parseEvents(await response.json())
  }

  const callPackQuery = async (simulationRunId: string, packId: string, kind: string, payload: Record<string, unknown>): Promise<unknown> => {
    const response = await postJson(await resolveLink('simulationRunPackQueries', { simulationRunId }), { packId, kind, payload })
    if (!response.ok) throw new Error(`Leitbild pack query failed: HTTP ${response.status}`)
    return response.json()
  }

  const callCommand = async (simulationRunId: string, body: Record<string, unknown>): Promise<unknown> => {
    const response = await postJson(await resolveLink('simulationRunCommands', { simulationRunId }), body)
    if (!response.ok) {
      const errorBody = await response.text().catch(() => '')
      throw new Error(`Leitbild command failed: HTTP ${response.status}${errorBody ? `: ${errorBody}` : ''}`)
    }
    return response.json()
  }

  const getCapabilities = async (simulationRunId: string): Promise<Record<string, unknown>> => {
    const response = await fetch(await resolveLink('simulationRunCapabilities', { simulationRunId }), { headers: defaultHeaders() })
    if (!response.ok) throw new Error(`Leitbild capabilities fetch failed: HTTP ${response.status}`)
    return requireRecord(await response.json(), 'Leitbild capabilities response')
  }

  const scheduleReconnect = (simulationRunId: string, subscription: RunSubscription): void => {
    if (subscription.closed || subscription.subscribers.size === 0) return
    const delay = subscription.reconnectDelayMs
    subscription.reconnectDelayMs = Math.min(subscription.reconnectDelayMs * 2, 30_000)
    subscription.reconnectTimer = setTimeout(async () => {
      try {
        const events = await getEvents(simulationRunId, subscription.lastSeq)
        for (const event of events) {
          if (event.seq <= subscription.lastSeq) continue
          subscription.lastSeq = event.seq
          for (const record of subscription.subscribers) {
            if (event.seq <= record.lastSeq) continue
            record.lastSeq = event.seq
            try { record.handler(event) } catch { /* isolate subscribers */ }
          }
        }
        await openWebSocket(simulationRunId, subscription)
        subscription.reconnectDelayMs = 1_000
      } catch {
        scheduleReconnect(simulationRunId, subscription)
      }
    }, delay)
  }

  const openWebSocket = async (simulationRunId: string, subscription: RunSubscription): Promise<void> => {
    const socket = new WebSocket(await resolveLink('realtime', { simulationRunId }))
    subscription.ws = socket
    socket.addEventListener('message', (message: MessageEvent) => {
      try {
        const raw = requireRecord(JSON.parse(typeof message.data === 'string' ? message.data : String(message.data)), 'Leitbild realtime message')
        if (raw.workspaceId !== connection.workspaceId || raw.simulationRunId !== simulationRunId) return
        if (raw.type === 'realtime.ready') return
        if (raw.type !== 'events' || !Array.isArray(raw.events)) return
        for (const event of parseEvents({ events: raw.events })) {
          if (event.seq < subscription.lastSeq && subscription.lastSeq > 0) {
            subscription.lastSeq = 0
            for (const record of subscription.subscribers) record.lastSeq = 0
          }
          if (event.seq <= subscription.lastSeq) continue
          subscription.lastSeq = event.seq
          for (const record of subscription.subscribers) {
            if (event.seq <= record.lastSeq) continue
            record.lastSeq = event.seq
            try { record.handler(event) } catch { /* isolate subscribers */ }
          }
        }
      } catch { /* malformed realtime messages are ignored */ }
    })
    socket.addEventListener('close', () => scheduleReconnect(simulationRunId, subscription))
    socket.addEventListener('error', () => { try { socket.close() } catch { /* already closed */ } })
  }

  const subscribe = (simulationRunId: string, onEvent: LeitbildEventHandler, startSeq: number): SubscriptionHandle => {
    let subscription = runSubscriptions.get(simulationRunId)
    if (!subscription) {
      subscription = {
        ws: null,
        subscribers: new Set(),
        lastSeq: startSeq,
        reconnectDelayMs: 1_000,
        closed: false,
      }
      runSubscriptions.set(simulationRunId, subscription)
      void openWebSocket(simulationRunId, subscription)
    }
    const record: SubscriberRecord = { handler: onEvent, lastSeq: startSeq }
    subscription.subscribers.add(record)
    return {
      close: () => {
        const current = runSubscriptions.get(simulationRunId)
        if (!current) return
        current.subscribers.delete(record)
        if (current.subscribers.size > 0) return
        current.closed = true
        if (current.reconnectTimer) clearTimeout(current.reconnectTimer)
        try { current.ws?.close() } catch { /* already closed */ }
        runSubscriptions.delete(simulationRunId)
      },
      lastSeq: () => record.lastSeq,
    }
  }

  const client: LeitbildClient = {
    connection,
    getManifest: fetchManifest,
    provisionWorkspace,
    listSimulationRuns,
    createSimulationRun,
    getSnapshot,
    getScenario,
    getEvents,
    subscribe,
    callPackQuery,
    callCommand,
    getCapabilities,
    baseUrl,
  }
  clientPool.set(key, client)
  return client
}

export const createLeitbildModuleBinding = (baseUrlRaw: string): ModuleBinding => {
  const baseUrl = normalizeBaseUrl(baseUrlRaw)
  return moduleBindingSchema.parse({
    moduleId: 'leitbild',
    baseUrl,
    discoveryUrl: `${baseUrl}/.well-known/leitbild`,
  })
}

export const __resetClientPool = (): void => { clientPool.clear() }

export const __injectClient = (
  connection: LeitbildWorkspaceConnection,
  client: LeitbildClient,
  scope: string = DEFAULT_SCOPE,
): void => {
  const binding = moduleBindingSchema.parse(connection.moduleBinding)
  clientPool.set(poolKey(scope, normalizeBaseUrl(binding.baseUrl), connection.workspaceId), client)
}
