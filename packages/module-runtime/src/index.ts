import {
  moduleCapabilityCollectionSchema,
  moduleCapabilityDescriptorSchema,
  type ModuleCapabilityDescriptor,
  type ModuleCapabilityDescriptorInput,
  type ModuleCapabilityInvocation,
  type ModuleId,
} from '@leitbild/contracts'

export type CapabilityRegistration<TContext, TResult> = Readonly<{
  descriptor: ModuleCapabilityDescriptorInput
  invoke: (context: TContext, invocation: ModuleCapabilityInvocation) => Promise<TResult>
}>

export type ModuleCapabilityRegistry<TContext, TResult> = Readonly<{
  descriptors: ReadonlyArray<ModuleCapabilityDescriptor>
  idsForResourceType: (resourceType: string) => ReadonlyArray<string>
  invoke: (
    capabilityId: string,
    context: TContext,
    invocation: ModuleCapabilityInvocation,
  ) => Promise<TResult | undefined>
}>

const assertInvocationScope = (
  descriptor: ModuleCapabilityDescriptor,
  invocation: ModuleCapabilityInvocation,
): void => {
  if (descriptor.scope.kind === 'workspace') {
    if (invocation.resource !== undefined) {
      throw new Error(`Workspace Capability ${descriptor.id} does not accept a Resource`)
    }
    return
  }

  if (invocation.resource === undefined) {
    throw new Error(`Resource Capability ${descriptor.id} requires a Resource`)
  }
  if (
    invocation.resource.moduleId !== descriptor.moduleId
    || invocation.resource.type !== descriptor.scope.resourceType
  ) {
    throw new Error(
      `Capability ${descriptor.id} requires a ${descriptor.scope.resourceType} Resource`,
    )
  }
}

export const createModuleCapabilityRegistry = <TContext, TResult>(
  moduleId: ModuleId,
  registrations: ReadonlyArray<CapabilityRegistration<TContext, TResult>>,
): ModuleCapabilityRegistry<TContext, TResult> => {
  const byId = new Map<string, Readonly<{
    descriptor: ModuleCapabilityDescriptor
    invoke: CapabilityRegistration<TContext, TResult>['invoke']
  }>>()

  for (const registration of registrations) {
    const descriptor = moduleCapabilityDescriptorSchema.parse(registration.descriptor)
    if (descriptor.moduleId !== moduleId) {
      throw new Error(`Capability ${descriptor.id} does not belong to Module ${moduleId}`)
    }
    if (byId.has(descriptor.id)) throw new Error(`Duplicate Capability registration: ${descriptor.id}`)
    byId.set(descriptor.id, { ...registration, descriptor })
  }

  const descriptors = Object.freeze(
    moduleCapabilityCollectionSchema.parse({
      capabilities: [...byId.values()].map(registration => registration.descriptor),
    }).capabilities,
  )

  return Object.freeze({
    descriptors,
    idsForResourceType: (resourceType: string): ReadonlyArray<string> => descriptors
      .filter(descriptor => descriptor.scope.kind === 'resource' && descriptor.scope.resourceType === resourceType)
      .map(descriptor => descriptor.id),
    invoke: async (
      capabilityId: string,
      context: TContext,
      invocation: ModuleCapabilityInvocation,
    ): Promise<TResult | undefined> => {
      const registration = byId.get(capabilityId)
      if (registration === undefined) return undefined
      if (invocation.capabilityId !== capabilityId) {
        throw new Error('Invocation Capability does not match the requested Capability')
      }
      assertInvocationScope(registration.descriptor, invocation)
      return await registration.invoke(context, invocation)
    },
  })
}
