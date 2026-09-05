import {
  capabilityIdSchema,
  definitionTypeSchema,
  isExactToolGrant,
  moduleIdSchema,
  resourceTypeSchema,
  workspaceCapabilityCatalogSchema,
  workspaceDefinitionRevisionReferenceSchema,
  workspaceDefinitionCatalogSchema,
  workspaceResourceReferenceSchema,
  workspaceResourceCatalogSchema,
  type ModuleCapabilityDescriptor,
  type ModuleDefinitionDescriptor,
  type ModuleResourceDescriptor,
  type ToolGrant,
  type WorkspaceDefinitionRevisionReference,
  type WorkspaceId,
  type WorkspaceResourceReference,
  type WorkspaceResourceSubjectSelection,
} from '@leitbild/contracts'
import type { Tool, ToolContext, ToolResult } from '../../core/types/tool.ts'

export interface WorkspaceCapabilityToolsDeps {
  readonly workspaceId: WorkspaceId
  readonly hostBaseUrl: string
  readonly getToolGrants: (agentId: string) => ReadonlyArray<ToolGrant> | undefined
  readonly getRoomSubjectSelection: (roomId: string) => WorkspaceResourceSubjectSelection | undefined
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
const referenceKey = (ref: { workspaceId?: string; moduleId: string; type: string; id: string }): string =>
  `${ref.workspaceId ?? ''}:${ref.moduleId}:${ref.type}:${ref.id}`
const sameResource = (left: WorkspaceResourceReference, right: WorkspaceResourceReference): boolean =>
  left.workspaceId === right.workspaceId
  && left.moduleId === right.moduleId
  && left.type === right.type
  && left.id === right.id

const getJson = async (fetchImpl: typeof fetch, url: string, signal?: AbortSignal): Promise<Response> => {
  try {
    return await fetchImpl(url, { signal: requestSignal(signal), headers: { Accept: 'application/json' } })
  } catch (error) {
    throw new Error(`Workspace Host is unreachable: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }
}

const catalogPath = (workspacePath: string, kind: 'capabilities' | 'definitions' | 'resources', moduleId?: string): string =>
  `${workspacePath}/${kind}${moduleId === undefined ? '' : `?moduleId=${encodeURIComponent(moduleId)}`}`

type WorkspaceCapabilityTarget =
  | { readonly kind: 'resource'; readonly ref: WorkspaceResourceReference }
  | { readonly kind: 'definition'; readonly ref: WorkspaceDefinitionRevisionReference }

const parseTarget = (value: unknown, workspaceId: WorkspaceId): WorkspaceCapabilityTarget | undefined => {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('target must be one complete exact target copied from workspace_catalog')
  }
  const raw = value as Record<string, unknown>
  if (raw.kind !== 'resource' && raw.kind !== 'definition') {
    throw new Error('target.kind must be resource or definition')
  }
  const result = raw.kind === 'resource'
    ? workspaceResourceReferenceSchema.safeParse(raw.ref)
    : workspaceDefinitionRevisionReferenceSchema.safeParse(raw.ref)
  if (!result.success || Object.keys(raw).some(key => !['kind', 'ref'].includes(key))) {
    throw new Error('target must be one complete exact target copied from workspace_catalog')
  }
  if (result.data.workspaceId !== workspaceId) throw new Error('target belongs to another Workspace')
  return raw.kind === 'resource'
    ? { kind: 'resource', ref: result.data as WorkspaceResourceReference }
    : { kind: 'definition', ref: result.data as WorkspaceDefinitionRevisionReference }
}

const subjectGrantAllows = (grants: ReadonlyArray<ToolGrant>, risk: ModuleCapabilityDescriptor['risk']): boolean =>
  risk !== 'destructive' && grants.some(grant => !isExactToolGrant(grant) && grant.scope === 'room-subject' && grant.risks.includes(risk))

const selectedSubjectReferences = (
  selection: WorkspaceResourceSubjectSelection,
  resources: ReadonlyArray<ModuleResourceDescriptor>,
): ReadonlyArray<WorkspaceResourceReference> => {
  if (selection.kind === 'resource') return [selection.resource]
  const collection = resources.find(item => referenceKey(item.ref) === referenceKey(selection.collection))
  const membersByKey = new Map<string, WorkspaceResourceReference>()
  for (const member of collection?.links.filter(link => link.rel === 'contains').map(link => link.ref) ?? []) {
    membersByKey.set(referenceKey(member), member)
  }
  // Accept either catalog direction. Collections normally publish `contains`,
  // while a member may independently publish `member-of`; resolving both
  // avoids making Agent authority depend on response ordering or one-sided
  // relationship materialization.
  for (const resource of resources) {
    if (resource.links.some(link => link.rel === 'member-of' && referenceKey(link.ref) === referenceKey(selection.collection))) {
      membersByKey.set(referenceKey(resource.ref), resource.ref)
    }
  }
  const members = [...membersByKey.values()]
  if (selection.members.mode === 'selected') {
    const selected = new Set(selection.members.only.map(referenceKey))
    return members.filter(member => selected.has(referenceKey(member)))
  }
  const excluded = new Set(selection.members.except.map(referenceKey))
  return members.filter(member => !excluded.has(referenceKey(member)))
}

const authorityFailure = (
  capability: ModuleCapabilityDescriptor | undefined,
  resource: WorkspaceResourceReference | undefined,
  grants: ReadonlyArray<ToolGrant>,
  context: ToolContext,
  deps: WorkspaceCapabilityToolsDeps,
  catalogResources: ReadonlyArray<ModuleResourceDescriptor>,
): ToolResult | undefined => {
  if (!capability) return failure('capability_not_advertised', 'The Workspace does not advertise this Capability')
  if (grants.some(grant => isExactToolGrant(grant) && grant.capabilityId === capability.id)) return undefined
  // A Room-subject grant is deliberately Resource-scoped. Workspace and
  // Definition Capabilities need an exact grant; otherwise an unrelated Room
  // selection would accidentally become authority over non-Resource targets.
  if (capability.scope.kind !== 'resource') {
    return failure('capability_not_granted', `Agent ${context.callerName} is not granted ${capability.id}`, { capabilityId: capability.id, risk: capability.risk })
  }
  if (!subjectGrantAllows(grants, capability.risk)) return failure('capability_not_granted', `Agent ${context.callerName} is not granted ${capability.id}`, { capabilityId: capability.id, risk: capability.risk })
  if (!context.roomId) return failure('room_context_required', 'A Room-subject grant requires a current Room')
  const selection = deps.getRoomSubjectSelection(context.roomId)
  if (!selection) return failure('room_subject_required', 'The current Room has no Subject Selection')
  const selected = selectedSubjectReferences(selection, catalogResources)
  if (!resource || !selected.some(candidate => sameResource(candidate, resource))) {
    return failure('target_not_selected', 'The requested Resource is not selected for the current Room', { selection, requestedResource: resource, resolvedSubjects: selected })
  }
  return undefined
}

const compactFailure = (result: ToolResult): { code: string; message: string } => {
  const data = result.data as { code?: unknown } | undefined
  const code = typeof data?.code === 'string' ? data.code : 'capability_unavailable'
  const prefix = `${code}: `
  return { code, message: result.error?.startsWith(prefix) ? result.error.slice(prefix.length) : result.error ?? 'Capability unavailable' }
}

const compactDefinition = (definition: ModuleDefinitionDescriptor) => {
  const {
    ref,
    currentRevisionId,
    capabilityIds,
    deleteCapabilityId: _deleteCapabilityId,
    ...descriptor
  } = definition
  return { ...descriptor, target: { kind: 'definition', ref: { ...ref, revisionId: currentRevisionId } }, capabilityCount: capabilityIds.length }
}

const compactResource = (resource: ModuleResourceDescriptor) => {
  const {
    ref,
    capabilityIds,
    deleteCapabilityId: _deleteCapabilityId,
    renameCapabilityId: _renameCapabilityId,
    ...descriptor
  } = resource
  return { ...descriptor, target: { kind: 'resource', ref }, capabilityCount: capabilityIds.length }
}

const resourceReferenceParameter = {
  type: 'object',
  description: 'The exact Resource reference inside a target returned by workspace_catalog.',
  properties: {
    workspaceId: { type: 'string' }, moduleId: { type: 'string' }, type: { type: 'string' }, id: { type: 'string' },
  },
  required: ['workspaceId', 'moduleId', 'type', 'id'],
  additionalProperties: false,
}

const definitionReferenceParameter = {
  type: 'object',
  description: 'The exact Definition revision reference inside a target returned by workspace_catalog.',
  properties: {
    workspaceId: { type: 'string' }, moduleId: { type: 'string' }, type: { type: 'string' }, id: { type: 'string' }, revisionId: { type: 'string' },
  },
  required: ['workspaceId', 'moduleId', 'type', 'id', 'revisionId'],
  additionalProperties: false,
}

const targetParameter = {
  description: 'One exact Resource or Definition-revision target copied verbatim from workspace_catalog. Never combine targets or use wildcards.',
  oneOf: [{
    type: 'object',
    properties: { kind: { type: 'string', const: 'resource' }, ref: resourceReferenceParameter },
    required: ['kind', 'ref'],
    additionalProperties: false,
  }, {
    type: 'object',
    properties: { kind: { type: 'string', const: 'definition' }, ref: definitionReferenceParameter },
    required: ['kind', 'ref'],
    additionalProperties: false,
  }],
}

const applicabilityFailure = (
  capability: ModuleCapabilityDescriptor | undefined,
  resourceDescriptor: ModuleResourceDescriptor | undefined,
  resource: WorkspaceResourceReference | undefined,
  definitionDescriptor: ModuleDefinitionDescriptor | undefined,
  definition: WorkspaceDefinitionRevisionReference | undefined,
): ToolResult | undefined => {
  if (!capability) return failure('capability_not_advertised', 'The Workspace does not advertise this Capability')
  if (capability.scope.kind === 'workspace') {
    if (resource || definition) return failure('capability_scope_mismatch', 'This Workspace Capability does not accept a Resource or Definition target')
    return undefined
  }
  if (capability.scope.kind === 'resource') {
    if (!resource) return failure('resource_required', 'This Capability requires an exact Resource target')
    if (definition) return failure('capability_scope_mismatch', 'A Resource Capability cannot target a Definition')
    if (!resourceDescriptor) return failure('resource_not_found', 'The target Resource is not advertised by the Workspace')
    if (!resourceDescriptor.capabilityIds.includes(capability.id)) {
      return failure('capability_not_advertised', 'The target Resource does not advertise this Capability', { capabilityId: capability.id })
    }
    if (capability.scope.resourceType !== resource.type) {
      return failure('capability_scope_mismatch', 'The Capability does not apply to this Resource type')
    }
    return undefined
  }
  if (!definition) return failure('definition_required', 'This Capability requires an exact Definition revision target')
  if (resource) return failure('capability_scope_mismatch', 'A Definition Capability cannot target a Resource')
  if (!definitionDescriptor) return failure('definition_not_found', 'The target Definition is not advertised by the Workspace')
  if (definitionDescriptor.currentRevisionId !== definition.revisionId) {
    return failure('definition_revision_not_found', 'The requested Definition revision is not current or discoverable')
  }
  if (!definitionDescriptor.capabilityIds.includes(capability.id)) {
    return failure('capability_not_advertised', 'The target Definition does not advertise this Capability', { capabilityId: capability.id })
  }
  if (capability.scope.definitionType !== definition.type) {
    return failure('capability_scope_mismatch', 'The Capability does not apply to this Definition type')
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
    description: 'Discover current or Workspace-wide Definitions and Resources, including the current Room Subject Selection and focused subjects.',
    usage: 'Use scope=current for compact orientation. Use scope=workspace with filters and pagination only when broader discovery is relevant.',
    returns: 'Compact references, links, summaries, capability counts, totals, and pagination metadata. Use workspace_capabilities to discover operations.',
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
        const roomResourceRequest = scope === 'current' && context.roomId !== undefined && moduleId !== undefined && moduleId !== 'agents'
          ? getJson(fetchImpl, catalogPath(workspacePath, 'resources', 'agents'), context.signal)
          : Promise.resolve<Response | null>(null)
        const [definitionResponse, resourceResponse, roomResourceResponse] = await Promise.all([
          getJson(fetchImpl, catalogPath(workspacePath, 'definitions', moduleId), context.signal),
          getJson(fetchImpl, catalogPath(workspacePath, 'resources', moduleId), context.signal),
          roomResourceRequest,
        ])
        if (!definitionResponse.ok) return await readHostError(definitionResponse)
        if (!resourceResponse.ok) return await readHostError(resourceResponse)
        if (roomResourceResponse !== null && !roomResourceResponse.ok) return await readHostError(roomResourceResponse)
        const definitionCatalog = workspaceDefinitionCatalogSchema.parse(await definitionResponse.json())
        const resourceCatalog = workspaceResourceCatalogSchema.parse(await resourceResponse.json())
        const roomResources = roomResourceResponse === null
          ? resourceCatalog.resources
          : workspaceResourceCatalogSchema.parse(await roomResourceResponse.json()).resources
        const currentRoom = roomResources.find(resource => resource.ref.type === 'agents.room' && resource.ref.id === context.roomId) ?? null
        const currentKeys = new Set<string>([
          ...(context.focusedSubjects ?? []).map(referenceKey),
          ...(currentRoom?.links ?? [])
            .filter(link => ['subject', 'subject-collection', 'source-definition'].includes(link.rel))
            .map(link => referenceKey(link.ref)),
          ...(context.roomId === undefined ? [] : (() => {
            const selection = deps.getRoomSubjectSelection(context.roomId)
            return selection === undefined ? [] : selectedSubjectReferences(selection, resourceCatalog.resources).map(referenceKey)
          })()),
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
          workspaceId: deps.workspaceId, focusedSubjects: context.focusedSubjects ?? [], currentRoom: currentRoom === null ? null : compactResource(currentRoom),
          modules: { definitions: definitionCatalog.modules, resources: resourceCatalog.modules },
          total: combined.length, offset, returned: page.length, hasMore: offset + page.length < combined.length,
          definitions: page.filter(item => item.kind === 'definition').map(item => compactDefinition(item.value)),
          resources: page.filter(item => item.kind === 'resource').map(item => compactResource(item.value)),
        } }
      } catch (error) {
        return failure('workspace_catalog_discovery_failed', error instanceof Error ? error.message : String(error))
      }
    },
  }

  const capabilities: Tool = {
    name: 'workspace_capabilities',
    description: 'Search Capability descriptions or evaluate Capabilities against one exact Resource or Definition revision.',
    usage: 'For broad discovery, omit target; discovery does not decide target-specific access. For target evaluation or schemas, copy one complete target from workspace_catalog verbatim. Never use wildcards in a target. Authorization answers what the Agent may do; applicability answers whether the Capability fits the target.',
    returns: 'Capability descriptors and pagination metadata. Untargeted Resource/Definition results say targetRequired without claiming denial. Exact-target results report authorized, applicable, callable, and structured blockers.',
    parameters: {
      type: 'object', properties: {
        target: targetParameter,
        moduleId: { type: 'string', description: 'Optional exact Module id filter. Omit or use "*" to search all Modules.' }, queries: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 256 }, maxItems: 8 },
        capabilityIds: { type: 'array', items: { type: 'string' }, maxItems: 24 },
        risk: { type: 'string', enum: ['read', 'write', 'destructive'] }, kind: { type: 'string', enum: ['query', 'command'] },
        includeOutputSchema: { type: 'boolean', default: false }, offset: { type: 'integer', minimum: 0, default: 0 }, limit: { type: 'integer', minimum: 1, maximum: MAX_DISCOVERY_PAGE_SIZE, default: DEFAULT_DISCOVERY_PAGE_SIZE },
      }, additionalProperties: false,
    },
    execute: async (params, context) => {
      const grants = deps.getToolGrants(context.callerId)
      if (!grants) return failure('caller_not_ai_agent', 'Workspace Capability discovery requires an AI Agent Profile')

      let moduleId: ReturnType<typeof moduleIdSchema.parse> | undefined
      let resource: WorkspaceResourceReference | undefined
      let definition: WorkspaceDefinitionRevisionReference | undefined
      let ids: ReadonlyArray<ReturnType<typeof capabilityIdSchema.parse>>
      let queries: ReadonlyArray<string>
      let risk: string | undefined
      let kind: string | undefined
      let offset: number
      let limit: number
      try {
        moduleId = optionalFilter(params.moduleId) === undefined ? undefined : moduleIdSchema.parse(params.moduleId)
        const target = parseTarget(params.target, deps.workspaceId)
        resource = target?.kind === 'resource' ? target.ref : undefined
        definition = target?.kind === 'definition' ? target.ref : undefined
        if (moduleId !== undefined && resource !== undefined && resource.moduleId !== moduleId) return failure('invalid_tool_input', 'moduleId does not match the Resource target')
        if (moduleId !== undefined && definition !== undefined && definition.moduleId !== moduleId) return failure('invalid_tool_input', 'moduleId does not match the Definition target')
        ids = Array.isArray(params.capabilityIds) ? params.capabilityIds.map(value => capabilityIdSchema.parse(value)) : []
        if (moduleId !== undefined && ids.some(id => !id.startsWith(`${moduleId}.`))) return failure('invalid_tool_input', 'moduleId does not match every requested Capability id')
        queries = Array.isArray(params.queries) ? params.queries.map(value => String(value).trim()).filter(Boolean) : []
        risk = optionalFilter(params.risk) as string | undefined
        kind = optionalFilter(params.kind) as string | undefined
        if (risk !== undefined && !['read', 'write', 'destructive'].includes(risk)) return failure('invalid_tool_input', 'risk must be read, write, or destructive')
        if (kind !== undefined && !['query', 'command'].includes(kind)) return failure('invalid_tool_input', 'kind must be query or command')
        offset = params.offset === undefined ? 0 : Number(params.offset)
        limit = params.limit === undefined ? DEFAULT_DISCOVERY_PAGE_SIZE : Number(params.limit)
        if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > MAX_DISCOVERY_PAGE_SIZE) return failure('invalid_tool_input', 'Invalid pagination')
      } catch (error) {
        return failure('invalid_tool_input', error instanceof Error ? error.message : String(error))
      }

      try {
        const [capabilityResponse, targetResponse] = await Promise.all([
          getJson(fetchImpl, catalogPath(workspacePath, 'capabilities', moduleId), context.signal),
          resource !== undefined
            ? getJson(fetchImpl, catalogPath(workspacePath, 'resources'), context.signal)
            : definition !== undefined
              ? getJson(fetchImpl, catalogPath(workspacePath, 'definitions', definition.moduleId), context.signal)
              : Promise.resolve<Response | null>(null),
        ])
        if (!capabilityResponse.ok) return await readHostError(capabilityResponse)
        if (targetResponse !== null && !targetResponse.ok) return await readHostError(targetResponse)
        const capabilityCatalog = workspaceCapabilityCatalogSchema.parse(await capabilityResponse.json())
        const resourceCatalog = resource === undefined
          ? undefined
          : workspaceResourceCatalogSchema.parse(await targetResponse!.json())
        const definitionCatalog = definition === undefined
          ? undefined
          : workspaceDefinitionCatalogSchema.parse(await targetResponse!.json())
        const resourceDescriptor = resource === undefined
          ? undefined
          : resourceCatalog?.resources.find(item => referenceKey(item.ref) === referenceKey(resource))
        const definitionDescriptor = definition === undefined
          ? undefined
          : definitionCatalog?.definitions.find(item =>
              item.ref.moduleId === definition!.moduleId
              && item.ref.type === definition!.type
              && item.ref.id === definition!.id)
        if (resource !== undefined && resourceDescriptor === undefined) return failure('resource_not_found', 'The exact Resource target is not advertised by the Workspace')
        if (definition !== undefined && definitionDescriptor === undefined) return failure('definition_not_found', 'The exact Definition target is not advertised by the Workspace')

        const exact = new Set(ids)
        const relevance = (capability: ModuleCapabilityDescriptor): number =>
          queries.reduce((score, query) => Math.max(score, textMatchScore(capability, query)), 0)
        const noSelector = ids.length === 0 && queries.length === 0
        const advertisedIds = new Set(resourceDescriptor?.capabilityIds ?? definitionDescriptor?.capabilityIds ?? [])
        const filtered = capabilityCatalog.capabilities.filter(capability =>
          (moduleId === undefined || capability.moduleId === moduleId) &&
          (noSelector || exact.has(capability.id) || relevance(capability) > 0) &&
          (risk === undefined || capability.risk === risk) && (kind === undefined || capability.kind === kind) &&
          (resource === undefined && definition === undefined || advertisedIds.has(capability.id) || exact.has(capability.id)))
          .sort((left, right) =>
            Number(exact.has(right.id)) - Number(exact.has(left.id)) ||
            relevance(right) - relevance(left) ||
            left.id.localeCompare(right.id))
        const page = filtered.slice(offset, offset + limit).map(capability => {
          const { inputSchema, outputSchema, ...compact } = capability
          const exactMatch = exact.has(capability.id)
          const evaluate = resource !== undefined || definition !== undefined || capability.scope.kind === 'workspace'
          if (!evaluate) {
            return {
              ...compact,
              targetRequired: true,
              ...(queries.length > 0 ? { matchedQueries: queries.filter(query => textMatchScore(capability, query) > 0) } : {}),
            }
          }
          const authorityIssue = authorityFailure(capability, resource, grants, context, deps, resourceCatalog?.resources ?? [])
          const applicabilityIssue = applicabilityFailure(capability, resourceDescriptor, resource, definitionDescriptor, definition)
          const authorized = authorityIssue === undefined
          const applicable = applicabilityIssue === undefined
          const callable = authorized && applicable
          const blockers = [authorityIssue, applicabilityIssue].filter((issue): issue is ToolResult => issue !== undefined).map(compactFailure)
          return {
            ...compact, authorized, applicable, callable,
            ...(blockers.length > 0 ? { blockers } : {}),
            ...(queries.length > 0 ? { matchedQueries: queries.filter(query => textMatchScore(capability, query) > 0) } : {}),
            ...(callable && exactMatch ? { inputSchema } : {}),
            ...(callable && exactMatch && params.includeOutputSchema === true ? { outputSchema } : {}),
          }
        })
        const knownCapabilityIds = new Set(capabilityCatalog.capabilities.map(capability => capability.id))
        const unknownCapabilityIds = ids.filter(id => !knownCapabilityIds.has(id))
        return { success: true, data: {
          workspaceId: deps.workspaceId,
          mode: resource !== undefined ? 'resource' : definition !== undefined ? 'definition' : 'discovery',
          ...(resource !== undefined ? { target: { kind: 'resource', ref: resource } } : {}),
          ...(definition !== undefined ? { target: { kind: 'definition', ref: definition } } : {}),
          modules: capabilityCatalog.modules,
          total: filtered.length, offset, returned: page.length, hasMore: offset + page.length < filtered.length,
          ...(unknownCapabilityIds.length > 0 ? { unknownCapabilityIds } : {}),
          capabilities: page,
        } }
      } catch (error) {
        return failure('workspace_capability_discovery_failed', error instanceof Error ? error.message : String(error))
      }
    },
  }

  const invoke: Tool = {
    name: 'workspace_invoke',
    description: 'Invoke one Capability or concurrently invoke a bounded batch of independent read-only Capabilities.',
    usage: 'Copy one exact target from workspace_catalog unchanged. Omit target only for a Workspace-scoped Capability. Use one calls entry normally. Batch independent reads only; writes and destructive operations must be separate calls.',
    returns: '{ results[] } in request order, with each keyed entry carrying either data or a structured error.',
    parameters: {
      type: 'object', properties: {
        calls: { type: 'array', minItems: 1, maxItems: MAX_INVOKE_BATCH_SIZE, items: { type: 'object', properties: {
          key: { type: 'string', minLength: 1, maxLength: 64 }, capabilityId: { type: 'string' },
          target: targetParameter,
          input: {}, expectedRevision: { type: 'integer', minimum: 0 }, idempotencyKey: { type: 'string', minLength: 1, maxLength: 256 },
        }, required: ['key', 'capabilityId', 'input'], additionalProperties: false } },
      }, required: ['calls'], additionalProperties: false,
    },
    execute: async (params, context) => {
      const grants = deps.getToolGrants(context.callerId)
      if (!grants) return failure('caller_not_ai_agent', 'Workspace Capability invocation requires an AI Agent Profile')
      if (!Array.isArray(params.calls) || params.calls.length < 1 || params.calls.length > MAX_INVOKE_BATCH_SIZE) return failure('invalid_tool_input', `calls must contain 1 to ${MAX_INVOKE_BATCH_SIZE} entries`)
      try {
        const inputs = params.calls.map((rawValue, index) => {
          if (!rawValue || typeof rawValue !== 'object' || Array.isArray(rawValue)) throw new Error(`calls[${index}] must be an object`)
          const raw = rawValue as Record<string, unknown>
          const capabilityId = capabilityIdSchema.parse(raw.capabilityId)
          const target = parseTarget(raw.target, deps.workspaceId)
          const resource = target?.kind === 'resource' ? target.ref : undefined
          const definition = target?.kind === 'definition' ? target.ref : undefined
          return { key: String(raw.key), capabilityId, resource, definition, input: raw.input, expectedRevision: raw.expectedRevision, idempotencyKey: raw.idempotencyKey }
        })

        const needsResources = inputs.some(call => call.resource !== undefined)
        const needsDefinitions = inputs.some(call => call.definition !== undefined)
        const [capabilityResponse, resourceResponse, definitionResponse] = await Promise.all([
          getJson(fetchImpl, catalogPath(workspacePath, 'capabilities'), context.signal),
          needsResources ? getJson(fetchImpl, catalogPath(workspacePath, 'resources'), context.signal) : Promise.resolve<Response | null>(null),
          needsDefinitions ? getJson(fetchImpl, catalogPath(workspacePath, 'definitions'), context.signal) : Promise.resolve<Response | null>(null),
        ])
        if (!capabilityResponse.ok) return await readHostError(capabilityResponse)
        if (resourceResponse !== null && !resourceResponse.ok) return await readHostError(resourceResponse)
        if (definitionResponse !== null && !definitionResponse.ok) return await readHostError(definitionResponse)
        const capabilityCatalog = workspaceCapabilityCatalogSchema.parse(await capabilityResponse.json())
        const resourceCatalog = resourceResponse === null
          ? undefined
          : workspaceResourceCatalogSchema.parse(await resourceResponse.json())
        const definitionCatalog = definitionResponse === null
          ? undefined
          : workspaceDefinitionCatalogSchema.parse(await definitionResponse.json())
        const parsed = inputs.map(call => ({
          ...call,
          capability: capabilityCatalog.capabilities.find(item => item.id === call.capabilityId),
          resourceDescriptor: call.resource === undefined
            ? undefined
            : resourceCatalog?.resources.find(item => referenceKey(item.ref) === referenceKey(call.resource!)),
          definitionDescriptor: call.definition === undefined
            ? undefined
            : definitionCatalog?.definitions.find(item =>
                item.ref.moduleId === call.definition!.moduleId
                && item.ref.type === call.definition!.type
                && item.ref.id === call.definition!.id),
        }))
        if (parsed.length > 1 && parsed.some(call => call.capability?.risk !== 'read')) return failure('batch_requires_read_capabilities', 'Only read Capabilities may be batched')
        const outcomes = await Promise.all(parsed.map(async call => {
          const denied = authorityFailure(call.capability, call.resource, grants, context, deps, resourceCatalog?.resources ?? [])
            ?? applicabilityFailure(call.capability, call.resourceDescriptor, call.resource, call.definitionDescriptor, call.definition)
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
