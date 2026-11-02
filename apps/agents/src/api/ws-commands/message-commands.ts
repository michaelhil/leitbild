import type { WSInbound, WSOutbound } from '../../core/types/ws-protocol.ts'
import type { CommandContext } from './types.ts'

export const handleMessageCommand = (msg: WSInbound, ctx: CommandContext): boolean => {
  const { ws, system, wsManager } = ctx

  switch (msg.type) {
    case 'post_message': {
      // The WS session is a viewer; clients must name the human actor explicitly.
      // Validates: present, exists in this Workspace, is a human (AI agents
      // post via the eval path, not WS).
      if (!msg.senderId) {
        wsManager.safeSend(ws, JSON.stringify({ type: 'error', message: 'senderId required for post_message' } satisfies WSOutbound))
        return true
      }
      const sender = system.team.getAgent(msg.senderId)
      if (!sender) {
        wsManager.safeSend(ws, JSON.stringify({ type: 'error', message: `unknown senderId: ${msg.senderId}` } satisfies WSOutbound))
        return true
      }
      if (sender.kind !== 'human') {
        wsManager.safeSend(ws, JSON.stringify({ type: 'error', message: `senderId must be a human agent` } satisfies WSOutbound))
        return true
      }
      if (msg.presentationRecipient !== undefined && (msg.presentationRecipient.subject.workspaceId !== ctx.session.workspaceId
        || msg.presentationRecipient.subject.moduleId !== 'world'
        || Date.parse(msg.presentationRecipient.expiresAt) <= Date.now())) {
        wsManager.safeSend(ws, JSON.stringify({ type: 'error', message: 'presentation_recipient_invalid: use the current World browser offer in this Workspace' } satisfies WSOutbound))
        return true
      }
      if (msg.presentationDraft !== undefined && (msg.target.rooms.length !== 1 || msg.presentationRecipient === undefined
        || JSON.stringify(msg.presentationDraft.subject) !== JSON.stringify(msg.presentationRecipient.subject))) {
        wsManager.safeSend(ws, JSON.stringify({ type: 'error', message: 'presentation_draft_invalid: submit the chosen suggestion to its exact Room and current World browser' } satisfies WSOutbound))
        return true
      }
      const resolved = msg.target ?? {}
      const delivered = system.routeMessage(resolved, {
        senderId: sender.id,
        senderName: sender.name,
        content: msg.content,
        type: 'chat',
        ...(msg.focusedSubjects === undefined ? {} : { focusedSubjects: msg.focusedSubjects }),
        ...(msg.presentationRecipient === undefined ? {} : { presentationRecipient: msg.presentationRecipient }),
        ...(msg.presentationDraft === undefined ? {} : { presentationPrompt: msg.presentationDraft }),
        ...(msg.attachments && msg.attachments.length > 0 ? { attachments: msg.attachments } : {}),
      })
      for (const m of delivered) {
        wsManager.safeSend(ws, JSON.stringify({ type: 'message', message: m } satisfies WSOutbound))
        if (msg.presentationDraft !== undefined) wsManager.safeSend(ws, JSON.stringify({ type: 'presentation_prompt_posted', link: msg.presentationDraft, roomId: m.roomId, messageId: m.id } satisfies WSOutbound))
      }
      return true
    }
    default:
      return false
  }
}
