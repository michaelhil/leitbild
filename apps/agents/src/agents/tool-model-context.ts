import type { ChatRequest, LLMProvider } from '../core/types/llm.ts'
import type { ToolContext, ToolResult } from '../core/types/tool.ts'
import { callLLM, streamLLM, type LLMCallControls } from './evaluation.ts'

type Observer = NonNullable<LLMCallControls['observer']>
/** One admitted tool invocation owns settings, abort and nested-call identity.
 * Live and comparison execution supply their existing evidence owner; neither
 * can accidentally re-read mutable Profile settings halfway through a tool.
 */
export const createToolModelContext = (options: {
  provider: LLMProvider
  settings: Pick<ChatRequest, 'model' | 'seed' | 'think' | 'reasoningEffort'> | undefined
  signal: AbortSignal
  callId?: string
  observer?: (identity: { id: string; ordinal: number }) => Observer
}): { context: Pick<ToolContext, 'llm' | 'llmStream'>; calls: NonNullable<ToolResult['nestedModelCalls']> } => {
  const settings = structuredClone(options.settings)
  const calls: Array<NonNullable<ToolResult['nestedModelCalls']>[number]> = []
  const parent = options.callId ?? crypto.randomUUID()
  let ordinal = 0
  const controls = (): LLMCallControls => {
    const identity = { id: `nested_${parent}_${++ordinal}`, ordinal }
    const observer = options.observer?.(identity)
    let accounting: (typeof calls)[number] | undefined
    return { signal: options.signal, observer: {
      started: async request => {
        options.signal.throwIfAborted()
        await observer?.started(request)
        accounting = { id: identity.id, metrics: {} }; calls.push(accounting)
      },
      completed: async response => {
        if (accounting) Object.assign(accounting, { metrics: response.metrics })
        await observer?.completed(response)
      },
      failed: async (error, partial) => {
        if (accounting && partial) Object.assign(accounting, { metrics: partial.metrics })
        await observer?.failed(error, partial)
      },
    } }
  }
  return { calls, context: {
    llm: request => {
      if (!settings) throw new Error('Calling Agent model settings are unavailable')
      return callLLM(options.provider, { ...request, ...settings }, controls())
    },
    llmStream: request => {
      if (!settings) throw new Error('Calling Agent model settings are unavailable')
      return streamLLM(options.provider, { ...request, ...settings }, controls())
    },
  } }
}
