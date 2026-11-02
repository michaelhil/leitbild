import type { PresentationPromptLink, PresentationRecipient, PresentationRequest, PresentationReceipt, WorkspaceResourceReference } from '@leitbild/contracts'
import { sameRecipient, sameResource } from './presentation-wire.ts'

export type DraftChoice = 'insert' | 'append' | 'replace'
export interface ChosenDraft { readonly recipient: PresentationRecipient; readonly room: WorkspaceResourceReference; readonly link: PresentationPromptLink; readonly label: string }

/** Browser-local choice and causal correlation. Text editing is never submission or evidence of understanding. */
export const createPresentationComposerModel = (deps: {
  workspaceId: string; roomId: () => string | null; now?: () => number;
  receipt: (receipt: PresentationReceipt) => void;
  evidence: (value: { recipient: PresentationRecipient; room: WorkspaceResourceReference; requestId: string; messageId: string }) => void;
}) => {
  const now = deps.now ?? Date.now
  let recipient: PresentationRecipient | null = null
  let chosen: ChosenDraft | undefined
  const suggestions = new Map<string, { request: PresentationRequest; room: WorkspaceResourceReference }>()
  const posted = new Map<string, { choice: ChosenDraft; messageId?: string }>()
  const terminal = new Map<string, number>()
  const live = (): PresentationRecipient | undefined => recipient !== null && Date.parse(recipient.expiresAt) > now() ? recipient : undefined
  const receipt = (request: PresentationRequest, status: PresentationReceipt['status'], reason?: string): void => {
    if (terminal.has(request.id)) return
    terminal.set(request.id, Date.parse(request.expiresAt) + 30_000) // Owner receipt retention after its 30 s delivery budget.
    deps.receipt({ requestId: request.id, documentId: request.recipient.documentId, status, ...(reason === undefined ? {} : { reason }), at: new Date(now()).toISOString() })
  }
  const hint = (entry: { choice: ChosenDraft; messageId?: string }): void => {
    const current = live()
    if (entry.messageId !== undefined && current !== undefined && sameRecipient(current, entry.choice.recipient)) deps.evidence({ recipient: current, room: entry.choice.room, requestId: entry.choice.link.requestId, messageId: entry.messageId })
  }
  return {
    offer(next: PresentationRecipient | null): void {
      if (next !== null && next.subject.workspaceId !== deps.workspaceId) return
      if (recipient === null || next === null || !sameRecipient(recipient, next)) {
        suggestions.clear(); posted.clear(); terminal.clear(); chosen = undefined
      }
      recipient = next
    },
    recipient: live,
    suggestions: () => [...suggestions.values()],
    chosen: () => chosen,
    unlink: () => { chosen = undefined },
    receive(request: PresentationRequest, room: WorkspaceResourceReference): void {
      for (const [id, expiresAt] of terminal) if (expiresAt <= now()) terminal.delete(id)
      const current = live()
      if (current === undefined || !sameRecipient(current, request.recipient)) return // An old/foreign document gets no acknowledgement.
      if (terminal.has(request.id) || suggestions.has(request.id)) return
      if (Date.parse(request.expiresAt) <= now()) { receipt(request, 'expired'); return }
      if (room.workspaceId !== deps.workspaceId || room.id !== deps.roomId()) { receipt(request, 'unavailable', 'The exact Assistant Room is not open in this document'); return }
      if (suggestions.size >= 16) { receipt(request, 'unavailable', 'Complete or dismiss an existing suggestion first'); return }
      suggestions.set(request.id, { request, room })
    },
    choose(requestId: string, choice: DraftChoice, currentText: string): string | undefined {
      const entry = suggestions.get(requestId), current = live()
      if (entry === undefined || current === undefined || !sameRecipient(current, entry.request.recipient) || entry.room.id !== deps.roomId()) return undefined
      if (Date.parse(entry.request.expiresAt) <= now()) { suggestions.delete(requestId); receipt(entry.request, 'expired'); return undefined }
      if (entry.request.action.kind !== 'draft' || choice === 'insert' && currentText.length !== 0) return undefined
      const value = choice === 'append' && currentText.length !== 0 ? `${currentText}\n${entry.request.action.text}` : entry.request.action.text
      chosen = { recipient: current, room: entry.room, label: entry.request.source.label, link: { requestId, subject: entry.request.recipient.subject, sourceId: entry.request.source.id,
        ...(entry.request.source.executionId === undefined ? {} : { sourceExecutionId: entry.request.source.executionId }) } }
      suggestions.delete(requestId)
      receipt(entry.request, 'applied', 'The person inserted an editable draft; no message has been sent')
      return value
    },
    dismiss(requestId: string): void {
      const entry = suggestions.get(requestId)
      if (entry !== undefined) { suggestions.delete(requestId); receipt(entry.request, 'declined') }
    },
    clear(requestId: string): void { suggestions.delete(requestId); posted.delete(requestId); if (chosen?.link.requestId === requestId) chosen = undefined },
    input(value: string, replacingWholeDraft = false): void { if (value.trim().length === 0 || replacingWholeDraft) chosen = undefined },
    roomChanged(): void { suggestions.clear(); chosen = undefined },
    postContext(roomId: string): { presentationRecipient?: PresentationRecipient; presentationDraft?: PresentationPromptLink } {
      const current = live()
      if (current === undefined) return {}
      if (chosen !== undefined && chosen.room.id === roomId && sameRecipient(chosen.recipient, current)) {
        posted.set(chosen.link.requestId, { choice: { ...chosen, recipient: current } })
        if (posted.size > 16) posted.delete(posted.keys().next().value!) // Same current receiver bound as the owner's pending queue.
        return { presentationRecipient: current, presentationDraft: chosen.link }
      }
      return { presentationRecipient: current }
    },
    submitted(): void { chosen = undefined },
    acknowledge(link: PresentationPromptLink, roomId: string, messageId: string): void {
      const entry = posted.get(link.requestId)
      if (entry === undefined || entry.choice.room.id !== roomId || !sameResource(entry.choice.link.subject, link.subject)
        || entry.choice.link.sourceId !== link.sourceId || entry.choice.link.sourceExecutionId !== link.sourceExecutionId) return
      entry.messageId = messageId
      hint(entry)
    },
    response(inReplyTo: readonly string[]): void { for (const entry of posted.values()) if (entry.messageId !== undefined && inReplyTo.includes(entry.messageId)) hint(entry) },
    refreshEvidence(): void { for (const entry of posted.values()) hint(entry) },
  }
}
