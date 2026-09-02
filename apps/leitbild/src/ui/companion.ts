import { workspaceResourceReferenceSchema, type ModuleDefinitionDescriptor, type ModuleResourceDescriptor } from '@leitbild/contracts'
import { request, jsonRequest } from './api.ts'

export const openCompanion = async (
  resource: ModuleResourceDescriptor,
  definitions: ReadonlyArray<ModuleDefinitionDescriptor>,
  resources: ReadonlyArray<ModuleResourceDescriptor>,
  invoke = request,
) => {
  const sameReference = (ref: ModuleResourceDescriptor['ref']) =>
    ref.workspaceId === resource.ref.workspaceId && ref.moduleId === resource.ref.moduleId
    && ref.type === resource.ref.type && ref.id === resource.ref.id
  const existing = resources.filter(candidate => candidate.ref.type === 'agents.room'
    && candidate.links.some(link => link.rel === 'companion-of' && sameReference(link.ref)))
  if (existing.length > 1) throw new Error('Multiple companion rooms reference this simulation. Open the intended room from the workspace.')
  if (existing[0]) return existing[0].ref
  const candidates = definitions.filter(definition => definition.ref.workspaceId === resource.ref.workspaceId
    && definition.companion?.resourceType === resource.ref.type)
  if (candidates.length !== 1) throw new Error(candidates.length === 0
    ? 'No companion definition is available for this simulation. You can still open or create a room from the workspace.'
    : 'Multiple companion definitions match this simulation. Keep one companion definition for this resource type.')
  const definition = candidates[0]!
  const response = await invoke<{ result: { resource: unknown } }>(
    `/api/workspaces/${encodeURIComponent(resource.ref.workspaceId)}/capabilities/${encodeURIComponent(definition.companion!.capabilityId)}/invoke`,
    { ...jsonRequest('POST', { definition: { ...definition.ref, revisionId: definition.currentRevisionId }, input: { resource: resource.ref, title: resource.title }, actor: { kind: 'human' } }), signal: AbortSignal.timeout(30_000) },
  )
  const companion = workspaceResourceReferenceSchema.parse(response.result.resource)
  if (companion.workspaceId !== resource.ref.workspaceId || companion.type !== 'agents.room') throw new Error('Companion creation returned an invalid Room reference')
  return companion
}
