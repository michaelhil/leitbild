import type { WorkspaceRoomScope } from '@leitbild/contracts'

// Reserved retired scope: importing it must fail, never turn it into an ordinary conversation.
export const isRetiredPerspectiveScope = (scope: WorkspaceRoomScope): boolean =>
  scope.kind === 'resource' && scope.resource.moduleId === 'world' && scope.resource.type === 'world.perspective'

export const assertSupportedRoomScope = (scope: WorkspaceRoomScope): void => {
  if (isRetiredPerspectiveScope(scope)) throw Object.assign(new Error('Retired private Room scope is unsupported'), { code: 'retired_private_state' })
}

export const assertNoRetiredProvenance = (value: object): void => {
  if (Object.hasOwn(value, 'perspective')) throw Object.assign(new Error('Retired private conversation provenance is unsupported'), { code: 'retired_private_state' })
}
