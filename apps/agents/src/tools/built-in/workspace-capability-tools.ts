import {
  capabilityIdSchema,
  definitionIdSchema,
  definitionRevisionIdSchema,
  definitionTypeSchema,
  isExactToolGrant,
  moduleIdSchema,
  resourceIdSchema,
  resourceTypeSchema,
  workspaceCapabilityCatalogSchema,
  workspaceDefinitionCatalogSchema,
  workspaceResourceCatalogSchema,
  type ModuleCapabilityDescriptor,
  type ModuleResourceDescriptor,
  type ToolGrant,
  type WorkspaceId,
  type WorkspaceResourceReference,
} from '@leitbild/contracts'
import type { Tool, ToolContext, ToolResult } from '../../core/types/tool.ts'

export interface WorkspaceCapabilityToolsDeps {
  readonly workspaceId: WorkspaceId
  readonly hostBaseUrl: string
  readonly getToolGrants: (agentId: string) => ReadonlyArray<ToolGrant> | undefined
  readonly getRoomCompanionOf: (roomId: string) => WorkspaceResourceReference | undefined
  readonly fetchImpl?: typeof fetch
}

export const WORKSPACE_CAPABILITY_TOOL_NAMES = ['workspace_catalog', 'workspace_capabilities', 'workspace_invoke'] as const

// Bound network fan-out and model-context growth at the broker edge. These
// are transport safety limits, not domain policy; Capabilities remain free to
// expose their own pagination appropriate to the data they own.
const HOST_REQUEST_TIMEOUT_MS = 30_000
const DEFAULT_DISCOVERY_PAGE_SIZE = 30
const MAX_DISCOVERY_PAGE_SIZE = 100
const MAX_INVOKE_BATCH_SIZE = 12

const failure = (code: string, message: string, details?: Record<string, unknown>): ToolResult => ({
  success: false,
  error: `${code}: ${message}`,
  data: { code, ...(details === undefined ? {} : { details }) },
})

const origin = (raw: string): string => {
  const url = new URL(raw)
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Workspace Host URL must use http or https')
  if (url.pathname !== '/' || url.search || url.hash) throw new Error('Workspace Host URL must be an origin')
  return url.origin
}

const readHostError = async (response: Response): Promise<ToolResult> => {
  const body = await response.json().catch(() => undefined) as { error?: { code?: unknown; message?: unknown; retryable?: unknown; details?: unknown } } | undefined
  const code = typeof body?.error?.code === 'string' ? body.error.code : 'workspace_host_request_failed'
  const message = typeof body?.error?.message === 'string' ? body.error.message : `Workspace Host returned HTTP ${response.status}`
  return failure(code, message, {
    status: response.status,
    retryable: body?.error?.retryable === true,
    ...(body?.error?.details && typeof body.error.details === 'object' ? { hostDetails: body.error.details as Record<string, unknown> } : {}),
  })
}

const requestSignal = (signal?: AbortSignal): AbortSignal => AbortSignal.any([AbortSignal.timeout(HOST_REQUEST_TIMEOUT_MS), ...(signal ? [signal] : [])])
// Models commonly express an unconstrained optional filter as either an
// omitted field, an empty string, or "*". They all mean the same thing at a
// discovery boundary; normalize them before strict domain-ID validation.
const optionalFilter = (value: unknown): unknown =>
  typeof value === 'string' && (value.trim().length === 0 || value.trim() === '*') ? undefined : value
const referenceKey = (ref: { moduleId: string; type: string; id: string }): string => `${ref.moduleId}:${ref.type}:${ref.id}`

