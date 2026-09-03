import type { SimulationRunId } from '../core/model/index.ts'
import { parseControlSurfaceRoute } from './simulation-run-route.ts'
import type { WorkspaceDefinitionRevisionReference } from '@leitbild/contracts'

type Options = { workspaceId?: string; simulationRunId?: SimulationRunId; definition?: WorkspaceDefinitionRevisionReference }
export const invokeWorld = async <T>(id: string, input: unknown, options: Options = {}): Promise<T> => {
  const workspaceId = options.workspaceId ?? parseControlSurfaceRoute(location.pathname).workspaceId
  const response = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/capabilities/${encodeURIComponent(id)}/invoke`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ input, actor: { kind: 'human' }, ...(options.definition ? { definition: options.definition } : {}), ...(options.simulationRunId ? { resource: { workspaceId, moduleId: 'world', type: 'world.simulation-run', id: options.simulationRunId } } : {}) }),
  })
  const body = await response.json() as { result?: T & { ok?: boolean; reason?: string }; error?: { message?: string } }
  if (!response.ok || body.error || body.result?.ok === false) throw new Error(body.error?.message ?? body.result?.reason ?? `Request failed: ${response.status}`)
  return body.result as T
}
