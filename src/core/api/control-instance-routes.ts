import { z } from 'zod'
import { actorIdSchema, clientIdSchema, commandEnvelopeSchema, controlInstanceIdSchema, interactionEndpointSchema, interactionSignalSchema, nowIso, objectIdSchema, simulationClockUpdateSchema, type CommandEnvelope, type ControlInstanceId, type InteractionSignal } from '../model/index.ts'
import type { Actor } from '../control-instances/actors.ts'
import type { PackQueryRequest } from '../packs/protocol.ts'
import type { ControlInstanceRegistry } from '../control-instances/registry.ts'
import { apiError, json, readJson } from './responses.ts'

export interface ControlInstanceRouteConfig {
  readonly registry: ControlInstanceRegistry
  readonly websocketClients?: ReadonlyArray<{
    readonly id: ControlInstanceId
    readonly websocketClientCount: number
  }>
}

const commandRequestSchema = z.object({
  actorId: actorIdSchema.default('actor:operator'),
  clientId: clientIdSchema.optional(),
  kind: z.string().min(1),
  targetObjectIds: z.array(objectIdSchema),
  payload: z.unknown(),
  expectedRevision: z.number().int().nonnegative().optional(),
})

const createControlInstanceRequestSchema = z.object({
  id: controlInstanceIdSchema.optional(),
  scenarioId: z.string().min(1).optional(),
})

