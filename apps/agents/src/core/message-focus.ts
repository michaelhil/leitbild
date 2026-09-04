import type { WorkspaceSubjectReference } from '@leitbild/contracts'
import type { Message } from './types/messaging.ts'

// Browser focus is execution context for the current Agent turn, not chat
// history. A WeakMap preserves it through synchronous Room delivery without
// adding it to the persisted or WebSocket Message shape.
const focusedSubjectsByMessage = new WeakMap<Message, ReadonlyArray<WorkspaceSubjectReference>>()

export const attachMessageFocus = (
  message: Message,
  resources: ReadonlyArray<WorkspaceSubjectReference> | undefined,
): void => {
  if (resources !== undefined) focusedSubjectsByMessage.set(message, resources)
}

export const messageFocus = (message: Message): ReadonlyArray<WorkspaceSubjectReference> | undefined =>
  focusedSubjectsByMessage.get(message)
