import { z } from 'zod'
import type { RoomDirectory } from '../../core/rooms/directory.ts'
import type { Tool } from '../../core/types/tool.ts'

const inputSchema = z.object({
  messageId: z.string().optional(),
  toolCallId: z.string().optional(),
  part: z.enum(['arguments', 'result']).default('arguments'),
  offset: z.number().int().nonnegative().default(0),
  limit: z.number().int().min(1).max(100).default(10),
}).strict()

// A read of the existing conversation record, not a second artifact/memory
// store. Never accepts another Room id or exposes private system instructions.
export const createConversationReadTool = (rooms: RoomDirectory): Tool => ({
  name: 'conversation_read',
  description: 'Retrieve exact earlier work from this conversation. Without messageId, list recent message references; with messageId, read the message and its tool-call index; with toolCallId, retrieve exact arguments or result. Use this to revise a previous draft without reconstructing it from a prose summary. Old observations are historical, not current state.',
  parameters: z.toJSONSchema(inputSchema, { io: 'input' }),
  execute: async (params, context) => {
    const parsed = inputSchema.safeParse(params)
    if (!parsed.success) return { success: false, error: parsed.error.message }
    const room = context.roomId ? rooms.getRoom(context.roomId) : undefined
    if (!room || !room.getParticipantIds().includes(context.callerId)) {
      return { success: false, error: 'conversation_access_denied: caller must belong to the current Room' }
    }
    const { messageId, toolCallId, part, offset, limit } = parsed.data
    const messages = room.getRecent(room.getMessageCount())
    if (!messageId) {
      if (toolCallId) return {success:false,error:'messageId is required with toolCallId'}
      const ordered = [...messages].reverse()
      return {success:true,data:{
        total:ordered.length, offset, hasMore:offset+limit<ordered.length,
        messages:ordered.slice(offset,offset+limit).map(m=>({
          messageId:m.id,sender:m.senderName??m.senderId,timestamp:m.timestamp,
          preview:m.content.slice(0,240),hasToolEvidence:!!m.toolTrace?.length,
        })),
      }}
    }
    const message = messages.find(m=>m.id===messageId)
    if (!message) return {success:false,error:'conversation_message_unavailable: message was removed or is not in this Room'}
    const record = room.getGenerationQuery(messageId)
    const calls = record?.query.messages.flatMap(m=>m.toolCalls??[]) ?? []
    if (!toolCallId) return {success:true,data:{
      messageId,content:message.content,timestamp:message.timestamp,
      calls:calls.map(call=>({toolCallId:call.id,tool:call.function.name,
        operationIds: Array.isArray(call.function.arguments.calls)
          ? (call.function.arguments.calls as Array<Record<string,unknown>>).map(c=>c.operationId) : undefined,
      })),
    }}
    const call = calls.find(c=>c.id===toolCallId)
    if (!call) return {success:false,error:'conversation_tool_call_unavailable: choose a toolCallId from this message'}
    const result = record?.query.messages.find(m=>m.role==='tool'&&m.toolCallId===toolCallId)
    if(part==='result'&&!result) return {success:false,error:'conversation_result_unavailable: no retained result for this call'}
    return {success:true,data:{messageId,toolCallId,tool:call.function.name,timestamp:message.timestamp,
      [part]:part==='arguments'?call.function.arguments:result!.content,
    }}
  },
})
