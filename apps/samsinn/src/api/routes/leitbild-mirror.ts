// ============================================================================
// Routes for the Leitbild mirror binding on a Samsinn room.
//
// Read-only mirror — bind a Room to a Leitbild Simulation Run.
// Three endpoints:
//   PUT    /rooms/:name/leitbild-mirror   set/replace config + attach
//   DELETE /rooms/:name/leitbild-mirror   clear + detach
//   GET    /rooms/:name/leitbild-mirror   introspect current state
// ============================================================================

import { errorResponse, json, parseBody } from './helpers.ts'
import type { RouteEntry } from './types.ts'
import type { LeitbildMirrorConfig } from '../../core/types/room.ts'
import { createLeitbildClient } from '../../integrations/leitbild/client.ts'
import type { SimulationRunSummary } from '../../integrations/leitbild/types.ts'
import type { LeitbildWorkspaceConnection } from '../../integrations/leitbild/types.ts'
import type { WorkspaceId } from '@samsinn-leitbild/platform-contracts'

const parseMirrorConfig = (body: Record<string, unknown>): LeitbildMirrorConfig | { error: string } => {
  const allowedKeys = new Set(['simulationRunId', 'format'])
  const unexpected = Object.keys(body).filter(key => !allowedKeys.has(key))
  if (unexpected.length > 0) return { error: `unexpected fields: ${unexpected.join(', ')}` }
  if (typeof body.simulationRunId !== 'string' || body.simulationRunId.trim() === '') return { error: 'simulationRunId is required' }
  const format = body.format ?? 'summary'
  if (format !== 'summary' && format !== 'full') return { error: 'format must be "summary" or "full"' }
  return { simulationRunId: body.simulationRunId, format }
}

const connectionFor = (
  system: { readonly settings: { readonly getModuleBinding: (moduleId: string) => import('@samsinn-leitbild/platform-contracts').ModuleBinding | undefined } },
  workspaceId: WorkspaceId,
): LeitbildWorkspaceConnection | undefined => {
  const moduleBinding = system.settings.getModuleBinding('leitbild')
  return moduleBinding ? { moduleBinding, workspaceId } : undefined
}

const workspaceDisplayName = async (
  workspaces: import('./types.ts').WorkspaceAdmin | undefined,
  workspaceId: WorkspaceId,
): Promise<string> =>
  (await workspaces?.list())?.find(workspace => workspace.id === workspaceId)?.displayName ?? 'Samsinn Workspace'

// Server-side proxy for creating Leitbild Simulation Runs from the
// Samsinn UI without requiring browser cross-origin access. The demo
// modal can select a fresh Simulation Run server-to-server. The Leitbild
// origin is taken only from the Workspace's Module Binding; requests cannot
// supply or override transport topology at Room or action scope.

const parseStringArray = (raw: unknown): ReadonlyArray<string> =>
  Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string' && v.trim() !== '').map(v => v.trim()) : []

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const rejectUnexpected = (body: Record<string, unknown>, allowed: ReadonlySet<string>): Response | undefined => {
  const unexpected = Object.keys(body).filter(key => !allowed.has(key))
  return unexpected.length > 0
    ? errorResponse(`unexpected fields: ${unexpected.join(', ')}`, 400)
    : undefined
}

const simulationRunRecency = (run: SimulationRunSummary): number => {
  if (typeof run.snapshotSeq === 'number') return run.snapshotSeq
  const created = typeof run.createdAt === 'string' ? Date.parse(run.createdAt) : Number.NaN
  return Number.isFinite(created) ? created : 0
}

const sortSimulationRuns = (
  simulationRuns: ReadonlyArray<SimulationRunSummary>,
  scenarioIds: ReadonlyArray<string>,
): ReadonlyArray<SimulationRunSummary> => {
  const scenarioRank = new Map(scenarioIds.map((id, idx) => [id, idx]))
  return [...simulationRuns].sort((a, b) => {
    const aScenario = typeof a.scenarioId === 'string' ? scenarioRank.get(a.scenarioId) ?? scenarioIds.length : scenarioIds.length
    const bScenario = typeof b.scenarioId === 'string' ? scenarioRank.get(b.scenarioId) ?? scenarioIds.length : scenarioIds.length
    if (aScenario !== bScenario) return aScenario - bScenario
    const aLoaded = a.loaded === true ? 1 : 0
    const bLoaded = b.loaded === true ? 1 : 0
    if (aLoaded !== bLoaded) return bLoaded - aLoaded
    return simulationRunRecency(b) - simulationRunRecency(a)
  })
}

const getQueryKinds = (capabilities: Record<string, unknown>, packId: string): ReadonlyArray<string> => {
  const queryKinds = capabilities.queryKinds
  if (!isRecord(queryKinds)) return []
  const kinds = queryKinds[packId]
  return Array.isArray(kinds) ? kinds.filter((v): v is string => typeof v === 'string') : []
}

