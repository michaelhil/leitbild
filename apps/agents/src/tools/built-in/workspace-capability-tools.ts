import {
  capabilityIdSchema,
  definitionIdSchema,
  definitionRevisionIdSchema,
  definitionTypeSchema,
  moduleIdSchema,
  resourceIdSchema,
  resourceTypeSchema,
  workspaceCapabilityCatalogSchema,
  workspaceDefinitionCatalogSchema,
  workspaceResourceCatalogSchema,
  type ToolGrant,
  type WorkspaceId,
} from '@leitbild/contracts'
import type { Tool, ToolContext, ToolResult } from '../../core/types/tool.ts'

export interface WorkspaceCapabilityToolsDeps {
  readonly workspaceId: WorkspaceId
  readonly hostBaseUrl: string
  readonly getToolGrants: (agentId: string) => ReadonlyArray<ToolGrant> | undefined
  readonly fetchImpl?: typeof fetch
}

const hostBaseUrl = (raw: string): string => {
  const url = new URL(raw)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Workspace Host URL must use http or https')
  }
  if (url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Workspace Host URL must be an origin without a path, query, or fragment')
  }
  return url.origin
}

const failure = (code: string, message: string, details?: Record<string, unknown>): ToolResult => ({
  success: false,
  error: `${code}: ${message}`,
  data: { code, ...(details === undefined ? {} : { details }) },
})

const readHostError = async (response: Response): Promise<ToolResult> => {
  const body = await response.json().catch(() => undefined) as {
    error?: { code?: unknown; message?: unknown; retryable?: unknown; details?: unknown }
  } | undefined
  const code = typeof body?.error?.code === 'string' ? body.error.code : 'workspace_host_request_failed'
  const message = typeof body?.error?.message === 'string'
    ? body.error.message
    : `Workspace Host returned HTTP ${response.status}`
  return failure(code, message, {
    status: response.status,
    retryable: body?.error?.retryable === true,
    ...(body?.error?.details && typeof body.error.details === 'object'
      ? { hostDetails: body.error.details as Record<string, unknown> }
      : {}),
  })
}

