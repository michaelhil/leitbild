import type { WorkspaceResourceReference } from '@leitbild/contracts'
import type { Message } from './types/messaging.ts'

// Browser focus is execution context for the current Agent turn, not chat
// history. A WeakMap preserves it through synchronous Room delivery without
// adding it to the persisted or WebSocket Message shape.
const focusedResourcesByMessage = new WeakMap<Message, ReadonlyArray<WorkspaceResourceReference>>()

export const attachMessageFocus = (
  message: Message,
  resources: ReadonlyArray<WorkspaceResourceReference> | undefined,
): void => {
  if (resources !== undefined) focusedResourcesByMessage.set(message, resources)
}

export const messageFocus = (message: Message): ReadonlyArray<WorkspaceResourceReference> | undefined =>
  focusedResourcesByMessage.get(message)