const queryKindMatches = (actual: string, required: string): boolean =>
  actual === required || actual.endsWith(`.${required}`) || required.endsWith(`.${actual}`)

const unwrapPackQueryResult = (raw: unknown): unknown => {
  if (!isRecord(raw)) return raw
  if (isRecord(raw.response)) return unwrapPackQueryResult(raw.response)
  if (isRecord(raw.result)) return raw.result
  return raw
}

const extractSystemIds = (raw: unknown): ReadonlyArray<string> => {
  const body = unwrapPackQueryResult(raw)
  const systemsRaw = Array.isArray(body)
    ? body
    : isRecord(body) && Array.isArray(body.systems)
      ? body.systems
      : []
  return systemsRaw
    .map((system): string | undefined => {
      if (typeof system === 'string') return system
      if (!isRecord(system)) return undefined
      if (typeof system.id === 'string') return system.id
      if (typeof system.systemId === 'string') return system.systemId
      return undefined
    })
    .filter((id): id is string => typeof id === 'string' && id.length > 0)
}

interface ProcessPlantProbe {
  readonly ok: true
  readonly systemIds: ReadonlyArray<string>
}

interface ProcessPlantProbeFail {
  readonly ok: false
  readonly reason: string
}

const probeProcessPlantRun = async (
  client: ReturnType<typeof createLeitbildClient>,
  simulationRunId: string,
  packId: string,
  queryKind: string,
  payload: Record<string, unknown>,
): Promise<ProcessPlantProbe | ProcessPlantProbeFail> => {
  const capabilities = await client.getCapabilities(simulationRunId)
  const activePacks = Array.isArray(capabilities.activePackIds)
    ? capabilities.activePackIds.filter((v): v is string => typeof v === 'string')
    : []
  if (!activePacks.includes(packId)) return { ok: false, reason: `missing active pack "${packId}"` }
  const kinds = getQueryKinds(capabilities, packId)
  if (!kinds.some(k => queryKindMatches(k, queryKind))) return { ok: false, reason: `missing query kind "${queryKind}"` }
  const result = await client.callPackQuery(simulationRunId, packId, queryKind, payload)
  const systemIds = extractSystemIds(result)
  if (systemIds.length === 0) return { ok: false, reason: 'systems.list returned no process systems' }
  return { ok: true, systemIds }
}

const proxyCreateSimulationRun: RouteEntry = {
  method: 'POST',
  pattern: /^\/leitbild-proxy\/simulation-runs$/,
  handler: async (req, _match, { system, workspaceId, workspaces }) => {
    const body = await parseBody(req)
    const unexpected = rejectUnexpected(body, new Set(['scenarioId']))
    if (unexpected) return unexpected
    if (typeof body.scenarioId !== 'string') return errorResponse('scenarioId is required', 400)
    const connection = connectionFor(system, workspaceId)
    if (!connection) return errorResponse('Leitbild is not connected to this Workspace', 409)
    try {
      const client = createLeitbildClient(connection, { scope: workspaceId })
      await client.getManifest()
      await client.provisionWorkspace(await workspaceDisplayName(workspaces, workspaceId))
      const data = await client.createSimulationRun(body.scenarioId)
      return json({ simulationRunId: data.id })
    } catch (err) {
      return errorResponse(`Could not reach Leitbild: ${(err as Error).message}`, 502)
    }
  },
}

