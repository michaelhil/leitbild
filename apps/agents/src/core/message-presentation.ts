import type { PresentationRecipient } from '@leitbild/contracts'
import type { Message } from './types/messaging.ts'

// A browser delivery address is current turn context, never conversation or
// Profile data. Restored messages and scheduled turns have no recipient.
const recipients = new WeakMap<Message, PresentationRecipient>()

export const attachMessagePresentation = (message: Message, recipient: PresentationRecipient | undefined): void => {
  if (recipient !== undefined) recipients.set(message, structuredClone(recipient))
}

export const messagePresentation = (message: Message): PresentationRecipient | undefined => recipients.get(message)
