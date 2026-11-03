import type { SimulationRunId } from '../core/model/index.ts'
import { parseControlSurfaceRoute } from './simulation-run-route.ts'
import type { WorkspaceDefinitionRevisionReference } from '@leitbild/contracts'

type Options = { workspaceId?: string; simulationRunId?: SimulationRunId; definition?: WorkspaceDefinitionRevisionReference; expectedRevision?: number }
export const invokeWorld = async <T>(id: string, input: unknown, options: Options = {}): Promise<T> => {
  const workspaceId = options.workspaceId ?? parseControlSurfaceRoute(location.pathname).workspaceId
  const resource = options.simulationRunId ? { workspaceId, moduleId: 'world', type: 'world.simulation-run', id: options.simulationRunId } : undefined
  const response = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/capabilities/${encodeURIComponent(id)}/invoke`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ input, actor: { kind: 'human' }, ...(options.expectedRevision === undefined ? {} : { expectedRevision: options.expectedRevision }), ...(options.definition ? { definition: options.definition } : {}), ...(resource ? { resource } : {}) }),
  })
  const body = await response.json() as { result?: T & { ok?: boolean; reason?: string }; error?: { message?: string; code?: string } }
  if (!response.ok || body.error || body.result?.ok === false) throw Object.assign(new Error(body.error?.message ?? body.result?.reason ?? `Request failed: ${response.status}`), { code: body.error?.code })
  return body.result as T
}