const getJson = async (fetchImpl: typeof fetch, url: string): Promise<Response> => {
  try {
    return await fetchImpl(url, { headers: { Accept: 'application/json' } })
  } catch (error) {
    throw new Error(`Workspace Host is unreachable: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }
}

export const createWorkspaceCapabilityTools = (deps: WorkspaceCapabilityToolsDeps): ReadonlyArray<Tool> => {
  const baseUrl = hostBaseUrl(deps.hostBaseUrl)
  const fetchImpl = deps.fetchImpl ?? fetch
  const workspacePath = `${baseUrl}/api/workspaces/${encodeURIComponent(deps.workspaceId)}`

  const catalog: Tool = {
    name: 'workspace_catalog',
    description: 'List reusable Definitions and live Resources exposed by Modules in this Workspace.',
    usage: 'Discover Definition and Resource identities immediately before invoking a scoped Workspace Capability. Do not remember runtime Resource ids as Agent configuration.',
    returns: '{ workspaceId, definitions[], resources[] } with stable references, provenance, UI paths, links, and advertised capabilityIds.',
    parameters: {
      type: 'object',
      properties: {
        moduleId: { type: 'string' },
        definitionType: { type: 'string' },
        resourceType: { type: 'string' },
        capabilityId: { type: 'string' },
      },
      additionalProperties: false,
    },
    execute: async params => {
      try {
        const moduleId = params.moduleId === undefined ? undefined : moduleIdSchema.parse(params.moduleId)
        const definitionType = params.definitionType === undefined ? undefined : definitionTypeSchema.parse(params.definitionType)
        const resourceType = params.resourceType === undefined ? undefined : resourceTypeSchema.parse(params.resourceType)
        const capabilityId = params.capabilityId === undefined ? undefined : capabilityIdSchema.parse(params.capabilityId)
        const [definitionResponse, resourceResponse] = await Promise.all([
          getJson(fetchImpl, `${workspacePath}/definitions`),
          getJson(fetchImpl, `${workspacePath}/resources`),
        ])
        if (!definitionResponse.ok) return await readHostError(definitionResponse)
        if (!resourceResponse.ok) return await readHostError(resourceResponse)
        const definitions = workspaceDefinitionCatalogSchema.parse(await definitionResponse.json())
        const resources = workspaceResourceCatalogSchema.parse(await resourceResponse.json())
        return {
          success: true,
          data: {
            workspaceId: resources.workspaceId,
            modules: {
              definitions: definitions.modules,
              resources: resources.modules,
            },
            definitions: definitions.definitions.filter(definition =>
              (moduleId === undefined || definition.ref.moduleId === moduleId)
              && (definitionType === undefined || definition.ref.type === definitionType)
              && (capabilityId === undefined || definition.capabilityIds.includes(capabilityId))),
            resources: resources.resources.filter(resource =>
              (moduleId === undefined || resource.ref.moduleId === moduleId)
              && (resourceType === undefined || resource.ref.type === resourceType)
              && (capabilityId === undefined || resource.capabilityIds.includes(capabilityId))),
          },
        }
      } catch (error) {
        return failure('workspace_catalog_discovery_failed', error instanceof Error ? error.message : String(error))
      }
    },
  }

  const capabilities: Tool = {
    name: 'workspace_capabilities',
    description: 'List Capabilities exposed by Modules in this Workspace, including input schemas, Resource scope, risk, and whether this Agent has a grant.',
    usage: 'Discover operations dynamically. A Capability can be invoked only when the Agent Profile grants its capabilityId.',
    returns: '{ workspaceId, modules, capabilities[] } where each Capability includes granted: boolean.',
    parameters: {
      type: 'object',
      properties: {
        moduleId: { type: 'string' },
        risk: { type: 'string', enum: ['read', 'write', 'destructive'] },
        kind: { type: 'string', enum: ['query', 'command', 'stream'] },
      },
      additionalProperties: false,
    },
    execute: async (params, context) => {
      try {
        const moduleId = params.moduleId === undefined ? undefined : moduleIdSchema.parse(params.moduleId)
        const risk = params.risk === undefined ? undefined : params.risk
        const kind = params.kind === undefined ? undefined : params.kind
        if (risk !== undefined && !['read', 'write', 'destructive'].includes(String(risk))) {
          return failure('invalid_tool_input', 'risk must be read, write, or destructive')
        }
        if (kind !== undefined && !['query', 'command', 'stream'].includes(String(kind))) {
          return failure('invalid_tool_input', 'kind must be query, command, or stream')
        }
        const response = await getJson(fetchImpl, `${workspacePath}/capabilities`)
        if (!response.ok) return await readHostError(response)
        const catalog = workspaceCapabilityCatalogSchema.parse(await response.json())
        const grants = new Set((deps.getToolGrants(context.callerId) ?? []).map(grant => grant.capabilityId))
        return {
          success: true,
          data: {
            workspaceId: catalog.workspaceId,
            modules: catalog.modules,
            capabilities: catalog.capabilities
              .filter(capability =>
                (moduleId === undefined || capability.moduleId === moduleId)
                && (risk === undefined || capability.risk === risk)
                && (kind === undefined || capability.kind === kind))
              .map(capability => ({ ...capability, granted: grants.has(capability.id) })),
          },
        }
      } catch (error) {
        return failure('workspace_capability_discovery_failed', error instanceof Error ? error.message : String(error))
      }
    },
  }

  const invoke: Tool = {
    name: 'workspace_invoke',
    description: 'Invoke one granted Workspace Capability against the current Workspace and an optional Definition or Resource selected from workspace_catalog.',
    usage: 'Copy capabilityId from workspace_capabilities. Pass either definition or resource for a scoped operation; Workspace scope is supplied automatically.',
    returns: 'The owning Module result, or a structured failure code such as capability_not_granted or workspace_host_request_failed.',
    parameters: {
      type: 'object',
      properties: {
        capabilityId: { type: 'string' },
        definition: {
          type: 'object',
          properties: {
            moduleId: { type: 'string' },
            type: { type: 'string' },
            id: { type: 'string' },
            revisionId: { type: 'string' },
          },
          required: ['moduleId', 'type', 'id', 'revisionId'],
          additionalProperties: false,
        },
        resource: {
          type: 'object',
          properties: {
            moduleId: { type: 'string' },
            type: { type: 'string' },
            id: { type: 'string' },
          },
          required: ['moduleId', 'type', 'id'],
          additionalProperties: false,
        },
        input: {},
      },
      required: ['capabilityId', 'input'],
      additionalProperties: false,
    },
    execute: async (params, context: ToolContext) => {
      let capabilityId
      try {
        capabilityId = capabilityIdSchema.parse(params.capabilityId)
      } catch (error) {
        return failure('invalid_tool_input', error instanceof Error ? error.message : String(error))
      }
      const grants = deps.getToolGrants(context.callerId)
      if (grants === undefined) {
        return failure('caller_not_ai_agent', 'Workspace Capability invocation requires an AI Agent Profile')
      }
      if (!grants.some(grant => grant.capabilityId === capabilityId)) {
        return failure('capability_not_granted', `Agent ${context.callerName} is not granted ${capabilityId}`, { capabilityId })
      }

      let resource: { workspaceId: WorkspaceId; moduleId: ReturnType<typeof moduleIdSchema.parse>; type: ReturnType<typeof resourceTypeSchema.parse>; id: ReturnType<typeof resourceIdSchema.parse> } | undefined
      let definition: { workspaceId: WorkspaceId; moduleId: ReturnType<typeof moduleIdSchema.parse>; type: ReturnType<typeof definitionTypeSchema.parse>; id: ReturnType<typeof definitionIdSchema.parse>; revisionId: ReturnType<typeof definitionRevisionIdSchema.parse> } | undefined
      try {
        if (params.definition !== undefined && params.resource !== undefined) {
          return failure('invalid_target', 'definition and resource are mutually exclusive')
        }
        if (params.definition !== undefined) {
          if (!params.definition || typeof params.definition !== 'object' || Array.isArray(params.definition)) {
            return failure('invalid_definition', 'definition must be an object')
          }
          const raw = params.definition as Record<string, unknown>
          definition = {
            workspaceId: deps.workspaceId,
            moduleId: moduleIdSchema.parse(raw.moduleId),
            type: definitionTypeSchema.parse(raw.type),
            id: definitionIdSchema.parse(raw.id),
            revisionId: definitionRevisionIdSchema.parse(raw.revisionId),
          }
        }
        if (params.resource !== undefined) {
          if (!params.resource || typeof params.resource !== 'object' || Array.isArray(params.resource)) {
            return failure('invalid_resource', 'resource must be an object')
          }
          const raw = params.resource as Record<string, unknown>
          resource = {
            workspaceId: deps.workspaceId,
            moduleId: moduleIdSchema.parse(raw.moduleId),
            type: resourceTypeSchema.parse(raw.type),
            id: resourceIdSchema.parse(raw.id),
          }
        }
      } catch (error) {
        return failure('invalid_resource', error instanceof Error ? error.message : String(error))
      }

      try {
        const response = await fetchImpl(`${workspacePath}/capabilities/${encodeURIComponent(capabilityId)}/invoke`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({
            ...(definition === undefined ? {} : { definition }),
            ...(resource === undefined ? {} : { resource }),
            input: params.input,
            actor: { kind: 'ai', id: context.callerId, displayName: context.callerName },
          }),
        })
        if (!response.ok) return await readHostError(response)
        const body = await response.json() as { result?: unknown }
        if (!Object.hasOwn(body, 'result')) return failure('workspace_host_contract_invalid', 'Workspace Host response omitted result')
        return { success: true, data: body.result }
      } catch (error) {
        return failure('workspace_host_unreachable', error instanceof Error ? error.message : String(error))
      }
    },
  }

  return [catalog, capabilities, invoke]
}
