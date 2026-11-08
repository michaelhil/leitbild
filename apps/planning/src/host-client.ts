import {
  moduleCapabilityInvocationResultSchema, workspaceCapabilityInvocationRequestSchema,
  workspaceDefinitionCatalogSchema,
  type AccessContext, type WorkspaceId, type WorkspaceCapabilityInvocationRequest,
} from '@leitbild/contracts'
import { planningError } from './errors.ts'

/** Only a configured Host origin is used; caller input never chooses a URL. */
export const createPlanningHostClient = (config: { readonly hostUrl: string; readonly fetch?: typeof fetch }) => {
  const origin = new URL(config.hostUrl)
  if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password || origin.search || origin.hash) throw new Error('WORKSPACE_HOST_URL must be an HTTP(S) Host URL without credentials, query or fragment')
  const base = origin.href.replace(/\/$/, '')
  const transport = config.fetch ?? fetch
  const read = async (path: string, init?: RequestInit): Promise<unknown> => {
    let response: Response
    try { response = await transport(`${base}${path}`, { ...init, signal: AbortSignal.timeout(30_000), redirect: 'error' }) }
    catch (error) { throw planningError(503, 'source_transport_unavailable', `Could not reach the Workspace Host: ${error instanceof Error ? error.message : String(error)}`) }
    let body: unknown
    try { body = await response.json() }
    catch { throw planningError(502, 'invalid_host_response', 'Workspace Host returned a response that is not JSON') }
    if (!response.ok) {
      const error = body !== null && typeof body === 'object' && 'error' in body ? body.error : undefined
      const detail = error !== null && typeof error === 'object' ? error as Record<string, unknown> : {}
      throw planningError(response.status, typeof detail.code === 'string' ? detail.code : 'source_operation_refused', typeof detail.message === 'string' ? detail.message : `Workspace Host returned HTTP ${response.status}`)
    }
    return body
  }
  return {
    call: async (access: AccessContext, capabilityId: string, input: Omit<WorkspaceCapabilityInvocationRequest, 'actor'>): Promise<unknown> => {
      const request = workspaceCapabilityInvocationRequestSchema.parse({ ...input, actor: access.actor })
      const body = await read(`/api/workspaces/${encodeURIComponent(access.workspaceId)}/capabilities/${encodeURIComponent(capabilityId)}/invoke`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request),
      })
      return moduleCapabilityInvocationResultSchema.parse(body).result
    },
    definitions: async (workspaceId: WorkspaceId) => workspaceDefinitionCatalogSchema.parse(await read(`/api/workspaces/${encodeURIComponent(workspaceId)}/definitions?moduleId=world`)),
  }
}

export type PlanningHost = ReturnType<typeof createPlanningHostClient>
