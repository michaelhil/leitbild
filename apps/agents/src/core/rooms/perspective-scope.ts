import type { WorkspaceRoomScope } from '@leitbild/contracts'

/** A Perspective Room is private even before its owner admission completes.
 * A missing, expired or unreadable admission can never make it an open Room.
 */
export const isPerspectiveScope = (scope: WorkspaceRoomScope): boolean =>
  scope.kind === 'resource' && scope.resource.moduleId === 'world' && scope.resource.type === 'world.perspective'
