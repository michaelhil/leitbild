import {
  capabilityIdSchema,
  definitionTypeSchema,
  moduleIdSchema,
  resourceTypeSchema,
  workspaceCapabilityCatalogSchema,
  workspaceDefinitionCatalogSchema,
  workspaceDefinitionRevisionReferenceSchema,
  workspaceResourceCatalogSchema,
  workspaceResourceReferenceSchema,
  type ModuleCapabilityDescriptor,
  type ModuleDefinitionDescriptor,
  type ModuleResourceDescriptor,
  type WorkspaceDefinitionRevisionReference,
  type WorkspaceId,
  type WorkspaceResourceReference,
  type WorkspaceRoomScope,
} from '@leitbild/contracts'
import type { Tool, ToolContext, ToolResult } from '../../core/types/tool.ts'

export interface WorkspaceCapabilityToolsDeps {
  readonly workspaceId: WorkspaceId
  readonly hostBaseUrl: string
  readonly getRoomScope: (roomId: string) => WorkspaceRoomScope | undefined
  readonly fetchImpl?: typeof fetch
}

export const WORKSPACE_CAPABILITY_TOOL_NAMES = ['workspace_explore', 'workspace_call'] as const

// Transport and context safeguards, not a behavioral quota. Agents decide how
// much evidence a task needs; Pack-owned operations own domain pagination.
const HOST_REQUEST_TIMEOUT_MS = 30_000
const DEFAULT_PAGE_SIZE = 30
const MAX_PAGE_SIZE = 100
const MAX_READ_BATCH_SIZE = 12

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

const requestSignal = (signal?: AbortSignal): AbortSignal =>
  AbortSignal.any([AbortSignal.timeout(HOST_REQUEST_TIMEOUT_MS), ...(signal ? [signal] : [])])

