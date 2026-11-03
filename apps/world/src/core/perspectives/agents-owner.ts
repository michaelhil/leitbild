import { agentsPerspectiveRoomAdmissionSchema, type AgentsPerspectiveRoomAdmission, type PerspectiveRuntimeBinding } from '@leitbild/contracts'
import { perspectiveFailure } from './model.ts'

// Match the ordinary Host Module gateway's 30s owner-request deadline. This
// bounds a verification request, not the lifetime of a model/provider call.
const ownerRequestTimeoutMs = 30_000

/** World calls only the concrete Agents read/revoke owner ports through the
 * direct loopback Host transport. Public actors and model input cannot use it. */
export const createPerspectiveAgentsOwner = (hostUrl: string, fetchImpl: (url: URL, init: RequestInit) => Promise<Response> = fetch) => {
  const invoke = async (binding: PerspectiveRuntimeBinding, operation: 'read' | 'revoke', input: unknown): Promise<AgentsPerspectiveRoomAdmission> => {
    let response: Response
    try { response = await fetchImpl(new URL(`/internal/workspaces/${encodeURIComponent(binding.room.workspaceId)}/capabilities/agents.perspective-room.${operation}/invoke`, hostUrl), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(ownerRequestTimeoutMs),
      body: JSON.stringify({ resource: binding.room, input, actor: { kind: 'system', id: 'world' }, perspectiveOrigin: { kind: 'owner', moduleId: 'world' } }),
    }) } catch { throw perspectiveFailure('perspective_peer_unavailable', 'Agents owner verification did not finish; read the exact admission before retrying', 503) }
    if (!response.ok) throw perspectiveFailure('perspective_peer_unavailable', `Agents Perspective ${operation} owner unavailable (HTTP ${response.status})`, 503)
    let peer: AgentsPerspectiveRoomAdmission
    try { const body = await response.json() as { result?: unknown }; peer = agentsPerspectiveRoomAdmissionSchema.parse(body.result) }
    catch { throw perspectiveFailure('perspective_peer_contract_invalid', 'Agents owner returned an invalid admission; no substitute is accepted', 503) }
    for (const key of ['admissionGeneration', 'actualAgentId', 'runtimeGeneration', 'templateId', 'templateRevision'] as const) if (peer[key] !== binding[key]) throw perspectiveFailure('perspective_peer_binding_mismatch', 'Agents returned a different Perspective binding', 503)
    for (const key of ['room', 'perspective'] as const) if (peer[key].workspaceId !== binding[key].workspaceId || peer[key].moduleId !== binding[key].moduleId
      || peer[key].type !== binding[key].type || peer[key].id !== binding[key].id) throw perspectiveFailure('perspective_peer_binding_mismatch', 'Agents returned a different Perspective subject', 503)
    return peer
  }
  const readAgentsAdmission = (binding: PerspectiveRuntimeBinding) => invoke(binding, 'read', {})
  return { readAgentsAdmission,
    revokeAgentsAdmission: async (binding: PerspectiveRuntimeBinding, reason: string): Promise<AgentsPerspectiveRoomAdmission> => {
      const current = await readAgentsAdmission(binding)
      if (current.status === 'revoked') return current
      try { return await invoke(binding, 'revoke', { expectedRevision: current.revision, reason }) }
      catch (error) {
        // CAS conflicts and transport uncertainty are reconciled from actual
        // owner state, never reported as a rollback or blind second mutation.
        const latest = await readAgentsAdmission(binding)
        if (latest.status === 'revoked') return latest
        throw error
      }
    },
  }
}
