import { perspectiveAdmissionSchema, type PerspectiveAdmission, type PerspectiveOrigin, type WorldPerspectiveReference, type WorkspaceId } from '@leitbild/contracts'

/** A private local Module→Host port. Public workspace_call inputs never select
 * this route or supply its origin. The Host separately admits the local origin.
 */
export const createPerspectiveWorldClient = (deps: {
  readonly workspaceId: WorkspaceId
  readonly hostBaseUrl: string
  readonly fetchImpl?: typeof fetch
}) => {
  const invoke = async (operationId: string, resource: WorldPerspectiveReference, input: unknown, origin: PerspectiveOrigin, signal?: AbortSignal): Promise<unknown> => {
    const response = await (deps.fetchImpl ?? fetch)(`${deps.hostBaseUrl.replace(/\/$/, '')}/internal/workspaces/${encodeURIComponent(deps.workspaceId)}/capabilities/${encodeURIComponent(operationId)}/invoke`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      ...(signal === undefined ? {} : { signal }),
      body: JSON.stringify({ resource, input, perspectiveOrigin: origin,
        actor: origin.kind === 'owner' ? { kind: 'system', id: origin.moduleId } : { kind: 'ai', id: origin.actualAgentId } }),
    })
    if (!response.ok) throw Object.assign(new Error('World Perspective authority is unavailable; reconnect or prepare a fresh compartment'), { code: 'perspective_authority_unavailable', status: response.status })
    const body: unknown = await response.json()
    if (body === null || typeof body !== 'object' || !Object.hasOwn(body, 'result')) throw Object.assign(new Error('World Perspective owner response omitted its result'), { code: 'perspective_owner_contract_invalid' })
    return (body as { result: unknown }).result
  }
  return {
    invoke,
    read: async (reference: WorldPerspectiveReference, signal?: AbortSignal): Promise<PerspectiveAdmission> => perspectiveAdmissionSchema.parse(await invoke('world.perspective.read', reference, {}, { kind: 'owner', moduleId: 'agents' }, signal)),
  }
}
