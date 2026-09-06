import type { ChatRequest } from '../core/types/llm.ts'

/** Transparent approximation, not a tokenizer or a promise of model fit.
 * Count the complete textual request, including schemas and tool exchanges.
 * Images and opaque continuation are reported separately: charging base64 or
 * encrypted bytes as ordinary text tokens would create false capacity errors.
 */
export const estimateRequestSize = (request: ChatRequest) => {
  let characters = request.systemBlocks?.reduce((sum, block) => sum + block.text.length, 0) ?? 0
  characters += request.tools ? JSON.stringify(request.tools).length : 0
  let images = 0
  let continuationBytes = 0
  for (const message of request.messages) {
    characters += message.content.length + 16 // Approximate role/framing overhead.
    if (message.toolCalls) characters += JSON.stringify(message.toolCalls).length
    if (message.toolCallId) characters += message.toolCallId.length
    if (message.name) characters += message.name.length
    images += message.images?.length ?? 0
    if (message.continuation !== undefined) continuationBytes += Buffer.byteLength(JSON.stringify(message.continuation))
  }
  return { estimatedInputTokens: Math.ceil(characters / 4), requestedOutputTokens: request.maxTokens, images, continuationBytes }
}