const signalRequestSchema = z.object({
  actorId: actorIdSchema.default('actor:operator'),
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

const buildActor = (actorId: Actor['id']): Actor => ({
  id: actorId,
  label: actorId,
  role: 'operator',
})

const buildCommand = (controlInstanceId: ControlInstanceId, raw: unknown): CommandEnvelope => {
  const parsed = commandRequestSchema.parse(raw)
  const candidate = {
    id: `command:${crypto.randomUUID()}`,
    controlInstanceId,
    actorId: parsed.actorId,
    ...(parsed.clientId === undefined ? {} : { clientId: parsed.clientId }),
    kind: parsed.kind,
    targetObjectIds: parsed.targetObjectIds,
    payload: parsed.payload,
    issuedAt: nowIso(),
    ...(parsed.expectedRevision === undefined ? {} : { expectedRevision: parsed.expectedRevision }),
  }
  return commandEnvelopeSchema.parse(candidate) as CommandEnvelope
}

const buildSignal = (controlInstanceId: ControlInstanceId, raw: unknown): {
  readonly signal: InteractionSignal
  readonly actor: Actor
} => {
  const parsed = signalRequestSchema.parse(raw)
  const targets = parsed.targets ?? parsed.targetObjectIds?.map(objectId => ({ kind: 'object' as const, id: objectId })) ?? []
  const signal = interactionSignalSchema.parse({
    id: `signal:${crypto.randomUUID()}`,
    controlInstanceId,
    at: nowIso(),
    source: parsed.source ?? (parsed.clientId
      ? { kind: 'client', id: parsed.clientId }
      : { kind: 'actor', id: parsed.actorId }),
    targets,
    type: parsed.type,
    payload: parsed.payload,
    ...(parsed.severity === undefined ? {} : { severity: parsed.severity }),
    ...(parsed.correlationId === undefined ? {} : { correlationId: parsed.correlationId }),
    ...(parsed.causationId === undefined ? {} : { causationId: parsed.causationId }),
    ...(parsed.ttlMs === undefined ? {} : { ttlMs: parsed.ttlMs }),
  }) as InteractionSignal
  return { signal, actor: buildActor(parsed.actorId) }
}

const buildPackQuery = (raw: unknown): PackQueryRequest => {
  const parsed = packQueryRequestSchema.parse(raw)
  return {
    packId: parsed.packId,
    kind: parsed.kind,
    payload: parsed.payload,
  }
}

const handleControlInstanceApiInner = async (
  req: Request,
  url: URL,
  config: ControlInstanceRouteConfig,
): Promise<Response | null> => {
  if (url.pathname === '/api/scenarios' && req.method === 'GET') {
    return json({
      scenarios: config.registry.scenarios().map(scenario => ({
        id: scenario.id,
        title: scenario.title,
        description: scenario.description,
        missionId: scenario.missionId,
      })),
      defaultScenarioId: config.registry.defaultScenarioId(),
    })
  }

  const scenarioMatch = url.pathname.match(/^\/api\/scenarios\/([^/]+)$/)
  if (scenarioMatch && req.method === 'GET') {
    const scenarioId = decodeURIComponent(scenarioMatch[1] ?? '')
    const scenario = config.registry.scenario(scenarioId)
    if (!scenario) return apiError(404, 'scenario_not_found', 'scenario not found')
    return json({ scenario })
  }

  if (url.pathname === '/api/control-instances' && req.method === 'GET') {
    const websocketClientCountById = new Map(
      (config.websocketClients ?? []).map(item => [item.id, item.websocketClientCount]),
    )
    return json({
      controlInstances: (await config.registry.listKnown()).map(summary => ({
        ...summary,
        websocketClientCount: websocketClientCountById.get(summary.id) ?? 0,
      })),
    })
  }

  if (url.pathname === '/api/control-instances' && req.method === 'POST') {
    const raw = await readJson(req)
    const parsed = createControlInstanceRequestSchema.parse(raw)
    if (parsed.scenarioId !== undefined && !config.registry.scenario(parsed.scenarioId)) {
      return apiError(404, 'scenario_not_found', 'scenario not found')
    }
    const runtime = await config.registry.create({
      ...(parsed.id === undefined ? {} : { id: parsed.id }),
      ...(parsed.scenarioId === undefined ? {} : { scenarioId: parsed.scenarioId }),
    })
    return json({ id: runtime.id, snapshot: runtime.snapshot() }, { status: 201 })
  }

  const controlInstanceMatch = url.pathname.match(/^\/api\/control-instances\/([^/]+)$/)
  if (controlInstanceMatch && req.method === 'GET') {
    const controlInstanceId = controlInstanceIdSchema.parse(decodeURIComponent(controlInstanceMatch[1] ?? ''))
    const runtime = config.registry.get(controlInstanceId)
    if (!runtime) return apiError(404, 'control_instance_not_found', 'control instance not found')
    return json({ id: runtime.id, snapshot: runtime.snapshot() })
  }

  if (controlInstanceMatch && req.method === 'DELETE') {
    const controlInstanceId = controlInstanceIdSchema.parse(decodeURIComponent(controlInstanceMatch[1] ?? ''))
    const websocketClientCount = config.websocketClients?.find(item => item.id === controlInstanceId)?.websocketClientCount ?? 0
    if (websocketClientCount > 0) {
      return apiError(409, 'control_instance_has_users', 'control instance has connected users')
    }
    const deleted = await config.registry.delete(controlInstanceId)
    if (!deleted) return apiError(404, 'control_instance_not_found', 'control instance not found')
    return json({ id: controlInstanceId, deleted: true })
  }

  if (controlInstanceMatch && req.method === 'POST') {
    const controlInstanceId = controlInstanceIdSchema.parse(decodeURIComponent(controlInstanceMatch[1] ?? ''))
    const raw = await readJson(req)
    const parsed = createControlInstanceRequestSchema.omit({ id: true }).parse(raw)
    if (parsed.scenarioId !== undefined && !config.registry.scenario(parsed.scenarioId)) {
      return apiError(404, 'scenario_not_found', 'scenario not found')
    }
    const runtime = await config.registry.ensure(controlInstanceId, {
      ...(parsed.scenarioId === undefined ? {} : { scenarioId: parsed.scenarioId }),
    })
    return json({ id: runtime.id, snapshot: runtime.snapshot() })
  }

  const snapshotMatch = url.pathname.match(/^\/api\/control-instances\/([^/]+)\/snapshot$/)
  if (snapshotMatch && req.method === 'GET') {
    const controlInstanceId = controlInstanceIdSchema.parse(decodeURIComponent(snapshotMatch[1] ?? ''))
    const runtime = config.registry.get(controlInstanceId)
    if (!runtime) return apiError(404, 'control_instance_not_found', 'control instance not found')
    return json({ id: runtime.id, snapshot: runtime.snapshot() })
  }

  const resetMatch = url.pathname.match(/^\/api\/control-instances\/([^/]+)\/reset$/)
  if (resetMatch && req.method === 'POST') {
    const controlInstanceId = controlInstanceIdSchema.parse(decodeURIComponent(resetMatch[1] ?? ''))
    const raw = await readJson(req)
    const parsed = createControlInstanceRequestSchema.omit({ id: true }).parse(raw)
    if (parsed.scenarioId !== undefined && !config.registry.scenario(parsed.scenarioId)) {
      return apiError(404, 'scenario_not_found', 'scenario not found')
    }
    const runtime = await config.registry.reset(controlInstanceId, {
      ...(parsed.scenarioId === undefined ? {} : { scenarioId: parsed.scenarioId }),
    })
    return json({ id: runtime.id, snapshot: runtime.snapshot() })
  }

  const objectsMatch = url.pathname.match(/^\/api\/control-instances\/([^/]+)\/objects$/)
  if (objectsMatch && req.method === 'GET') {
    const controlInstanceId = controlInstanceIdSchema.parse(decodeURIComponent(objectsMatch[1] ?? ''))
    const runtime = config.registry.get(controlInstanceId)
    if (!runtime) return apiError(404, 'control_instance_not_found', 'control instance not found')
    return json({ objects: runtime.snapshot().objects })
  }

  const objectMatch = url.pathname.match(/^\/api\/control-instances\/([^/]+)\/objects\/([^/]+)$/)
  if (objectMatch && req.method === 'GET') {
    const controlInstanceId = controlInstanceIdSchema.parse(decodeURIComponent(objectMatch[1] ?? ''))
    const objectId = objectIdSchema.parse(decodeURIComponent(objectMatch[2] ?? ''))
    const runtime = config.registry.get(controlInstanceId)
    if (!runtime) return apiError(404, 'control_instance_not_found', 'control instance not found')
    const object = runtime.snapshot().objects.find(candidate => candidate.id === objectId)
    if (!object) return apiError(404, 'object_not_found', 'object not found')
    return json({ object })
  }

  const eventsMatch = url.pathname.match(/^\/api\/control-instances\/([^/]+)\/events$/)
  if (eventsMatch && req.method === 'GET') {
    const controlInstanceId = controlInstanceIdSchema.parse(decodeURIComponent(eventsMatch[1] ?? ''))
    const afterSeqParam = url.searchParams.get('afterSeq')
    const afterSeq = afterSeqParam === null ? undefined : z.coerce.number().int().nonnegative().parse(afterSeqParam)
    const runtime = config.registry.get(controlInstanceId)
    if (!runtime) return apiError(404, 'control_instance_not_found', 'control instance not found')
    const events = runtime.events(afterSeq === undefined ? {} : { afterSeq })
    return json({ events, nextSeq: events.at(-1)?.seq ?? afterSeq ?? 0 })
  }

  const queryMatch = url.pathname.match(/^\/api\/control-instances\/([^/]+)\/queries$/)
  if (queryMatch && req.method === 'POST') {
    const controlInstanceId = controlInstanceIdSchema.parse(decodeURIComponent(queryMatch[1] ?? ''))
    const runtime = config.registry.get(controlInstanceId)
    if (!runtime) return apiError(404, 'control_instance_not_found', 'control instance not found')
    const raw = await readJson(req)
    const query = buildPackQuery(raw)
    const response = await runtime.queryPack(query)
    return json({ response }, { status: response.ok ? 200 : 400 })
  }

  const clockMatch = url.pathname.match(/^\/api\/control-instances\/([^/]+)\/clock$/)
  if (clockMatch && req.method === 'POST') {
    const controlInstanceId = controlInstanceIdSchema.parse(decodeURIComponent(clockMatch[1] ?? ''))
    const runtime = config.registry.get(controlInstanceId)
    if (!runtime) return apiError(404, 'control_instance_not_found', 'control instance not found')
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

  const commandMatch = url.pathname.match(/^\/api\/control-instances\/([^/]+)\/commands$/)
  if (commandMatch && req.method === 'POST') {
    const controlInstanceId = controlInstanceIdSchema.parse(decodeURIComponent(commandMatch[1] ?? ''))
    const runtime = config.registry.get(controlInstanceId)
    if (!runtime) return apiError(404, 'control_instance_not_found', 'control instance not found')
    const raw = await readJson(req)
    const command = buildCommand(controlInstanceId, raw)
    const actor = buildActor(command.actorId)
    const result = await runtime.issueCommand(actor, command)
    return json({ result })
  }

  const signalMatch = url.pathname.match(/^\/api\/control-instances\/([^/]+)\/signals$/)
  if (signalMatch && req.method === 'POST') {
    const controlInstanceId = controlInstanceIdSchema.parse(decodeURIComponent(signalMatch[1] ?? ''))
    const runtime = config.registry.get(controlInstanceId)
    if (!runtime) return apiError(404, 'control_instance_not_found', 'control instance not found')
    const raw = await readJson(req)
    const { signal, actor } = buildSignal(controlInstanceId, raw)
    await runtime.publishInteractionSignal(signal, { source: actor.id.startsWith('actor:ai') ? 'ai' : 'operator' })
    return json({ signal }, { status: 202 })
  }

  return null
}

export const handleControlInstanceApi = async (
  req: Request,
  url: URL,
  config: ControlInstanceRouteConfig,
): Promise<Response | null> => {
  try {
    return await handleControlInstanceApiInner(req, url, config)
  } catch (err) {
    if (err instanceof SyntaxError) return apiError(400, 'invalid_json', err.message)
    if (err instanceof z.ZodError) return apiError(400, 'invalid_request', err.message)
    throw err
  }
}
