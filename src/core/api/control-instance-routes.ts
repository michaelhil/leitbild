import { z } from 'zod'
import { actorIdSchema, clientIdSchema, commandEnvelopeSchema, controlInstanceIdSchema, nowIso, objectIdSchema, type CommandEnvelope, type ControlInstanceId } from '../model/index.ts'
import type { Actor } from '../control-instances/actors.ts'
import type { ControlInstanceRegistry } from '../control-instances/registry.ts'
import { apiError, json, readJson } from './responses.ts'

export interface ControlInstanceRouteConfig {
  readonly registry: ControlInstanceRegistry
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

const handleControlInstanceApiInner = async (
  req: Request,
  url: URL,
  config: ControlInstanceRouteConfig,
): Promise<Response | null> => {
  if (url.pathname === '/api/control-instances' && req.method === 'GET') {
    return json({ controlInstances: await config.registry.listKnown() })
  }

  if (url.pathname === '/api/control-instances' && req.method === 'POST') {
    const raw = await readJson(req)
    const parsed = createControlInstanceRequestSchema.parse(raw)
    const runtime = await config.registry.create(parsed.id === undefined ? {} : { id: parsed.id })
    return json({ id: runtime.id, snapshot: runtime.snapshot() }, { status: 201 })
  }

  const controlInstanceMatch = url.pathname.match(/^\/api\/control-instances\/([^/]+)$/)
  if (controlInstanceMatch && req.method === 'GET') {
    const controlInstanceId = controlInstanceIdSchema.parse(decodeURIComponent(controlInstanceMatch[1] ?? ''))
    const runtime = config.registry.get(controlInstanceId)
    if (!runtime) return apiError(404, 'control_instance_not_found', 'control instance not found')
    return json({ id: runtime.id, snapshot: runtime.snapshot() })
  }

  if (controlInstanceMatch && req.method === 'POST') {
    const controlInstanceId = controlInstanceIdSchema.parse(decodeURIComponent(controlInstanceMatch[1] ?? ''))
    const runtime = await config.registry.ensure(controlInstanceId)
    return json({ id: runtime.id, snapshot: runtime.snapshot() })
  }

  const snapshotMatch = url.pathname.match(/^\/api\/control-instances\/([^/]+)\/snapshot$/)
  if (snapshotMatch && req.method === 'GET') {
    const controlInstanceId = controlInstanceIdSchema.parse(decodeURIComponent(snapshotMatch[1] ?? ''))
    const runtime = config.registry.get(controlInstanceId)
    if (!runtime) return apiError(404, 'control_instance_not_found', 'control instance not found')
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