const proxySelectSimulationRun: RouteEntry = {
  method: 'POST',
  pattern: /^\/leitbild-proxy\/simulation-runs\/select$/,
  handler: async (req, _match, { system, workspaceId, workspaces }) => {
    const body = await parseBody(req)
    const unexpected = rejectUnexpected(body, new Set([
      'preferredScenarioId',
      'candidateScenarioIds',
      'requiredPackId',
      'requiredQueryKind',
      'probePayload',
    ]))
    if (unexpected) return unexpected
    const connection = connectionFor(system, workspaceId)
    if (!connection) return errorResponse('Leitbild is not connected to this Workspace', 409)

    const preferredScenarioId = typeof body.preferredScenarioId === 'string' && body.preferredScenarioId.trim() !== ''
      ? body.preferredScenarioId.trim()
      : 'halden-process-plant-demo'
    const candidateScenarioIds = [
      preferredScenarioId,
      ...parseStringArray(body.candidateScenarioIds).filter(id => id !== preferredScenarioId),
    ]
    const requiredPackId = typeof body.requiredPackId === 'string' && body.requiredPackId.trim() !== ''
      ? body.requiredPackId.trim()
      : 'process-plant'
    const requiredQueryKind = typeof body.requiredQueryKind === 'string' && body.requiredQueryKind.trim() !== ''
      ? body.requiredQueryKind.trim()
      : 'process-plant.systems.list'
    const probePayload = isRecord(body.probePayload) ? body.probePayload : {}
    const client = createLeitbildClient(connection, { scope: workspaceId })
    const failures: string[] = []

    try {
      await client.getManifest()
      await client.provisionWorkspace(await workspaceDisplayName(workspaces, workspaceId))
      const simulationRuns = await client.listSimulationRuns()
      const candidates = sortSimulationRuns(
        simulationRuns.filter(run => typeof run.id === 'string' && candidateScenarioIds.includes(run.scenarioId ?? '')),
        candidateScenarioIds,
      )
      for (const candidate of candidates) {
        try {
          const probe = await probeProcessPlantRun(client, candidate.id, requiredPackId, requiredQueryKind, probePayload)
          if (probe.ok) {
            return json({
              simulationRunId: candidate.id,
              scenarioId: candidate.scenarioId,
              created: false,
              reused: true,
              systemIds: probe.systemIds,
            })
          }
          failures.push(`${candidate.id}: ${probe.reason}`)
        } catch (err) {
          failures.push(`${candidate.id}: ${(err as Error).message}`)
        }
      }

      const created = await client.createSimulationRun(preferredScenarioId)
      const probe = await probeProcessPlantRun(client, created.id, requiredPackId, requiredQueryKind, probePayload)
      if (!probe.ok) {
        failures.push(`${created.id}: ${probe.reason}`)
        return errorResponse(`Created Leitbild Simulation Run but it is not ${requiredPackId}-ready: ${probe.reason}`, 502)
      }
      return json({
        simulationRunId: created.id,
        scenarioId: preferredScenarioId,
        created: true,
        reused: false,
        systemIds: probe.systemIds,
        ...(failures.length > 0 ? { skippedCandidates: failures } : {}),
      })
    } catch (err) {
      const skipped = failures.length > 0 ? `; skipped candidates: ${failures.join('; ')}` : ''
      return errorResponse(`Could not select Leitbild simulation run: ${(err as Error).message}${skipped}`, 502)
    }
  },
}

export const leitbildMirrorRoutes: RouteEntry[] = [
  proxyCreateSimulationRun,
  proxySelectSimulationRun,
  {
    method: 'GET',
    pattern: /^\/rooms\/([^/]+)\/leitbild-mirror$/,
    handler: async (_req, match, { system, leitbildMirror, workspaceId }) => {
      const name = decodeURIComponent(match[1]!)
      const room = system.rooms.getRoom(name)
      if (!room) return errorResponse(`Room "${name}" not found`, 404)
      // Lazy self-heal: if room has persisted config but service has no
      // record (Samsinn was restarted), reattach silently. Idempotent —
      // attach() detaches any prior mirror first.
      const persisted = room.getLeitbildMirror()
      const connection = connectionFor(system, workspaceId)
      const status = leitbildMirror?.statusFor(room, connection)
      if (persisted && leitbildMirror && (!status || !status.connected)) {
        if (!connection) return errorResponse('Leitbild is not connected to this Workspace', 409)
        try { await leitbildMirror.attach(room, connection, persisted, workspaceId) } catch {
          // attach() catches its own error and posts a formatMirrorError chat
          // message into the room — the user sees the failure inline. We
          // don't re-throw because this is a lazy self-heal; the GET still
          // returns the current status with connected:false. If attach()
          // ever throws BEFORE its own room.post (e.g. snapshot fetch throws
          // synchronously), the user gets no signal — flagged in audit
          // Finding 2.2.4 for a follow-up that surfaces lastAttachError.
        }
      }
      return json({ status: leitbildMirror?.statusFor(room, connection) ?? null })
    },
  },
  {
    method: 'PUT',
    pattern: /^\/rooms\/([^/]+)\/leitbild-mirror$/,
    handler: async (req, match, { system, leitbildMirror, workspaceId }) => {
      if (!leitbildMirror) return errorResponse('Leitbild integration not initialized', 503)
      const name = decodeURIComponent(match[1]!)
      const room = system.rooms.getRoom(name)
      if (!room) return errorResponse(`Room "${name}" not found`, 404)
      const body = await parseBody(req)
      const parsed = parseMirrorConfig(body)
      if ('error' in parsed) return errorResponse(parsed.error, 400)
      const connection = connectionFor(system, workspaceId)
      if (!connection) return errorResponse('Leitbild is not connected to this Workspace', 409)
      try {
        // Pass workspaceId as scope so this tenant's LeitbildClient pool
        // is isolated from other tenants binding to the same baseUrl.
        await leitbildMirror.attach(room, connection, parsed, workspaceId)
        return json({ status: leitbildMirror.statusFor(room, connection) ?? null }, 200)
      } catch (err) {
        return errorResponse(`attach failed: ${(err as Error).message}`, 502)
      }
    },
  },
  {
    method: 'DELETE',
    pattern: /^\/rooms\/([^/]+)\/leitbild-mirror$/,
    handler: (_req, match, { system, leitbildMirror }) => {
      const name = decodeURIComponent(match[1]!)
      const room = system.rooms.getRoom(name)
      if (!room) return errorResponse(`Room "${name}" not found`, 404)
      leitbildMirror?.detach(room)
      return json({ status: null })
    },
  },
]
