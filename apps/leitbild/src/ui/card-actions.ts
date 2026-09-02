import type { ModuleCapabilityDescriptor, ModuleDefinitionDescriptor, ModuleResourceDescriptor } from '@leitbild/contracts'

type Subject = ModuleDefinitionDescriptor | ModuleResourceDescriptor
type Action = 'primary' | 'delete' | 'rename'

export const cardCapability = (
  subject: Subject, action: Action, capabilities: ReadonlyArray<ModuleCapabilityDescriptor>,
): ModuleCapabilityDescriptor | undefined => {
  const id = action === 'delete' ? subject.deleteCapabilityId
    : action === 'primary' ? ('primaryCapabilityId' in subject ? subject.primaryCapabilityId : undefined)
    : ('renameCapabilityId' in subject ? subject.renameCapabilityId : undefined)
  if (id === undefined) return undefined
  const capability = capabilities.find(entry => entry.id === id)
  // Partial Module discovery is reported by the catalog's Module outcomes.
  // An unavailable handler must leave its card inert, never guess an action.
  if (!capability) return undefined
  const scopeMatches = 'currentRevisionId' in subject
    ? capability.scope.kind === 'definition' && capability.scope.definitionType === subject.ref.type
    : capability.scope.kind === 'resource' && capability.scope.resourceType === subject.ref.type
  const required = capability.inputSchema.required
  if (!subject.capabilityIds.includes(capability.id) || !scopeMatches
    || capability.moduleId !== subject.ref.moduleId || capability.kind !== 'command'
    || capability.risk !== (action === 'delete' ? 'destructive' : 'write')
    || (action !== 'rename' && Array.isArray(required) && required.length > 0)) {
    throw new Error(`Invalid ${action} Capability on ${subject.ref.type}: ${id}`)
  }
  return capability
}
