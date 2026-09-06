// One ordered view of native tool interactions for Agent retrieval and UI
// inspection. Provider call IDs can repeat between assistant messages in
// retained requests; results belong to their immediately preceding call group.
interface EvidenceMessage {
  readonly role: string
  readonly content: string
  readonly toolCalls?: ReadonlyArray<{
    readonly id?: string
    readonly function: { readonly name: string; readonly arguments: unknown }
  }>
  readonly toolCallId?: string
  readonly name?: string
}

export interface ToolInteraction {
  readonly callIndex: number
  readonly id: string
  readonly name: string
  readonly arguments: unknown
  readonly result?: { readonly content: string; readonly name?: string }
}

export const extractToolInteractions = (messages: ReadonlyArray<EvidenceMessage>): ReadonlyArray<ToolInteraction> => {
  const interactions: ToolInteraction[] = []
  let pending: number[] = []
  for (const message of messages) {
    if (message.role === 'tool') {
      const callIndex = pending.find(index => {
        const interaction = interactions[index]!
        return interaction.id === message.toolCallId && interaction.result === undefined
      })
      if (callIndex !== undefined) {
        interactions[callIndex] = {
          ...interactions[callIndex]!,
          result: { content: message.content, ...(message.name ? { name: message.name } : {}) },
        }
      }
      continue
    }
    pending = []
    if (message.role !== 'assistant' || !message.toolCalls) continue
    for (const [index, call] of message.toolCalls.entries()) {
      const callIndex = interactions.length
      interactions.push({
        callIndex,
        id: call.id ?? `call_${index}`,
        name: call.function.name,
        arguments: call.function.arguments,
      })
      pending.push(callIndex)
    }
  }
  return interactions
}