const getJson = async (fetchImpl: typeof fetch, url: string, signal?: AbortSignal): Promise<Response> => {
  try {
    return await fetchImpl(url, { signal: requestSignal(signal), headers: { Accept: 'application/json' } })
  } catch (error) {
    throw new Error(`Workspace Host is unreachable: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }
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

const optionalFilter = (value: unknown): unknown =>
  typeof value === 'string' && (value.trim().length === 0 || value.trim() === '*') ? undefined : value

const referenceKey = (ref: { workspaceId?: string; moduleId: string; type: string; id: string }): string =>
  `${ref.workspaceId ?? ''}:${ref.moduleId}:${ref.type}:${ref.id}`

type WorkspaceTarget =
  | { readonly kind: 'resource'; readonly ref: WorkspaceResourceReference }
  | { readonly kind: 'definition'; readonly ref: WorkspaceDefinitionRevisionReference }

const parseTarget = (value: unknown, workspaceId: WorkspaceId): WorkspaceTarget | undefined => {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('target must be one exact target returned by workspace_explore')
  const raw = value as Record<string, unknown>
  if (raw.kind !== 'resource' && raw.kind !== 'definition') throw new Error('target.kind must be resource or definition')
  if (Object.keys(raw).some(key => !['kind', 'ref'].includes(key))) throw new Error('target must be one exact target returned by workspace_explore')
  const parsed = raw.kind === 'resource'
    ? workspaceResourceReferenceSchema.parse(raw.ref)
    : workspaceDefinitionRevisionReferenceSchema.parse(raw.ref)
  if (parsed.workspaceId !== workspaceId) throw new Error('target belongs to another Workspace')
  return raw.kind === 'resource'
    ? { kind: 'resource', ref: parsed as WorkspaceResourceReference }
    : { kind: 'definition', ref: parsed as WorkspaceDefinitionRevisionReference }
}

const selectedCollectionMembers = (
  scope: Extract<WorkspaceRoomScope, { kind: 'collection' }>,
  resources: ReadonlyArray<ModuleResourceDescriptor>,
): ReadonlyArray<WorkspaceResourceReference> => {
  const collectionKey = referenceKey(scope.collection)
  const collection = resources.find(resource => referenceKey(resource.ref) === collectionKey)
  const members = new Map<string, WorkspaceResourceReference>()
  for (const link of collection?.links ?? []) if (link.rel === 'contains') members.set(referenceKey(link.ref), link.ref)
  for (const resource of resources) {
    if (resource.links.some(link => link.rel === 'member-of' && referenceKey(link.ref) === collectionKey)) {
      members.set(referenceKey(resource.ref), resource.ref)
    }
  }
  if (scope.members.mode === 'selected') {
    const selected = new Set(scope.members.only.map(referenceKey))
    return [...members.values()].filter(member => selected.has(referenceKey(member)))
  }
  const excluded = new Set(scope.members.except.map(referenceKey))
  return [...members.values()].filter(member => !excluded.has(referenceKey(member)))
}

interface ResolvedScope {
  readonly scope: WorkspaceRoomScope
  readonly resources: ReadonlyArray<ModuleResourceDescriptor>
  readonly definitions: ReadonlyArray<ModuleDefinitionDescriptor>
  readonly resourceKeys: ReadonlySet<string>
  readonly definitionKeys: ReadonlySet<string>
}

const resolveScope = (
  scope: WorkspaceRoomScope,
  resources: ReadonlyArray<ModuleResourceDescriptor>,
  definitions: ReadonlyArray<ModuleDefinitionDescriptor>,
): ResolvedScope => {
  if (scope.kind === 'workspace') {
    return {
      scope,
      resources,
      definitions,
      resourceKeys: new Set(resources.map(resource => referenceKey(resource.ref))),
      definitionKeys: new Set(definitions.map(definition => referenceKey(definition.ref))),
    }
  }
  const references = scope.kind === 'resource'
    ? [scope.resource]
    : [scope.collection, ...selectedCollectionMembers(scope, resources)]
  const resourceKeys = new Set(references.map(referenceKey))
  const scopedResources = resources.filter(resource => resourceKeys.has(referenceKey(resource.ref)))
  const definitionKeys = new Set(scopedResources.flatMap(resource => resource.sourceDefinition ? [referenceKey(resource.sourceDefinition)] : []))
  return {
    scope,
    resources: scopedResources,
    definitions: definitions.filter(definition => definitionKeys.has(referenceKey(definition.ref))),
    resourceKeys,
    definitionKeys,
  }
}

const requireRoomScope = (context: ToolContext, deps: WorkspaceCapabilityToolsDeps): WorkspaceRoomScope | ToolResult => {
  if (!context.roomId) return failure('room_context_required', 'Workspace access requires a current Room')
  return deps.getRoomScope(context.roomId) ?? failure('room_scope_unavailable', 'The current Room has no valid scope')
}

const isToolResult = (value: WorkspaceRoomScope | ToolResult): value is ToolResult => 'success' in value

const targetInScope = (target: WorkspaceTarget | undefined, resolved: ResolvedScope): ToolResult | undefined => {
  if (target === undefined) return resolved.scope.kind === 'workspace'
    ? undefined
    : failure('workspace_operation_out_of_scope', 'This Room is scoped to Resources, not the whole Workspace')
  const allowed = target.kind === 'resource'
    ? resolved.resourceKeys.has(referenceKey(target.ref))
    : resolved.definitionKeys.has(referenceKey(target.ref))
  return allowed ? undefined : failure('target_out_of_scope', 'The requested target is outside the current Room Scope', { target, scope: resolved.scope })
}

const applicabilityFailure = (
  operation: ModuleCapabilityDescriptor | undefined,
  target: WorkspaceTarget | undefined,
  resources: ReadonlyArray<ModuleResourceDescriptor>,
  definitions: ReadonlyArray<ModuleDefinitionDescriptor>,
): ToolResult | undefined => {
  if (!operation) return failure('operation_not_advertised', 'The Workspace does not advertise this operation')
  if (operation.scope.kind === 'workspace') return target === undefined
    ? undefined
    : failure('operation_scope_mismatch', 'This Workspace operation does not accept a target')
  if (target === undefined) return failure('target_required', 'This operation requires an exact target')
  if (operation.scope.kind !== target.kind) return failure('operation_scope_mismatch', `This operation requires a ${operation.scope.kind} target`)
  if (target.kind === 'resource') {
    const descriptor = resources.find(resource => referenceKey(resource.ref) === referenceKey(target.ref))
    if (!descriptor) return failure('resource_not_found', 'The target Resource is not advertised by the Workspace')
    if (operation.scope.kind !== 'resource' || operation.scope.resourceType !== target.ref.type || !descriptor.capabilityIds.includes(operation.id)) {
      return failure('operation_not_available', 'The target Resource does not advertise this operation')
    }
    return undefined
  }
  const descriptor = definitions.find(definition => referenceKey(definition.ref) === referenceKey(target.ref))
  if (!descriptor) return failure('definition_not_found', 'The target Definition is not advertised by the Workspace')
  if (descriptor.currentRevisionId !== target.ref.revisionId) return failure('definition_revision_not_found', 'The exact Definition revision is not current or discoverable')
  if (operation.scope.kind !== 'definition' || operation.scope.definitionType !== target.ref.type || !descriptor.capabilityIds.includes(operation.id)) {
    return failure('operation_not_available', 'The target Definition does not advertise this operation')
  }
  return undefined
}

const compactDefinition = (definition: ModuleDefinitionDescriptor) => {
  const { ref, currentRevisionId, capabilityIds, deleteCapabilityId: _deleteCapabilityId, ...descriptor } = definition
  return { ...descriptor, target: { kind: 'definition', ref: { ...ref, revisionId: currentRevisionId } }, operationCount: capabilityIds.length }
}

const compactResource = (resource: ModuleResourceDescriptor) => {
  const { ref, capabilityIds, deleteCapabilityId: _deleteCapabilityId, renameCapabilityId: _renameCapabilityId, ...descriptor } = resource
  return { ...descriptor, target: { kind: 'resource', ref }, operationCount: capabilityIds.length }
}

const textTerms = (value: string): ReadonlyArray<string> =>
  [...new Set(value.toLowerCase().match(/[\p{L}\p{N}]+/gu)?.filter(term => term.length >= 2) ?? [])]

const matchedTextTerms = (operation: ModuleCapabilityDescriptor, query: string): ReadonlyArray<string> => {
  const haystackTerms = new Set(textTerms([
    operation.id,
    operation.title,
    operation.description,
    operation.moduleId,
    operation.kind,
    operation.risk,
    ...(operation.searchTerms ?? []),
  ].join(' ')))
  return textTerms(query).filter(term => haystackTerms.has(term))
}

const textMatchScore = (operation: ModuleCapabilityDescriptor, query: string): number =>
  matchedTextTerms(operation, query).length

const resourceReferenceParameter = {
  type: 'object',
  properties: { workspaceId: { type: 'string' }, moduleId: { type: 'string' }, type: { type: 'string' }, id: { type: 'string' } },
  required: ['workspaceId', 'moduleId', 'type', 'id'],
  additionalProperties: false,
}

const definitionReferenceParameter = {
  type: 'object',
  properties: { workspaceId: { type: 'string' }, moduleId: { type: 'string' }, type: { type: 'string' }, id: { type: 'string' }, revisionId: { type: 'string' } },
  required: ['workspaceId', 'moduleId', 'type', 'id', 'revisionId'],
  additionalProperties: false,
}

const targetParameter = {
  description: 'One exact Resource or Definition-revision target returned by workspace_explore.',
  oneOf: [{
    type: 'object', properties: { kind: { type: 'string', const: 'resource' }, ref: resourceReferenceParameter }, required: ['kind', 'ref'], additionalProperties: false,
  }, {
    type: 'object', properties: { kind: { type: 'string', const: 'definition' }, ref: definitionReferenceParameter }, required: ['kind', 'ref'], additionalProperties: false,
  }],
}

const catalogPath = (workspacePath: string, kind: 'capabilities' | 'definitions' | 'resources'): string => `${workspacePath}/${kind}`

export const createWorkspaceCapabilityTools = (deps: WorkspaceCapabilityToolsDeps): ReadonlyArray<Tool> => {
  const fetchImpl = deps.fetchImpl ?? fetch
  const workspacePath = `${origin(deps.hostBaseUrl)}/api/workspaces/${encodeURIComponent(deps.workspaceId)}`

  const loadCatalogs = async (context: ToolContext) => {
    const [definitionResponse, resourceResponse, operationResponse] = await Promise.all([
      getJson(fetchImpl, catalogPath(workspacePath, 'definitions'), context.signal),
      getJson(fetchImpl, catalogPath(workspacePath, 'resources'), context.signal),
      getJson(fetchImpl, catalogPath(workspacePath, 'capabilities'), context.signal),
    ])
    for (const response of [definitionResponse, resourceResponse, operationResponse]) {
      if (!response.ok) throw await readHostError(response)
    }
    return {
      definitions: workspaceDefinitionCatalogSchema.parse(await definitionResponse.json()),
      resources: workspaceResourceCatalogSchema.parse(await resourceResponse.json()),
      operations: workspaceCapabilityCatalogSchema.parse(await operationResponse.json()),
    }
  }

  const explore: Tool = {
    name: 'workspace_explore',
    description: 'Explore the current Room Scope: discover exact Resources and Definitions, then find the read or change operations they advertise.',
    usage: 'Start with view="scope" for orientation. Use view="operations" with plain-language queries or exact operationIds, optionally against one returned target. Request schemas only for likely calls. Focus indicates attention and never expands Room Scope.',
    returns: 'The current Room Scope, focused subjects, exact targets, compact metadata, and/or matching operations. Returned targets can be passed unchanged to workspace_call.',
    parameters: {
      type: 'object', properties: {
        view: { type: 'string', enum: ['scope', 'operations', 'all'], default: 'scope' },
        target: targetParameter,
        moduleId: { type: 'string', description: 'Optional exact Module id filter.' },
        resourceType: { type: 'string', description: 'Optional exact Resource type filter.' },
        definitionType: { type: 'string', description: 'Optional exact Definition type filter.' },
        queries: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 256 }, maxItems: 8 },
        operationIds: { type: 'array', items: { type: 'string' }, maxItems: 24 },
        includeInputSchema: { type: 'boolean', default: false },
        includeOutputSchema: { type: 'boolean', default: false },
        offset: { type: 'integer', minimum: 0, default: 0 },
        limit: { type: 'integer', minimum: 1, maximum: MAX_PAGE_SIZE, default: DEFAULT_PAGE_SIZE },
      }, additionalProperties: false,
    },
    execute: async (params, context) => {
      const roomScope = requireRoomScope(context, deps)
      if (isToolResult(roomScope)) return roomScope
      try {
        const view = params.view === undefined ? 'scope' : String(params.view)
        if (!['scope', 'operations', 'all'].includes(view)) return failure('invalid_tool_input', 'view must be scope, operations, or all')
        const target = parseTarget(params.target, deps.workspaceId)
        const moduleId = optionalFilter(params.moduleId) === undefined ? undefined : moduleIdSchema.parse(params.moduleId)
        const resourceType = optionalFilter(params.resourceType) === undefined ? undefined : resourceTypeSchema.parse(params.resourceType)
        const definitionType = optionalFilter(params.definitionType) === undefined ? undefined : definitionTypeSchema.parse(params.definitionType)
        const operationIds = Array.isArray(params.operationIds) ? params.operationIds.map(value => capabilityIdSchema.parse(value)) : []
        const queries = Array.isArray(params.queries) ? params.queries.map(value => String(value).trim()).filter(Boolean) : []
        const offset = params.offset === undefined ? 0 : Number(params.offset)
        const limit = params.limit === undefined ? DEFAULT_PAGE_SIZE : Number(params.limit)
        if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) return failure('invalid_tool_input', 'Invalid pagination')

        const catalogs = await loadCatalogs(context)
        const resolved = resolveScope(roomScope, catalogs.resources.resources, catalogs.definitions.definitions)
        const scopeIssue = targetInScope(target, resolved)
        if (target !== undefined && scopeIssue) return scopeIssue
        const focusedSubjects = (context.focusedSubjects ?? []).filter(subject =>
          'revisionId' in subject
            ? resolved.definitionKeys.has(referenceKey(subject))
            : resolved.resourceKeys.has(referenceKey(subject)))

        const resources = resolved.resources.filter(resource =>
          (moduleId === undefined || resource.ref.moduleId === moduleId)
          && (resourceType === undefined || resource.ref.type === resourceType))
        const definitions = resolved.definitions.filter(definition =>
          (moduleId === undefined || definition.ref.moduleId === moduleId)
          && (definitionType === undefined || definition.ref.type === definitionType))

        const exactIds = new Set(operationIds)
        const relevantIds = target === undefined
          ? new Set([
              ...resolved.resources.flatMap(resource => resource.capabilityIds),
              ...resolved.definitions.flatMap(definition => definition.capabilityIds),
              ...(resolved.scope.kind === 'workspace'
                ? catalogs.operations.capabilities.filter(operation => operation.scope.kind === 'workspace').map(operation => operation.id)
                : []),
            ])
          : new Set(target.kind === 'resource'
              ? catalogs.resources.resources.find(resource => referenceKey(resource.ref) === referenceKey(target.ref))?.capabilityIds ?? []
              : catalogs.definitions.definitions.find(definition => referenceKey(definition.ref) === referenceKey(target.ref))?.capabilityIds ?? [])
        const score = (operation: ModuleCapabilityDescriptor): number => queries.reduce((best, query) => Math.max(best, textMatchScore(operation, query)), 0)
        const noSelector = operationIds.length === 0 && queries.length === 0
        const operations = catalogs.operations.capabilities
          .filter(operation => relevantIds.has(operation.id))
          .filter(operation => moduleId === undefined || operation.moduleId === moduleId)
          .filter(operation => noSelector || exactIds.has(operation.id) || score(operation) > 0)
          .filter(operation => target === undefined || applicabilityFailure(operation, target, catalogs.resources.resources, catalogs.definitions.definitions) === undefined)
          .sort((left, right) => Number(exactIds.has(right.id)) - Number(exactIds.has(left.id)) || score(right) - score(left) || left.id.localeCompare(right.id))
        const combined = view === 'scope'
          ? [...definitions.map(value => ({ kind: 'definition' as const, value })), ...resources.map(value => ({ kind: 'resource' as const, value }))]
          : view === 'operations'
            ? operations.map(value => ({ kind: 'operation' as const, value }))
            : [
                ...definitions.map(value => ({ kind: 'definition' as const, value })),
                ...resources.map(value => ({ kind: 'resource' as const, value })),
                ...operations.map(value => ({ kind: 'operation' as const, value })),
              ]
        const page = combined.slice(offset, offset + limit)
        return { success: true, data: {
          workspaceId: deps.workspaceId,
          scope: resolved.scope,
          focusedSubjects,
          ...(target === undefined ? {} : { target }),
          total: combined.length,
          offset,
          returned: page.length,
          hasMore: offset + page.length < combined.length,
          definitions: page.filter(item => item.kind === 'definition').map(item => compactDefinition(item.value as ModuleDefinitionDescriptor)),
          resources: page.filter(item => item.kind === 'resource').map(item => compactResource(item.value as ModuleResourceDescriptor)),
          operations: page.filter(item => item.kind === 'operation').map(item => {
            const operation = item.value as ModuleCapabilityDescriptor
            const { id, inputSchema, outputSchema, searchTerms: _searchTerms, ...descriptor } = operation
            const matchedTerms = [...new Set(queries.flatMap(query => matchedTextTerms(operation, query)))]
            return {
              ...descriptor,
              operationId: id,
              ...(queries.length > 0 ? { matchedQueries: queries.filter(query => textMatchScore(operation, query) > 0) } : {}),
              ...(matchedTerms.length > 0 ? { matchedTerms } : {}),
              ...(params.includeInputSchema === true ? { inputSchema } : {}),
              ...(params.includeOutputSchema === true ? { outputSchema } : {}),
            }
          }),
        } }
      } catch (error) {
        if (error && typeof error === 'object' && 'success' in error) return error as ToolResult
        return failure('workspace_exploration_failed', error instanceof Error ? error.message : String(error))
      }
    },
  }

  const call: Tool = {
    name: 'workspace_call',
    description: 'Call one discovered Workspace operation, or call independent read operations together.',
    usage: 'Use exact operation IDs and targets returned by workspace_explore. Reads and changes use the same call shape. Batch only independent reads; issue changes separately. Supply idempotencyKey only when the discovered operation advertises acceptsIdempotencyKey. A target Module enforces current run restrictions and safety checks.',
    returns: 'Results in request order. Each result contains either data or a structured error such as out-of-scope, restricted, stale, or invalid input.',
    parameters: {
      type: 'object', properties: {
        calls: { type: 'array', minItems: 1, maxItems: MAX_READ_BATCH_SIZE, items: { type: 'object', properties: {
          key: { type: 'string', minLength: 1, maxLength: 64 },
          operationId: { type: 'string' },
          target: targetParameter,
          input: {},
          expectedRevision: { type: 'integer', minimum: 0 },
          idempotencyKey: { type: 'string', minLength: 1, maxLength: 256, description: 'Optional uncertain-retry key; valid only when the discovered operation advertises acceptsIdempotencyKey.' },
        }, required: ['key', 'operationId', 'input'], additionalProperties: false } },
      }, required: ['calls'], additionalProperties: false,
    },
    execute: async (params, context) => {
      const roomScope = requireRoomScope(context, deps)
      if (isToolResult(roomScope)) return roomScope
      if (!Array.isArray(params.calls) || params.calls.length < 1 || params.calls.length > MAX_READ_BATCH_SIZE) {
        return failure('invalid_tool_input', `calls must contain 1 to ${MAX_READ_BATCH_SIZE} entries`)
      }
      try {
        const calls = params.calls.map((value, index) => {
          if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`calls[${index}] must be an object`)
          const raw = value as Record<string, unknown>
          if (typeof raw.key !== 'string' || raw.key.trim().length === 0 || raw.key.length > 64) {
            throw new Error(`calls[${index}].key must be a non-empty string of at most 64 characters`)
          }
          return {
            key: raw.key,
            operationId: capabilityIdSchema.parse(raw.operationId),
            target: parseTarget(raw.target, deps.workspaceId),
            input: raw.input,
            expectedRevision: raw.expectedRevision,
            idempotencyKey: raw.idempotencyKey,
          }
        })
        const catalogs = await loadCatalogs(context)
        const resolved = resolveScope(roomScope, catalogs.resources.resources, catalogs.definitions.definitions)
        const prepared = calls.map(entry => ({
          ...entry,
          operation: catalogs.operations.capabilities.find(operation => operation.id === entry.operationId),
        }))
        if (prepared.length > 1 && prepared.some(entry => entry.operation?.risk !== 'read')) {
          return failure('batch_requires_read_operations', 'Only read operations may be batched')
        }
        const results = await Promise.all(prepared.map(async entry => {
          const issue = targetInScope(entry.target, resolved)
            ?? applicabilityFailure(entry.operation, entry.target, catalogs.resources.resources, catalogs.definitions.definitions)
          if (issue) return { key: entry.key, operationId: entry.operationId, success: false, error: issue.error, details: issue.data }
          if (entry.idempotencyKey !== undefined && entry.operation?.acceptsIdempotencyKey !== true) {
            return {
              key: entry.key,
              operationId: entry.operationId,
              success: false,
              error: 'idempotency_not_supported: This operation does not advertise caller-supplied retry keys',
            }
          }
          try {
            const response = await fetchImpl(`${workspacePath}/capabilities/${encodeURIComponent(entry.operationId)}/invoke`, {
              method: 'POST',
              signal: requestSignal(context.signal),
              headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
              body: JSON.stringify({
                ...(entry.target?.kind === 'definition' ? { definition: entry.target.ref } : {}),
                ...(entry.target?.kind === 'resource' ? { resource: entry.target.ref } : {}),
                ...(entry.expectedRevision === undefined ? {} : { expectedRevision: entry.expectedRevision }),
                ...(entry.idempotencyKey === undefined ? {} : { idempotencyKey: entry.idempotencyKey }),
                input: entry.input,
                actor: { kind: 'ai', id: context.callerId, displayName: context.callerName },
              }),
            })
            if (!response.ok) {
              const result = await readHostError(response)
              return { key: entry.key, operationId: entry.operationId, success: false, error: result.error, details: result.data }
            }
            const body = await response.json() as { result?: unknown }
            if (!Object.hasOwn(body, 'result')) return { key: entry.key, operationId: entry.operationId, success: false, error: 'workspace_host_contract_invalid: Workspace Host response omitted result' }
            return { key: entry.key, operationId: entry.operationId, success: true, data: body.result }
          } catch (error) {
            return { key: entry.key, operationId: entry.operationId, success: false, error: `workspace_outcome_unknown: ${error instanceof Error ? error.message : String(error)}` }
          }
        }))
        return { success: true, data: { results } }
      } catch (error) {
        if (error && typeof error === 'object' && 'success' in error) return error as ToolResult
        return failure('invalid_tool_input', error instanceof Error ? error.message : String(error))
      }
    },
  }

  return [explore, call]
}
