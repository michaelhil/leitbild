import { z } from 'zod'
import { actorIdSchema, clientIdSchema, commandEnvelopeSchema, simulationRunIdSchema, interactionEndpointSchema, interactionSignalSchema, nowIso, objectIdSchema, procedureIdSchema, procedureSourceIdSchema, simulationClockUpdateSchema, type CommandEnvelope, type SimulationRunId, type InteractionSignal, type ScenarioDefinition } from '../model/index.ts'
import type { Actor } from '../simulation-runs/actors.ts'
import type { PackQueryRequest } from '../packs/protocol.ts'
import type { SimulationRunRegistry } from '../simulation-runs/registry.ts'
import type { SimulationRunRuntime } from '../simulation-runs/runtime.ts'
import { apiError, json, readJson } from './responses.ts'
import {
  commandIdempotencyConfigFromEnv,
  commandIdempotencyStoreForRuntime,
  issueCommandWithIdempotency,
} from './command-idempotency.ts'
import type { AccessContext } from '@leitbild/contracts'

const defaultOperatorActorId = actorIdSchema.parse('actor:operator')

export interface SimulationRunRouteConfig {
  readonly registry: SimulationRunRegistry
  readonly accessContext: AccessContext
  readonly websocketClients?: ReadonlyArray<{
    readonly id: SimulationRunId
    readonly websocketClientCount: number
  }>
}

const commandRequestSchema = z.object({
  actorId: actorIdSchema.optional(),
  clientId: clientIdSchema.optional(),
  idempotencyKey: z.string().min(1).max(256).optional(),
  kind: z.string().min(1),
  targetObjectIds: z.array(objectIdSchema),
  payload: z.unknown(),
  expectedRevision: z.number().int().nonnegative().optional(),
})

const signalRequestSchema = z.object({
  actorId: actorIdSchema.optional(),
  clientId: clientIdSchema.optional(),
  source: interactionEndpointSchema.optional(),
  type: z.string().min(1),
  targetObjectIds: z.array(objectIdSchema).optional(),
  targets: z.array(interactionEndpointSchema).optional(),
  payload: z.unknown(),
  severity: z.enum(['info', 'notice', 'warning', 'critical']).optional(),
  correlationId: z.string().min(1).optional(),
  causationId: z.string().min(1).optional(),
  ttlMs: z.number().finite().positive().optional(),
})

const packQueryRequestSchema = z.object({
  packId: z.string().min(1),
  kind: z.string().min(1),
  payload: z.unknown(),
})

export const buildSimulationRunActor = (actorId: Actor['id']): Actor => ({
  id: actorId,
  label: actorId,
  role: 'operator',
})

export const actorIdForAccessContext = (accessContext: AccessContext): Actor['id'] =>
  accessContext.actor.id === undefined
    ? defaultOperatorActorId
    : actorIdSchema.parse(`actor:${accessContext.actor.kind}:${accessContext.actor.id}`)

export const buildSimulationRunCommand = (
  simulationRunId: SimulationRunId,
  raw: unknown,
  defaultActorId: Actor['id'] = defaultOperatorActorId,
): CommandEnvelope => {
  const parsed = commandRequestSchema.parse(raw)
  const candidate = {
    id: `command:${crypto.randomUUID()}`,
    simulationRunId,
    actorId: parsed.actorId ?? defaultActorId,
    ...(parsed.clientId === undefined ? {} : { clientId: parsed.clientId }),
    ...(parsed.idempotencyKey === undefined ? {} : { idempotencyKey: parsed.idempotencyKey }),
    kind: parsed.kind,
    targetObjectIds: parsed.targetObjectIds,
    payload: parsed.payload,
    issuedAt: nowIso(),
    ...(parsed.expectedRevision === undefined ? {} : { expectedRevision: parsed.expectedRevision }),
  }
  return commandEnvelopeSchema.parse(candidate) as CommandEnvelope
}

const buildSignal = (simulationRunId: SimulationRunId, raw: unknown, defaultActorId: Actor['id']): {
  readonly signal: InteractionSignal
  readonly actor: Actor
} => {
  const parsed = signalRequestSchema.parse(raw)
  const actorId = parsed.actorId ?? defaultActorId
  const targets = parsed.targets ?? parsed.targetObjectIds?.map(objectId => ({ kind: 'object' as const, id: objectId })) ?? []
  const signal = interactionSignalSchema.parse({
    id: `signal:${crypto.randomUUID()}`,
    simulationRunId,
    at: nowIso(),
    source: parsed.source ?? (parsed.clientId
      ? { kind: 'client', id: parsed.clientId }
      : { kind: 'actor', id: actorId }),
    targets,
    type: parsed.type,
    payload: parsed.payload,
    ...(parsed.severity === undefined ? {} : { severity: parsed.severity }),
    ...(parsed.correlationId === undefined ? {} : { correlationId: parsed.correlationId }),
    ...(parsed.causationId === undefined ? {} : { causationId: parsed.causationId }),
    ...(parsed.ttlMs === undefined ? {} : { ttlMs: parsed.ttlMs }),
  }) as InteractionSignal
  return { signal, actor: buildSimulationRunActor(actorId) }
}

