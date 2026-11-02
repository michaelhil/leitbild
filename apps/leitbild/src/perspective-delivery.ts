import {
  agentsPerspectiveRoomAdmissionSchema, perspectiveAdmissionSchema, perspectiveAssistantSetupRequestSchema,
  perspectiveAssistantSetupResultSchema, perspectivePresentationVerificationSchema, perspectiveViewLeaseSchema,
  perspectiveViewRequestSchema, type InvokeCapabilityInput, type ModuleCapabilityInvocationResult,
  type PerspectiveRuntimeBinding, type WorkspaceId, type WorkspaceResourceReference,
} from '@leitbild/contracts'
import { hostError } from './errors.ts'

type Invoke = (capabilityId: string, input: InvokeCapabilityInput) => Promise<ModuleCapabilityInvocationResult>
const same = (a: WorkspaceResourceReference, b: WorkspaceResourceReference): boolean =>
  a.workspaceId === b.workspaceId && a.moduleId === b.moduleId && a.type === b.type && a.id === b.id
const sameBinding = (a: PerspectiveRuntimeBinding, b: PerspectiveRuntimeBinding): boolean =>
  same(a.perspective, b.perspective) && same(a.room, b.room) && a.admissionGeneration === b.admissionGeneration
  && a.actualAgentId === b.actualAgentId && a.runtimeGeneration === b.runtimeGeneration
  && a.templateId === b.templateId && a.templateRevision === b.templateRevision
const unavailable = (code: string, message: string): never => { throw hostError({ status: 409, code, message }) }
const checkWorkspace = (workspaceId: WorkspaceId, ref: WorkspaceResourceReference): void => {
  if (ref.workspaceId !== workspaceId) unavailable('perspective_workspace_mismatch', 'The Perspective belongs to another Workspace')
}

/** Browser orchestration only. Each Module owns its accepted state and validates the other owner.
 * An uncertain call leaves real pending resources; retry reads them rather than pretending rollback. */
export const setupPerspectiveAssistant = async (workspaceId: WorkspaceId, raw: unknown, invoke: Invoke) => {
  const input = perspectiveAssistantSetupRequestSchema.parse(raw)
  checkWorkspace(workspaceId, input.perspective)
  const readWorld = async () => perspectiveAdmissionSchema.parse((await invoke('world.perspective.read', { resource: input.perspective, input: {} })).result)
  let admission = await readWorld()
  if (!same(admission.resource, input.perspective) || admission.status === 'revoked') unavailable('perspective_unavailable', 'This Perspective is no longer available; set up a fresh Assistant')
  let agents
  if (admission.status === 'pending') {
    agents = agentsPerspectiveRoomAdmissionSchema.parse((await invoke('agents.perspective-room.prepare', { input: {
      perspective: input.perspective, admissionGeneration: admission.admissionGeneration,
      templateId: input.templateId, templateRevision: input.templateRevision, requestId: input.requestId,
    } })).result)
    if (!same(agents.perspective, input.perspective) || agents.admissionGeneration !== admission.admissionGeneration
      || agents.templateId !== input.templateId || agents.templateRevision !== input.templateRevision) unavailable('perspective_binding_mismatch', 'The prepared Assistant does not match the requested Perspective and template')
    const binding: PerspectiveRuntimeBinding = { perspective: agents.perspective, admissionGeneration: agents.admissionGeneration,
      room: agents.room, actualAgentId: agents.actualAgentId, runtimeGeneration: agents.runtimeGeneration,
      templateId: agents.templateId, templateRevision: agents.templateRevision }
    admission = perspectiveAdmissionSchema.parse((await invoke('world.perspective.bind', { resource: input.perspective, input: { expectedRevision: admission.revision, binding } })).result)
  } else {
    if (!admission.binding || admission.binding.templateId !== input.templateId || admission.binding.templateRevision !== input.templateRevision) unavailable('perspective_template_mismatch', 'This Perspective already belongs to a different template; set up a fresh Assistant')
    const binding = admission.binding
    if (!binding) return unavailable('perspective_binding_missing', 'The active Perspective has no Assistant binding')
    agents = agentsPerspectiveRoomAdmissionSchema.parse((await invoke('agents.perspective-room.read', { resource: binding.room, input: {} })).result)
  }
  if (admission.status !== 'active' || !admission.binding || !sameBinding(admission.binding, agents)) unavailable('perspective_binding_mismatch', 'The owners did not admit the same Assistant')
  if (agents.status === 'prepared') agents = agentsPerspectiveRoomAdmissionSchema.parse((await invoke('agents.perspective-room.bind', { resource: agents.room, input: { expectedRevision: agents.revision } })).result)
  if (agents.status !== 'bound') unavailable('perspective_runtime_unavailable', 'This Assistant runtime is not available; set up a fresh compartment')
  // A revoke or reset during the final owner call must not produce a successful setup result.
  admission = await readWorld()
  return perspectiveAssistantSetupResultSchema.parse({ admission, roomAdmission: agents })
}

/** A current World document requests a view of its exact bound Room. No browser chooses the Room. */
export const openPerspectiveView = async (workspaceId: WorkspaceId, raw: unknown, invoke: Invoke) => {
  const input = perspectiveViewRequestSchema.parse(raw)
  checkWorkspace(workspaceId, input.recipient.subject)
  const verify = async () => {
    const result = perspectivePresentationVerificationSchema.parse((await invoke('world.perspective.presentation.verify', {
      resource: input.recipient.subject, input: { recipient: input.recipient },
    })).result)
    if (!same(result.admission.resource, input.recipient.subject) || result.admission.status !== 'active'
      || !result.admission.binding || !sameBinding(result.admission.binding, result.binding)
      || result.recipient.clientId !== input.recipient.clientId || result.recipient.documentId !== input.recipient.documentId
      || result.recipient.leaseId !== input.recipient.leaseId || Date.parse(result.recipient.expiresAt) <= Date.now()) unavailable('perspective_document_unavailable', 'The current World document no longer offers this Perspective')
    return result
  }
  const before = await verify()
  const agents = agentsPerspectiveRoomAdmissionSchema.parse((await invoke('agents.perspective-room.read', { resource: before.binding.room, input: {} })).result)
  if (agents.status !== 'bound' || !sameBinding(agents, before.binding)) unavailable('perspective_runtime_unavailable', 'The exact Assistant runtime is no longer available')
  const lease = perspectiveViewLeaseSchema.parse((await invoke('agents.perspective-room.view-open', { resource: agents.room,
    input: { expectedRevision: agents.revision, documentId: input.agentsDocumentId } })).result)
  const after = await verify()
  if (!sameBinding(before.binding, after.binding) || !same(lease.room, after.binding.room)
    || !same(lease.perspective, after.admission.resource) || lease.documentId !== input.agentsDocumentId
    || Date.parse(lease.expiresAt) <= Date.now()) unavailable('perspective_view_changed', 'The Perspective changed while its Assistant document was opening')
  return lease
}
