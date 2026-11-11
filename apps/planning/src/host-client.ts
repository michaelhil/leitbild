import {
  moduleCapabilityInvocationResultSchema, workspaceCapabilityInvocationRequestSchema,
  type AccessContext, type WorkspaceCapabilityInvocationRequest,
} from '@leitbild/contracts'
import { planningError } from './errors.ts'

/**
 * Calls a published Capability through Host as the caller, so the caller's access applies. Only a
 * configured Host origin is used; caller input never chooses a URL. Planning uses it for one read: the
 * World facts query in refresh.
 */
export const createPlanningHostClient = (config: { readonly hostUrl: string; readonly fetch?: typeof fetch }) => {
  const origin = new URL(config.hostUrl)
  if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password || origin.search || origin.hash) throw new Error('WORKSPACE_HOST_URL must be an HTTP(S) Host URL without credentials, query or fragment')
  const base = origin.href.replace(/\/$/, '')
  const transport = config.fetch ?? fetch
  return {
    call: async (access: AccessContext, capabilityId: string, input: Omit<WorkspaceCapabilityInvocationRequest, 'actor'>): Promise<unknown> => {
      const request = workspaceCapabilityInvocationRequestSchema.parse({ ...input, actor: access.actor })
      let response: Response
      try {
        response = await transport(`${base}/api/workspaces/${encodeURIComponent(access.workspaceId)}/capabilities/${encodeURIComponent(capabilityId)}/invoke`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request), signal: AbortSignal.timeout(30_000), redirect: 'error',
        })
      } catch (error) {
        throw planningError(503, 'world_unavailable', `Could not reach the Workspace Host: ${error instanceof Error ? error.message : String(error)}`)
      }
      let body: unknown
      try { body = await response.json() } catch { throw planningError(502, 'invalid_host_response', 'Workspace Host returned a response that is not JSON') }
      if (!response.ok) {
        const error = body !== null && typeof body === 'object' && 'error' in body ? body.error : undefined
        const detail = error !== null && typeof error === 'object' ? error as Record<string, unknown> : {}
        const details = detail.details !== null && typeof detail.details === 'object' && !Array.isArray(detail.details) ? detail.details as Record<string, unknown> : undefined
        throw planningError(response.status, typeof detail.code === 'string' ? detail.code : 'world_unavailable', typeof detail.message === 'string' ? detail.message : `Workspace Host returned HTTP ${response.status}`, details)
      }
      return moduleCapabilityInvocationResultSchema.parse(body).result
    },
  }
}

export type PlanningHost = ReturnType<typeof createPlanningHostClient>