const buildPackQuery = (raw: unknown): PackQueryRequest => {
  const parsed = packQueryRequestSchema.parse(raw)
  return {
    packId: parsed.packId,
    kind: parsed.kind,
    payload: parsed.payload,
  }
}

const simulationRunResponse = async (
  registry: SimulationRunRegistry,
  runtime: SimulationRunRuntime,
): Promise<{
  readonly id: typeof runtime.id
  readonly snapshot: ReturnType<SimulationRunRuntime['snapshot']>
  readonly scenarioRevisionId?: string
  readonly scenario?: ScenarioDefinition
}> => {
  const snapshot = runtime.snapshot()
  const revision = await registry.scenarioRevisionForRun(runtime.id)
  return {
    id: runtime.id,
    snapshot,
    ...(revision === undefined ? {} : {
      scenarioRevisionId: revision.id,
      scenario: revision.definition,
    }),
  }
}

const handleSimulationRunApiInner = async (
  req: Request,
  url: URL,
  config: SimulationRunRouteConfig,
): Promise<Response | null> => {
  if (config.accessContext.workspaceId !== config.registry.workspaceId) {
    throw new Error(`Workspace context mismatch: expected ${config.registry.workspaceId}, got ${config.accessContext.workspaceId}`)
  }
  const apiPrefix = `/api/workspaces/${encodeURIComponent(config.registry.workspaceId)}/world`
  if (!url.pathname.startsWith(`${apiPrefix}/`)) return null
  const pathname = url.pathname.slice(apiPrefix.length)

  const scenarioMatch = pathname.match(/^\/scenarios\/([^/]+)$/)
  if (scenarioMatch && req.method === 'GET') {
    const scenarioId = decodeURIComponent(scenarioMatch[1] ?? '')
    const revision = await config.registry.currentScenario(scenarioId)
    if (!revision) return apiError(404, 'scenario_not_found', 'scenario not found')
    return json({ scenario: revision.definition, revisionId: revision.id, digest: revision.digest })
  }

  const simulationRunMatch = pathname.match(/^\/simulation-runs\/([^/]+)$/)
  if (simulationRunMatch && req.method === 'GET') {
    const simulationRunId = simulationRunIdSchema.parse(decodeURIComponent(simulationRunMatch[1] ?? ''))
    let runtime: SimulationRunRuntime
    try {
      runtime = await config.registry.load(simulationRunId)
    } catch (err) {
      if ((err as Error).message.startsWith('Simulation Run not found:')) {
        return apiError(404, 'simulation_run_not_found', 'simulation run not found')
      }
      throw err
    }
    return json(await simulationRunResponse(config.registry, runtime))
  }

  if (simulationRunMatch && req.method === 'DELETE') {
    const simulationRunId = simulationRunIdSchema.parse(decodeURIComponent(simulationRunMatch[1] ?? ''))
    const websocketClientCount = config.websocketClients?.find(item => item.id === simulationRunId)?.websocketClientCount ?? 0
    if (websocketClientCount > 0) {
      return apiError(409, 'simulation_run_has_users', 'simulation run has connected users')
    }
    const deleted = await config.registry.delete(simulationRunId)
    if (!deleted) return apiError(404, 'simulation_run_not_found', 'simulation run not found')
    return json({ id: simulationRunId, deleted: true })
  }

  const snapshotMatch = pathname.match(/^\/simulation-runs\/([^/]+)\/snapshot$/)
  if (snapshotMatch && req.method === 'GET') {
    const simulationRunId = simulationRunIdSchema.parse(decodeURIComponent(snapshotMatch[1] ?? ''))
    const runtime = config.registry.get(simulationRunId)
    if (!runtime) return apiError(404, 'simulation_run_not_found', 'simulation run not found')
    return json(await simulationRunResponse(config.registry, runtime))
  }

  const capabilitiesMatch = pathname.match(/^\/simulation-runs\/([^/]+)\/capabilities$/)
  if (capabilitiesMatch && req.method === 'GET') {
    const simulationRunId = simulationRunIdSchema.parse(decodeURIComponent(capabilitiesMatch[1] ?? ''))
    const runtime = config.registry.get(simulationRunId)
    if (!runtime) return apiError(404, 'simulation_run_not_found', 'simulation run not found')
    return json(runtime.capabilities())
  }

  const resetMatch = pathname.match(/^\/simulation-runs\/([^/]+)\/reset$/)
  if (resetMatch && req.method === 'POST') {
    const simulationRunId = simulationRunIdSchema.parse(decodeURIComponent(resetMatch[1] ?? ''))
    const runtime = await config.registry.reset(simulationRunId)
    return json(await simulationRunResponse(config.registry, runtime))
  }

  const objectsMatch = pathname.match(/^\/simulation-runs\/([^/]+)\/objects$/)
  if (objectsMatch && req.method === 'GET') {
    const simulationRunId = simulationRunIdSchema.parse(decodeURIComponent(objectsMatch[1] ?? ''))
    const runtime = config.registry.get(simulationRunId)
    if (!runtime) return apiError(404, 'simulation_run_not_found', 'simulation run not found')
    return json({ objects: runtime.snapshot().objects })
  }

  const objectMatch = pathname.match(/^\/simulation-runs\/([^/]+)\/objects\/([^/]+)$/)
  if (objectMatch && req.method === 'GET') {
    const simulationRunId = simulationRunIdSchema.parse(decodeURIComponent(objectMatch[1] ?? ''))
    const objectId = objectIdSchema.parse(decodeURIComponent(objectMatch[2] ?? ''))
    const runtime = config.registry.get(simulationRunId)
    if (!runtime) return apiError(404, 'simulation_run_not_found', 'simulation run not found')
    const object = runtime.snapshot().objects.find(candidate => candidate.id === objectId)
    if (!object) return apiError(404, 'object_not_found', 'object not found')
    return json({ object })
  }

  const eventsMatch = pathname.match(/^\/simulation-runs\/([^/]+)\/events$/)
  if (eventsMatch && req.method === 'GET') {
    const simulationRunId = simulationRunIdSchema.parse(decodeURIComponent(eventsMatch[1] ?? ''))
    const afterSeqParam = url.searchParams.get('afterSeq')
    const afterSeq = afterSeqParam === null ? undefined : z.coerce.number().int().nonnegative().parse(afterSeqParam)
    const runtime = config.registry.get(simulationRunId)
    if (!runtime) return apiError(404, 'simulation_run_not_found', 'simulation run not found')
    const events = runtime.events(afterSeq === undefined ? {} : { afterSeq })
    return json({ events, nextSeq: events.at(-1)?.seq ?? afterSeq ?? 0 })
  }

  const queryMatch = pathname.match(/^\/simulation-runs\/([^/]+)\/queries$/)
  if (queryMatch && req.method === 'POST') {
    const simulationRunId = simulationRunIdSchema.parse(decodeURIComponent(queryMatch[1] ?? ''))
    const runtime = config.registry.get(simulationRunId)
    if (!runtime) return apiError(404, 'simulation_run_not_found', 'simulation run not found')
    const raw = await readJson(req)
    const query = buildPackQuery(raw)
    const response = await runtime.queryPack(query)
    return json({ response }, { status: response.ok ? 200 : 400 })
  }

  const procedureCatalogMatch = pathname.match(/^\/simulation-runs\/([^/]+)\/procedures$/)
  if (procedureCatalogMatch && req.method === 'GET') {
    const simulationRunId = simulationRunIdSchema.parse(decodeURIComponent(procedureCatalogMatch[1] ?? ''))
    const runtime = config.registry.get(simulationRunId)
    if (!runtime) return apiError(404, 'simulation_run_not_found', 'simulation run not found')
    const sourceIdParam = url.searchParams.get('sourceId')
    const refresh = url.searchParams.get('refresh') === 'true'
    const catalog = await runtime.procedureCatalog({
      ...(sourceIdParam === null ? {} : { sourceId: procedureSourceIdSchema.parse(sourceIdParam) }),
      refresh,
    })
    return json({ catalog })
  }

  const procedureSourceStatusMatch = pathname.match(/^\/simulation-runs\/([^/]+)\/procedure-source-status$/)
  if (procedureSourceStatusMatch && req.method === 'GET') {
    const simulationRunId = simulationRunIdSchema.parse(decodeURIComponent(procedureSourceStatusMatch[1] ?? ''))
    const runtime = config.registry.get(simulationRunId)
    if (!runtime) return apiError(404, 'simulation_run_not_found', 'simulation run not found')
    const sourceIdParam = url.searchParams.get('sourceId')
    const status = runtime.procedureSourceStatus({
      ...(sourceIdParam === null ? {} : { sourceId: procedureSourceIdSchema.parse(sourceIdParam) }),
    })
    return json({ status })
  }

  const procedureDocumentMatch = pathname.match(/^\/simulation-runs\/([^/]+)\/procedures\/([^/]+)$/)
  if (procedureDocumentMatch && req.method === 'GET') {
    const simulationRunId = simulationRunIdSchema.parse(decodeURIComponent(procedureDocumentMatch[1] ?? ''))
    const procedureId = procedureIdSchema.parse(decodeURIComponent(procedureDocumentMatch[2] ?? ''))
    const runtime = config.registry.get(simulationRunId)
    if (!runtime) return apiError(404, 'simulation_run_not_found', 'simulation run not found')
    const sourceIdParam = url.searchParams.get('sourceId')
    const refresh = url.searchParams.get('refresh') === 'true'
    const procedure = await runtime.procedureDocument({
      procedureId,
      ...(sourceIdParam === null ? {} : { sourceId: procedureSourceIdSchema.parse(sourceIdParam) }),
      refresh,
    })
    return json({ procedure })
  }

  const procedureRunsMatch = pathname.match(/^\/simulation-runs\/([^/]+)\/procedure-runs$/)
  if (procedureRunsMatch && req.method === 'GET') {
    const simulationRunId = simulationRunIdSchema.parse(decodeURIComponent(procedureRunsMatch[1] ?? ''))
    const runtime = config.registry.get(simulationRunId)
    if (!runtime) return apiError(404, 'simulation_run_not_found', 'simulation run not found')
    return json({ procedures: runtime.snapshot().procedures ?? { runs: [] } })
  }

  const clockMatch = pathname.match(/^\/simulation-runs\/([^/]+)\/clock$/)
  if (clockMatch && req.method === 'POST') {
    const simulationRunId = simulationRunIdSchema.parse(decodeURIComponent(clockMatch[1] ?? ''))
    const runtime = config.registry.get(simulationRunId)
    if (!runtime) return apiError(404, 'simulation_run_not_found', 'simulation run not found')
    const raw = await readJson(req)
    const parsed = simulationClockUpdateSchema.parse(raw)
    const update = {
      ...(parsed.paused === undefined ? {} : { paused: parsed.paused }),
      ...(parsed.speed === undefined ? {} : { speed: parsed.speed }),
      ...(parsed.currentTime === undefined ? {} : { currentTime: parsed.currentTime }),
    }
    const clock = await runtime.setClock(update)
    return json({ clock })
  }

  const commandMatch = pathname.match(/^\/simulation-runs\/([^/]+)\/commands$/)
  if (commandMatch && req.method === 'POST') {
    const simulationRunId = simulationRunIdSchema.parse(decodeURIComponent(commandMatch[1] ?? ''))
    const runtime = config.registry.get(simulationRunId)
    if (!runtime) return apiError(404, 'simulation_run_not_found', 'simulation run not found')
    const raw = await readJson(req)
    const command = buildSimulationRunCommand(simulationRunId, raw, actorIdForAccessContext(config.accessContext))
    const actor = buildSimulationRunActor(command.actorId)
    const issued = await issueCommandWithIdempotency({
      store: commandIdempotencyStoreForRuntime(config.registry.workspaceId, simulationRunId),
      idempotency: commandIdempotencyConfigFromEnv(),
      actor,
      command,
      issue: runtime.issueCommand,
    })
    if (!issued.ok) return apiError(issued.status, issued.code, issued.message)
    const result = issued.result
    return json({ result })
  }

  const signalMatch = pathname.match(/^\/simulation-runs\/([^/]+)\/signals$/)
  if (signalMatch && req.method === 'POST') {
    const simulationRunId = simulationRunIdSchema.parse(decodeURIComponent(signalMatch[1] ?? ''))
    const runtime = config.registry.get(simulationRunId)
    if (!runtime) return apiError(404, 'simulation_run_not_found', 'simulation run not found')
    const raw = await readJson(req)
    const { signal, actor } = buildSignal(simulationRunId, raw, actorIdForAccessContext(config.accessContext))
    await runtime.publishInteractionSignal(signal, { source: actor.id.startsWith('actor:ai') ? 'ai' : 'operator' })
    return json({ signal }, { status: 202 })
  }

  return null
}

export const handleSimulationRunApi = async (
  req: Request,
  url: URL,
  config: SimulationRunRouteConfig,
): Promise<Response | null> => {
  try {
    return await handleSimulationRunApiInner(req, url, config)
  } catch (err) {
    if (err instanceof SyntaxError) return apiError(400, 'invalid_json', err.message)
    if (err instanceof z.ZodError) return apiError(400, 'invalid_request', err.message)
    throw err
  }
}