const getJson = async (fetchImpl: typeof fetch, url: string, signal?: AbortSignal): Promise<Response> => {
  try {
    return await fetchImpl(url, { signal: requestSignal(signal), headers: { Accept: 'application/json' } })
  } catch (error) {
    throw new Error(`Workspace Host is unreachable: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }
}

type Catalogs = {
  capabilities: ReturnType<typeof workspaceCapabilityCatalogSchema.parse>
  resources: ReturnType<typeof workspaceResourceCatalogSchema.parse>
}

const readCatalogs = async (fetchImpl: typeof fetch, workspacePath: string, signal?: AbortSignal): Promise<Catalogs | ToolResult> => {
  const [capabilityResponse, resourceResponse] = await Promise.all([
    getJson(fetchImpl, `${workspacePath}/capabilities`, signal),
    getJson(fetchImpl, `${workspacePath}/resources`, signal),
  ])
  if (!capabilityResponse.ok) return await readHostError(capabilityResponse)
  if (!resourceResponse.ok) return await readHostError(resourceResponse)
  return {
    capabilities: workspaceCapabilityCatalogSchema.parse(await capabilityResponse.json()),
    resources: workspaceResourceCatalogSchema.parse(await resourceResponse.json()),
  }
}

const parseResource = (value: unknown, workspaceId: WorkspaceId): WorkspaceResourceReference | undefined => {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('resource must be an object')
  const raw = value as Record<string, unknown>
  const fields = [raw.moduleId, raw.type, raw.id]
  // A wildcard anywhere means this is a discovery scope hint, not an exact
  // Resource identity. Invocation never uses this parser and remains strict.
  if (fields.some(field => typeof field === 'string' && (field.trim() === '*' || field.trim().length === 0))) {
    return undefined
  }
  return {
    workspaceId,
    moduleId: moduleIdSchema.parse(raw.moduleId),
    type: resourceTypeSchema.parse(raw.type),
    id: resourceIdSchema.parse(raw.id),
  }
}

const hasLinkedReadGrant = (grants: ReadonlyArray<ToolGrant>): boolean =>
  grants.some(grant => !isExactToolGrant(grant) && grant.scope === 'room-linked-resource' && grant.risk === 'read')

const authorizationFailure = (
  capability: ModuleCapabilityDescriptor | undefined,
  resourceDescriptor: ModuleResourceDescriptor | undefined,
  resource: WorkspaceResourceReference | undefined,
  grants: ReadonlyArray<ToolGrant>,
  context: ToolContext,
  deps: WorkspaceCapabilityToolsDeps,
): ToolResult | undefined => {
  if (!capability) return failure('capability_not_advertised', 'The Workspace does not advertise this Capability')
  if (grants.some(grant => isExactToolGrant(grant) && grant.capabilityId === capability.id)) return undefined
  if (!hasLinkedReadGrant(grants)) return failure('capability_not_granted', `Agent ${context.callerName} is not granted ${capability.id}`, { capabilityId: capability.id })
  if (!context.roomId) return failure('room_context_required', 'The linked-Resource read grant requires a current Room')
  const linked = deps.getRoomCompanionOf(context.roomId)
  if (!linked) return failure('target_not_linked', 'The current Room has no linked Resource')
  if (!resource || referenceKey(resource) !== referenceKey(linked)) {
    return failure('target_not_linked', 'The requested Resource is not linked to the current Room', { linkedResource: linked })
  }
  if (capability.risk !== 'read') return failure('risk_not_allowed', 'A linked-Resource read grant cannot invoke write or destructive Capabilities', { risk: capability.risk })
  if (!resourceDescriptor || !resourceDescriptor.capabilityIds.includes(capability.id)) {
    return failure('capability_not_advertised', 'The linked Resource does not advertise this Capability', { capabilityId: capability.id })
  }
  if (capability.scope.kind !== 'resource' || capability.scope.resourceType !== resource.type) {
    return failure('capability_scope_mismatch', 'The Capability is not scoped to the requested Resource type')
  }
  return undefined
}

const textMatchScore = (capability: ModuleCapabilityDescriptor, query: string): number => {
  const terms = [...new Set(query.toLowerCase().split(/[^a-z0-9.-]+/).filter(term => term.length >= 2))]
  const haystack = `${capability.id} ${capability.title} ${capability.description} ${capability.moduleId} ${capability.kind} ${capability.risk}`.toLowerCase()
  const haystackTerms = new Set(haystack.split(/[^a-z0-9]+/).filter(Boolean))
  return terms.reduce((score, term) => score + (haystackTerms.has(term) ? 1 : 0), 0)
}

export const createWorkspaceCapabilityTools = (deps: WorkspaceCapabilityToolsDeps): ReadonlyArray<Tool> => {
  const fetchImpl = deps.fetchImpl ?? fetch
  const workspacePath = `${origin(deps.hostBaseUrl)}/api/workspaces/${encodeURIComponent(deps.workspaceId)}`

  const catalog: Tool = {
    name: 'workspace_catalog',
    description: 'Discover current or Workspace-wide Definitions and Resources, including the current Room link and focused subjects.',
    usage: 'Use scope=current for compact orientation. Use scope=workspace with filters and pagination only when broader discovery is relevant.',
    returns: 'Compact references, links, capability IDs, totals, and pagination metadata.',
    parameters: {
      type: 'object', properties: {
        scope: { type: 'string', enum: ['current', 'workspace'], default: 'current' },
        moduleId: { type: 'string', description: 'Optional exact Module id filter. Omit or use "*" to match any Module.' },
        definitionType: { type: 'string', description: 'Optional exact Definition type filter. Omit or use "*" to match any type.' },
        resourceType: { type: 'string', description: 'Optional exact Resource type filter. Omit or use "*" to match any type.' },
        capabilityId: { type: 'string', description: 'Optional exact advertised Capability id filter. Omit or use "*" to match any Capability.' },
        offset: { type: 'integer', minimum: 0, default: 0 }, limit: { type: 'integer', minimum: 1, maximum: MAX_DISCOVERY_PAGE_SIZE, default: DEFAULT_DISCOVERY_PAGE_SIZE },
      }, additionalProperties: false,
    },
    execute: async (params, context) => {
      try {
        const scope = params.scope === undefined ? 'current' : String(params.scope)
        if (!['current', 'workspace'].includes(scope)) return failure('invalid_tool_input', 'scope must be current or workspace')
        const moduleId = optionalFilter(params.moduleId) === undefined ? undefined : moduleIdSchema.parse(params.moduleId)
        const definitionType = optionalFilter(params.definitionType) === undefined ? undefined : definitionTypeSchema.parse(params.definitionType)
        const resourceType = optionalFilter(params.resourceType) === undefined ? undefined : resourceTypeSchema.parse(params.resourceType)
        const capabilityId = optionalFilter(params.capabilityId) === undefined ? undefined : capabilityIdSchema.parse(params.capabilityId)
        const offset = params.offset === undefined ? 0 : Number(params.offset)
        const limit = params.limit === undefined ? DEFAULT_DISCOVERY_PAGE_SIZE : Number(params.limit)
        if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > MAX_DISCOVERY_PAGE_SIZE) return failure('invalid_tool_input', 'Invalid pagination')
        const [definitionResponse, resourceResponse] = await Promise.all([
          getJson(fetchImpl, `${workspacePath}/definitions`, context.signal),
          getJson(fetchImpl, `${workspacePath}/resources`, context.signal),
        ])
        if (!definitionResponse.ok) return await readHostError(definitionResponse)
        if (!resourceResponse.ok) return await readHostError(resourceResponse)
        const definitionCatalog = workspaceDefinitionCatalogSchema.parse(await definitionResponse.json())
        const resourceCatalog = workspaceResourceCatalogSchema.parse(await resourceResponse.json())
        const currentRoom = resourceCatalog.resources.find(resource => resource.ref.type === 'agents.room' && resource.ref.id === context.roomId) ?? null
        const currentKeys = new Set<string>([
          ...(context.focusedSubjects ?? []).map(referenceKey),
          ...(currentRoom?.links ?? []).map(link => referenceKey(link.ref)),
          ...(currentRoom ? [referenceKey(currentRoom.ref)] : []),
        ])
        const definitions = definitionCatalog.definitions.filter(definition =>
          (scope === 'workspace' || currentKeys.has(referenceKey(definition.ref))) &&
          (moduleId === undefined || definition.ref.moduleId === moduleId) &&
          (definitionType === undefined || definition.ref.type === definitionType) &&
          (capabilityId === undefined || definition.capabilityIds.includes(capabilityId)))
        const resources = resourceCatalog.resources.filter(resource =>
          (scope === 'workspace' || currentKeys.has(referenceKey(resource.ref))) &&
          (moduleId === undefined || resource.ref.moduleId === moduleId) &&
          (resourceType === undefined || resource.ref.type === resourceType) &&
          (capabilityId === undefined || resource.capabilityIds.includes(capabilityId)))
        const combined = [...definitions.map(value => ({ kind: 'definition' as const, value })), ...resources.map(value => ({ kind: 'resource' as const, value }))]
        const page = combined.slice(offset, offset + limit)
        return { success: true, data: {
          workspaceId: deps.workspaceId, focusedSubjects: context.focusedSubjects ?? [], currentRoom,
          modules: { definitions: definitionCatalog.modules, resources: resourceCatalog.modules },
          total: combined.length, offset, returned: page.length, hasMore: offset + page.length < combined.length,
          definitions: page.filter(item => item.kind === 'definition').map(item => item.value),
          resources: page.filter(item => item.kind === 'resource').map(item => item.value),
        } }
      } catch (error) {
        return failure('workspace_catalog_discovery_failed', error instanceof Error ? error.message : String(error))
      }
    },
  }

  const capabilities: Tool = {
    name: 'workspace_capabilities',
    description: 'Search Capability descriptions or retrieve exact callable schemas for a selected Resource.',
    usage: 'Supply natural-language queries for broad discovery or capabilityIds for exact lookup. If both are supplied, results matching either are returned. Output schemas are returned only for exact requested IDs and only when granted.',
    returns: 'Capability descriptors with grant state, matched queries, totals, and pagination metadata.',
    parameters: {
      type: 'object', properties: {
        resource: { type: 'object', description: 'Optional exact Resource selector. Omit it to search all Resources. Any wildcard field makes the search unscoped; only a complete exact identity enables Resource-specific grant and schema resolution.', properties: { moduleId: { type: 'string' }, type: { type: 'string' }, id: { type: 'string' } }, required: ['moduleId', 'type', 'id'], additionalProperties: false },
        moduleId: { type: 'string', description: 'Optional exact Module id filter. Omit or use "*" to search all Modules.' }, queries: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 256 }, maxItems: 8 },
        capabilityIds: { type: 'array', items: { type: 'string' }, maxItems: 24 },
        risk: { type: 'string', enum: ['read', 'write', 'destructive'] }, kind: { type: 'string', enum: ['query', 'command'] },
        includeOutputSchema: { type: 'boolean', default: false }, offset: { type: 'integer', minimum: 0, default: 0 }, limit: { type: 'integer', minimum: 1, maximum: MAX_DISCOVERY_PAGE_SIZE, default: DEFAULT_DISCOVERY_PAGE_SIZE },
      }, additionalProperties: false,
    },
    execute: async (params, context) => {
      try {
        const grants = deps.getToolGrants(context.callerId)
        if (!grants) return failure('caller_not_ai_agent', 'Workspace Capability discovery requires an AI Agent Profile')
        const moduleId = optionalFilter(params.moduleId) === undefined ? undefined : moduleIdSchema.parse(params.moduleId)
        const resource = parseResource(params.resource, deps.workspaceId)
        const ids = Array.isArray(params.capabilityIds) ? params.capabilityIds.map(value => capabilityIdSchema.parse(value)) : []
        const queries = Array.isArray(params.queries) ? params.queries.map(value => String(value).trim()).filter(Boolean) : []
        const risk = optionalFilter(params.risk) as string | undefined
        const kind = optionalFilter(params.kind) as string | undefined
        const offset = params.offset === undefined ? 0 : Number(params.offset)
        const limit = params.limit === undefined ? DEFAULT_DISCOVERY_PAGE_SIZE : Number(params.limit)
        if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > MAX_DISCOVERY_PAGE_SIZE) return failure('invalid_tool_input', 'Invalid pagination')
        const catalogs = await readCatalogs(fetchImpl, workspacePath, context.signal)
        if ('success' in catalogs) return catalogs
        const target = resource ? catalogs.resources.resources.find(item => referenceKey(item.ref) === referenceKey(resource)) : undefined
        const exact = new Set(ids)
        const relevance = (capability: ModuleCapabilityDescriptor): number =>
          queries.reduce((score, query) => Math.max(score, textMatchScore(capability, query)), 0)
        const noSelector = ids.length === 0 && queries.length === 0
        const filtered = catalogs.capabilities.capabilities.filter(capability =>
          (moduleId === undefined || capability.moduleId === moduleId) &&
          (noSelector || exact.has(capability.id) || relevance(capability) > 0) &&
          (risk === undefined || capability.risk === risk) && (kind === undefined || capability.kind === kind) &&
          (resource === undefined || target?.capabilityIds.includes(capability.id) === true))
          .sort((left, right) =>
            Number(exact.has(right.id)) - Number(exact.has(left.id)) ||
            relevance(right) - relevance(left) ||
            left.id.localeCompare(right.id))
        const page = filtered.slice(offset, offset + limit).map(capability => {
          const { inputSchema, outputSchema, ...compact } = capability
          const granted = authorizationFailure(capability, target, resource, grants, context, deps) === undefined
          const exactMatch = exact.has(capability.id)
          return {
            ...compact, granted,
            ...(queries.length > 0 ? { matchedQueries: queries.filter(query => textMatchScore(capability, query) > 0) } : {}),
            ...(granted && exactMatch ? { inputSchema } : {}),
            ...(granted && exactMatch && params.includeOutputSchema === true ? { outputSchema } : {}),
          }
        })
        return { success: true, data: { workspaceId: deps.workspaceId, modules: catalogs.capabilities.modules, total: filtered.length, offset, returned: page.length, hasMore: offset + page.length < filtered.length, capabilities: page } }
      } catch (error) {
        return failure('workspace_capability_discovery_failed', error instanceof Error ? error.message : String(error))
      }
    },
  }

  const invoke: Tool = {
    name: 'workspace_invoke',
    description: 'Invoke one Capability or concurrently invoke a bounded batch of independent read-only Capabilities.',
    usage: 'Use one calls entry normally. Batch independent reads only; writes and destructive operations must be separate calls.',
    returns: '{ results[] } in request order, with each keyed entry carrying either data or a structured error.',
    parameters: {
      type: 'object', properties: {
        calls: { type: 'array', minItems: 1, maxItems: MAX_INVOKE_BATCH_SIZE, items: { type: 'object', properties: {
          key: { type: 'string', minLength: 1, maxLength: 64 }, capabilityId: { type: 'string' },
          definition: { type: 'object', properties: { moduleId: { type: 'string' }, type: { type: 'string' }, id: { type: 'string' }, revisionId: { type: 'string' } }, required: ['moduleId', 'type', 'id', 'revisionId'], additionalProperties: false },
          resource: { type: 'object', properties: { moduleId: { type: 'string' }, type: { type: 'string' }, id: { type: 'string' } }, required: ['moduleId', 'type', 'id'], additionalProperties: false },
          input: {}, expectedRevision: { type: 'integer', minimum: 0 }, idempotencyKey: { type: 'string', minLength: 1, maxLength: 256 },
        }, required: ['key', 'capabilityId', 'input'], additionalProperties: false } },
      }, required: ['calls'], additionalProperties: false,
    },
    execute: async (params, context) => {
      const grants = deps.getToolGrants(context.callerId)
      if (!grants) return failure('caller_not_ai_agent', 'Workspace Capability invocation requires an AI Agent Profile')
      if (!Array.isArray(params.calls) || params.calls.length < 1 || params.calls.length > MAX_INVOKE_BATCH_SIZE) return failure('invalid_tool_input', `calls must contain 1 to ${MAX_INVOKE_BATCH_SIZE} entries`)
      try {
        const catalogs = await readCatalogs(fetchImpl, workspacePath, context.signal)
        if ('success' in catalogs) return catalogs
        const parsed = params.calls.map((rawValue, index) => {
          if (!rawValue || typeof rawValue !== 'object' || Array.isArray(rawValue)) throw new Error(`calls[${index}] must be an object`)
          const raw = rawValue as Record<string, unknown>
          const capabilityId = capabilityIdSchema.parse(raw.capabilityId)
          const capability = catalogs.capabilities.capabilities.find(item => item.id === capabilityId)
          const resource = parseResource(raw.resource, deps.workspaceId)
          const resourceDescriptor = resource ? catalogs.resources.resources.find(item => referenceKey(item.ref) === referenceKey(resource)) : undefined
          let definition
          if (raw.definition !== undefined) {
            if (!raw.definition || typeof raw.definition !== 'object' || Array.isArray(raw.definition)) throw new Error(`calls[${index}].definition must be an object`)
            const value = raw.definition as Record<string, unknown>
            definition = { workspaceId: deps.workspaceId, moduleId: moduleIdSchema.parse(value.moduleId), type: definitionTypeSchema.parse(value.type), id: definitionIdSchema.parse(value.id), revisionId: definitionRevisionIdSchema.parse(value.revisionId) }
          }
          if (definition && resource) throw new Error(`calls[${index}] cannot contain both definition and resource`)
          return { key: String(raw.key), capabilityId, capability, resource, resourceDescriptor, definition, input: raw.input, expectedRevision: raw.expectedRevision, idempotencyKey: raw.idempotencyKey }
        })
        if (parsed.length > 1 && parsed.some(call => call.capability?.risk !== 'read')) return failure('batch_requires_read_capabilities', 'Only read Capabilities may be batched')
        const outcomes = await Promise.all(parsed.map(async call => {
          const denied = authorizationFailure(call.capability, call.resourceDescriptor, call.resource, grants, context, deps)
          if (denied) return { key: call.key, capabilityId: call.capabilityId, success: false, error: denied.error, details: denied.data }
          try {
            const response = await fetchImpl(`${workspacePath}/capabilities/${encodeURIComponent(call.capabilityId)}/invoke`, {
              method: 'POST', signal: requestSignal(context.signal), headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
              body: JSON.stringify({
                ...(call.definition ? { definition: call.definition } : {}), ...(call.resource ? { resource: call.resource } : {}),
                ...(call.expectedRevision === undefined ? {} : { expectedRevision: call.expectedRevision }),
                ...(call.idempotencyKey === undefined ? {} : { idempotencyKey: call.idempotencyKey }),
                input: call.input, actor: { kind: 'ai', id: context.callerId, displayName: context.callerName },
              }),
            })
            if (!response.ok) {
              const result = await readHostError(response)
              return { key: call.key, capabilityId: call.capabilityId, success: false, error: result.error, details: result.data }
            }
            const body = await response.json() as { result?: unknown }
            if (!Object.hasOwn(body, 'result')) return { key: call.key, capabilityId: call.capabilityId, success: false, error: 'workspace_host_contract_invalid: Workspace Host response omitted result' }
            return { key: call.key, capabilityId: call.capabilityId, success: true, data: body.result }
          } catch (error) {
            return { key: call.key, capabilityId: call.capabilityId, success: false, error: `workspace_outcome_unknown: ${error instanceof Error ? error.message : String(error)}` }
          }
        }))
        return { success: true, data: { results: outcomes } }
      } catch (error) {
        return failure('invalid_tool_input', error instanceof Error ? error.message : String(error))
      }
    },
  }

  return [catalog, capabilities, invoke]
}
