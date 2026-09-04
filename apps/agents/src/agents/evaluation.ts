// ============================================================================
// Evaluation — LLM interaction engine with tool loop (ReAct pattern).
//
// evaluate() builds context, calls the LLM, handles native tool calls in a
// loop, and returns a Decision. The `pass` tool allows agents to decline
// responding. All tool calling uses the model's native structured format.
// ============================================================================

import type { AgentResponse, AIAgentConfig } from '../core/types/agent.ts'
import type { ChatRequest, GenerationQuery, LLMCallOptions, LLMProvider } from '../core/types/llm.ts'
import type { EvalEventCore } from '../core/types/agent-eval.ts'
import type { NativeToolCall, ToolCall, ToolDefinition, ToolExecutor, ToolResult } from '../core/types/tool.ts'
import type { ToolTraceEntry } from '../core/types/messaging.ts'
import type { ContextResult, FlushInfo } from './context-builder.ts'
import { classifyLLMError } from './error-classify.ts'
import { extractFences } from './fence-extract.ts'
import { parseMapBody, formatMapErrors } from '../core/render-validators/map-schema.ts'

// Max times the eval loop will ask the LLM to fix an invalid map/geojson
// fence before giving up and posting the broken response (the UI banner
// then takes over). Independent of `maxToolIterations` — a tool-heavy
// agent must not lose fence retries to its tool budget.
// 2 retries observed sufficient in practice: most schema mistakes are fixed
// on the first retry; the second covers cases where the model corrects one
// error and reveals another. Beyond 2, models tend to oscillate. Test
// `evaluation.fence-retry.test.ts` asserts 3 total LLM calls (1 + 2 retries).
export const MAX_FENCE_RETRIES = 2

// === Decision — what the agent wants to do after evaluation ===

export interface Decision {
  readonly response: AgentResponse
  readonly generationMs: number
  readonly triggerRoomId: string
  readonly inReplyTo?: ReadonlyArray<string>
  readonly metrics?: LLMCallMetrics
  // Every tool call this agent made during the turn. Attached only when the
  // agent invoked tools. Forwarded by spawn.onDecision onto the posted Message.
  readonly toolTrace?: ReadonlyArray<ToolTraceEntry>
  // Exact provider-independent request used for the final model call. Kept
  // outside the visible Message and attached to it in the Room's inspection
  // store by spawn.ts.
  readonly generationQuery?: GenerationQuery
  readonly generationTraceId?: string
}

export type OnDecision = (decision: Decision) => void

// === Native tool call conversion ===

const nativeCallsToToolCalls = (native: ReadonlyArray<NativeToolCall>): ReadonlyArray<ToolCall> =>
  native.map((tc, index) => ({ callId: tc.id ?? `call_${index}`, tool: tc.function.name, arguments: tc.function.arguments }))

// === Tool result injection ===
//
// No artificial cap on tool result size. Fence-emitting tools
// (procedure_lookup, norway_platforms, the map/mermaid/
// geojson tools) routinely produce 5-50 KB payloads that MUST reach the
// model intact — truncating mid-fence breaks the renderer downstream.
// If a tool genuinely returns runaway output, fix the tool; do not paper
// over it here.

// Render a tool's `data` field for inclusion in the LLM's next turn.
//
// String results pass through verbatim (no JSON.stringify wrapping, which
// would add `"..."` quote-wrapping and escape every newline as `\n`,
// forcing the model to mentally unescape before pasting). This is the
// single most-impactful fix for fence-emitting tools like norway_platforms
// and procedure_lookup: the fence reaches the model with real newlines
// and no escape clutter.
//
// Object/array results stay compact. Pretty-printing is a Client concern;
// indentation more than doubled large operational payloads in model context.
//
// Other primitives (number, boolean, null) JSON-stringify cleanly.
export const formatToolDataForLLM = (data: unknown): string => {
  if (typeof data === 'string') return data
  // null / undefined → empty string; agents see a blank result instead of
  // the four-character literal "null".
  if (data === null || data === undefined) return ''
  try { return JSON.stringify(data) } catch {
    // Circular or otherwise un-serialisable — fall back to String() so the
    // tool result still reaches the LLM (even if uninformative).
    return String(data)
  }
}

const formatToolResult = (result: ToolResult): string => result.success
  ? formatToolDataForLLM(result.data)
  : JSON.stringify({ success: false, error: result.error ?? 'Tool failed', ...(result.data === undefined ? {} : { details: result.data }) })

const messageTokens = (message: ChatRequest['messages'][number]): number =>
  Math.ceil((message.content.length + (message.toolCalls ? JSON.stringify(message.toolCalls).length : 0)) / 4)

const fitToolEvidence = (
  context: Array<ChatRequest['messages'][number]>,
  assistant: ChatRequest['messages'][number],
  tools: ReadonlyArray<ChatRequest['messages'][number]>,
  tokenBudget: number | undefined,
): { droppedHistory: number; overBudget: boolean } => {
  if (!tokenBudget || tokenBudget <= 0) {
    context.push(assistant, ...tools)
    return { droppedHistory: 0, overBudget: false }
  }
  const lastUser = context.findLastIndex(message => message.role === 'user')
  context.push(assistant, ...tools)
  let total = context.reduce((sum, message) => sum + messageTokens(message), 0)
  let droppedHistory = 0
  const protectedIndex = lastUser >= 0 ? lastUser : context.length - tools.length - 1
  while (total > tokenBudget && context.length > 1 && 1 < protectedIndex - droppedHistory) {
    const removed = context.splice(1, 1)[0]
    if (!removed) break
    total -= messageTokens(removed)
    droppedHistory++
  }
  // Fresh tool evidence is authoritative and may reflect a mutation that has
  // already happened. Never rewrite or truncate it after execution: doing so
  // can make the model repeat a side effect. Retrieval capabilities must bound
  // or paginate their own output. If protected evidence still does not fit,
  // keep it intact and surface a loud warning/provider error.
  return { droppedHistory, overBudget: total > tokenBudget }
}

// === Evaluate — single LLM call with tool loop ===

export interface EvalResult {
  readonly decision: Decision
  readonly flushInfo: FlushInfo
}

// === LLM call shape ===
// LLMService applies cooldown skip, chain walk, network retry, content
// strip, and observability. The agent layer just streams the result. No
// per-agent retry policy.

export interface LLMCallMetrics {
  readonly promptTokens?: number
  readonly completionTokens?: number
  // Prompt-cache hit metrics surfaced through the posted message so cache
  // efficacy is observable in the JSONL log without dashboard inspection.
  readonly cacheCreation?: number
  readonly cacheRead?: number
  readonly cacheMiss?: number
  readonly modelCalls?: number
  readonly contextMax?: number
  readonly provider?: string
  readonly model?: string
}

const sumMetric = (left: number | undefined, right: number | undefined): number | undefined =>
  left === undefined && right === undefined ? undefined : (left ?? 0) + (right ?? 0)

const mergeMetrics = (current: LLMCallMetrics, next: LLMCallMetrics): LLMCallMetrics => ({
  ...(sumMetric(current.promptTokens, next.promptTokens) === undefined ? {} : { promptTokens: sumMetric(current.promptTokens, next.promptTokens) }),
  ...(sumMetric(current.completionTokens, next.completionTokens) === undefined ? {} : { completionTokens: sumMetric(current.completionTokens, next.completionTokens) }),
  ...(sumMetric(current.cacheCreation, next.cacheCreation) === undefined ? {} : { cacheCreation: sumMetric(current.cacheCreation, next.cacheCreation) }),
  ...(sumMetric(current.cacheRead, next.cacheRead) === undefined ? {} : { cacheRead: sumMetric(current.cacheRead, next.cacheRead) }),
  ...(sumMetric(current.cacheMiss, next.cacheMiss) === undefined ? {} : { cacheMiss: sumMetric(current.cacheMiss, next.cacheMiss) }),
  modelCalls: (current.modelCalls ?? 0) + 1,
  ...(next.contextMax ?? current.contextMax ? { contextMax: next.contextMax ?? current.contextMax } : {}),
  ...(next.provider ?? current.provider ? { provider: next.provider ?? current.provider } : {}),
  ...(next.model ?? current.model ? { model: next.model ?? current.model } : {}),
})

// One LLM call: either streams chunks to onEvent or falls back to a
// non-streaming chat(). Caller-visible result is identical either way.
const callLLMOnce = async (
  provider: LLMProvider,
  request: ChatRequest,
  onEvent?: (e: EvalEventCore) => void,
  signal?: AbortSignal,
): Promise<{ content: string; toolCalls?: ReadonlyArray<NativeToolCall>; durationMs: number; metrics: LLMCallMetrics }> => {
  const startMs = performance.now()

  if (provider.stream) {
    let content = ''
    let toolCalls: ReadonlyArray<NativeToolCall> | undefined
    let metrics: LLMCallMetrics = {}
    for await (const chunk of provider.stream(request, signal)) {
      if (chunk.thinking) onEvent?.({ kind: 'thinking', delta: chunk.thinking })
      if (chunk.slowWarning) {
        const elapsedS = Math.round(chunk.slowWarning.elapsedMs / 1000)
        onEvent?.({
          kind: 'warning',
          message: `Provider "${chunk.slowWarning.provider}" hasn't sent a chunk in ${elapsedS}s — the model may be reasoning or the provider may be slow. Use the Stop button to cancel, or wait. Will switch automatically if the stream stalls completely.`,
        })
      }
      if (chunk.delta) {
        content += chunk.delta
        onEvent?.({ kind: 'chunk', delta: chunk.delta })
      }
      if (chunk.done) {
        if (chunk.toolCalls?.length) toolCalls = chunk.toolCalls
        metrics = {
          promptTokens: chunk.tokensUsed?.prompt,
          completionTokens: chunk.tokensUsed?.completion,
          ...(chunk.tokensUsed?.cacheCreation !== undefined ? { cacheCreation: chunk.tokensUsed.cacheCreation } : {}),
          ...(chunk.tokensUsed?.cacheRead !== undefined ? { cacheRead: chunk.tokensUsed.cacheRead } : {}),
          ...(chunk.tokensUsed?.cacheMiss !== undefined ? { cacheMiss: chunk.tokensUsed.cacheMiss } : {}),
          contextMax: chunk.contextMax,
          provider: chunk.provider,
          model: request.model,
        }
      }
    }
    return { content: content.trim(), toolCalls, durationMs: Math.round(performance.now() - startMs), metrics }
  }

  const response = await provider.chat(request)
  onEvent?.({ kind: 'chunk', delta: response.content })
  return {
    content: response.content,
    toolCalls: response.toolCalls,
    durationMs: response.generationMs,
    metrics: {
      promptTokens: response.tokensUsed.prompt,
      completionTokens: response.tokensUsed.completion,
      ...(response.tokensUsed.cacheCreation !== undefined ? { cacheCreation: response.tokensUsed.cacheCreation } : {}),
      ...(response.tokensUsed.cacheRead !== undefined ? { cacheRead: response.tokensUsed.cacheRead } : {}),
      ...(response.tokensUsed.cacheMiss !== undefined ? { cacheMiss: response.tokensUsed.cacheMiss } : {}),
      contextMax: response.contextMax,
      provider: response.provider,
      model: request.model,
    },
  }
}

// === Map-fence validation + retry ===
//
// Validate every ```map and ```geojson fence in the response content. If
// any are invalid, append a synthetic correction prompt to the conversation
// context and re-call the LLM. Repeat up to MAX_FENCE_RETRIES times. Returns
// the final response content (corrected if a retry succeeded; the last
// attempt's content if all retries failed — the UI banner then shows the
// errors below the fence).
//
// Map-only by design: mermaid's parser is browser-only; a server-side
// validator would only catch trivial cases (oversized, completely wrong
// keyword) and miss real syntax errors. Honest scoping > pretend-bulletproof.
const validateAllMapFences = (content: string): { ok: boolean; errors: string } => {
  const fences = extractFences(content, ['map', 'geojson'])
  if (fences.length === 0) return { ok: true, errors: '' }
  const errorParts: string[] = []
  for (const fence of fences) {
    const result = parseMapBody(fence.body)
    if (!result.ok) {
      errorParts.push(
        `\`\`\`${fence.language}\` block at content line ${fence.startLine}:\n${formatMapErrors(result.errors)}`,
      )
    }
  }
  return errorParts.length === 0
    ? { ok: true, errors: '' }
    : { ok: false, errors: errorParts.join('\n\n') }
}

const retryInvalidMapFences = async (
  initialContent: string,
  context: Array<ChatRequest['messages'][number]>,
  config: AIAgentConfig,
  llmProvider: LLMProvider,
  signal: AbortSignal | undefined,
  onEvent: ((event: EvalEventCore) => void) | undefined,
  systemBlocks: ContextResult['systemBlocks'],
  toolDefinitions: ReadonlyArray<ToolDefinition> | undefined,
  addGenerationMs: (ms: number) => void,
  addMetrics: (m: LLMCallMetrics) => void,
  captureRequest: (request: ChatRequest) => void,
): Promise<string> => {
  let content = initialContent
  for (let attempt = 0; attempt < MAX_FENCE_RETRIES; attempt++) {
    const validation = validateAllMapFences(content)
    if (validation.ok) return content
    // Append the invalid response + a precise correction prompt. The next
    // LLM call will see (a) what it just emitted, (b) why it failed,
    // (c) instruction to re-emit a corrected version.
    context.push({ role: 'assistant' as const, content })
    context.push({
      role: 'user' as const,
      content:
        `Your previous response contained one or more invalid map fences:\n\n${validation.errors}\n\n` +
        `Re-emit the FULL corrected response (keep the surrounding prose, fix the fence schema). ` +
        `Refer to the rendering skill for the canonical schema.`,
    })
    if (signal?.aborted) return content
    const request: ChatRequest = {
      model: config.model,
      messages: context as ReadonlyArray<{ role: 'system' | 'user' | 'assistant'; content: string }>,
      temperature: config.temperature,
      ...(config.seed !== undefined ? { seed: config.seed } : {}),
      tools: toolDefinitions,
      think: config.thinking,
      ...(systemBlocks ? { systemBlocks } : {}),
    }
    captureRequest(request)
    const stream = await callLLMOnce(llmProvider, request, onEvent, signal)
    addGenerationMs(stream.durationMs)
    addMetrics(stream.metrics)
    content = stream.content.trim()
    if (content.length === 0) {
      // Empty correction attempt — give up and return the prior content.
      return initialContent
    }
  }
  // Exhausted retries — return the last attempt as-is. The UI's per-fence
  // validation banner will render the errors to the user, who can prompt
  // for another correction manually.
  return content
}

// === Main evaluation loop ===

export interface EvalOptions {
  readonly toolDefinitions?: ReadonlyArray<ToolDefinition>
  readonly inReplyTo?: ReadonlyArray<string>
  readonly onEvent?: (event: EvalEventCore) => void
  readonly signal?: AbortSignal
  // Optional operator-configured tool-iteration check-in. Returns true to
  // continue this turn without another quota, or false to stop (user clicked
  // Stop, abandonment timeout fired, or cancellation was signalled). Agents
  // without an explicit threshold rely on their
  // retrieval guidance and normal cancellation rather than a hidden quota.
  readonly requestToolCheckin?: (info: {
    readonly iterations: number
    readonly recentTools: ReadonlyArray<{ readonly tool: string; readonly success: boolean }>
  }) => Promise<boolean>
}

export const evaluate = async (
  contextResult: ContextResult,
  config: AIAgentConfig,
  llmProvider: LLMProvider,
  toolExecutor: ToolExecutor | undefined,
  maxToolIterations: number | undefined,
  triggerRoomId: string,
  options?: EvalOptions,
): Promise<EvalResult> => {
  const context: Array<ChatRequest['messages'][number]> = [...contextResult.messages]
  let totalGenerationMs = 0
  let metrics: LLMCallMetrics = { modelCalls: 0 }
  const { toolDefinitions, inReplyTo, onEvent, signal, requestToolCheckin } = options ?? {}
  // Optional mutable operator threshold. Undefined means there is no hidden
  // engine quota; the Agent decides when it has enough evidence.
  let effectiveMaxIterations = maxToolIterations

  // Accumulates one entry per tool call across every loop iteration. Attached
  // to the final Decision — lets downstream consumers (export_room, UI)
  // reconstruct what the agent actually did before answering.
  const toolTrace: Array<ToolTraceEntry> = []
  let lastGenerationQuery: GenerationQuery | undefined
  const captureRequest = (request: ChatRequest): void => {
    // ChatRequest is JSON-shaped. Clone at the call boundary so subsequent
    // tool-loop context mutation cannot rewrite the audit record.
    lastGenerationQuery = JSON.parse(JSON.stringify(request)) as GenerationQuery
  }

  // Cap preview at 200 chars — this is a debugging/analysis aid for the
  // UI trace panel, not context fed to the LLM, and arbitrarily long
  // previews would bloat every message blob the UI ships.
  const PREVIEW_MAX = 200
  const previewFor = (result: ToolResult): string => {
    const raw = result.success
      ? JSON.stringify(result.data ?? null)
      : (result.error ?? '')
    return raw.length > PREVIEW_MAX ? `${raw.slice(0, PREVIEW_MAX)}…` : raw
  }
  const traceArguments = (tool: string, value: Record<string, unknown>): Pick<ToolTraceEntry, 'argumentKeys' | 'argumentBytes' | 'capabilityId' | 'target'> => {
    const serialized = JSON.stringify(value)
    const targetValue = value.definition ?? value.resource
    const target = typeof targetValue === 'object' && targetValue !== null
      ? ['moduleId', 'type', 'id', 'revisionId']
        .flatMap(key => typeof (targetValue as Record<string, unknown>)[key] === 'string' ? [(targetValue as Record<string, unknown>)[key] as string] : [])
        .join('/')
      : undefined
    return {
      argumentKeys: Object.keys(value).slice(0, 32),
      argumentBytes: new TextEncoder().encode(serialized).byteLength,
      ...(tool === 'workspace_invoke' && typeof value.capabilityId === 'string' ? { capabilityId: value.capabilityId } : {}),
      ...(target ? { target } : {}),
    }
  }

  const makeResult = (decision: Decision): EvalResult => {
    // Emit `eval_completed` exactly once per evaluate() call. This is the
    // single source of truth for "this agent is done" — anything that
    // previously polled agent.state can rely on this firing on every
    // terminal path because every `return` in evaluate() routes through
    // makeResult.
    onEvent?.({ kind: 'eval_completed', outcome: decision.response.action })
    return {
      decision: {
        ...(inReplyTo && inReplyTo.length > 0 ? { ...decision, inReplyTo } : decision),
        metrics,
        ...(toolTrace.length > 0 ? { toolTrace: [...toolTrace] } : {}),
        ...(lastGenerationQuery ? { generationQuery: lastGenerationQuery } : {}),
      },
      flushInfo: contextResult.flushInfo,
    }
  }

  // Track the latest non-empty text the model emitted across tool rounds.
  // When the loop hits maxToolIterations we surface this to the user along
  // with the pass reason, instead of replacing the streamed text with a bare
  // [pass] message — that was a bad UX where you'd see the agent typing,
  // then watch its message get deleted and replaced with a terse error.
  let lastAssistantText = ''

  try {
    for (let toolRound = 0; ; toolRound++) {
      const request: ChatRequest = {
        model: config.model,
        messages: context as ReadonlyArray<{ role: 'system' | 'user' | 'assistant'; content: string }>,
        temperature: config.temperature,
        ...(config.seed !== undefined ? { seed: config.seed } : {}),
        tools: toolDefinitions,
        think: config.thinking,
        ...(contextResult.systemBlocks ? { systemBlocks: contextResult.systemBlocks } : {}),
      }

      captureRequest(request)
      const streamResult = await callLLMOnce(llmProvider, request, onEvent, signal)
      totalGenerationMs += streamResult.durationMs
      metrics = mergeMetrics(metrics, streamResult.metrics)

      // Native tool calls
      if (streamResult.toolCalls && streamResult.toolCalls.length > 0) {
        // Hold on to any text the model emitted before/alongside the tool
        // calls — the user just watched it stream in. If we end up exhausting
        // iterations, this is what we restore so the chat doesn't blank out.
        if (streamResult.content && streamResult.content.trim().length > 0) {
          lastAssistantText = streamResult.content.trim()
        }
        const calls = nativeCallsToToolCalls(streamResult.toolCalls)

        // pass tool → return pass decision without executing
        if (calls.length === 1 && calls[0]!.tool === 'pass') {
          return makeResult({ response: { action: 'pass', reason: (calls[0]!.arguments.reason as string) ?? 'nothing to add' }, generationMs: totalGenerationMs, triggerRoomId })
        }

        if (!toolExecutor) {
          return makeResult({
            response: { action: 'error', code: 'tools_unavailable', message: 'Model emitted tool calls but no executor is wired' },
            generationMs: totalGenerationMs,
            triggerRoomId,
          })
        }

        for (let i = 0; i < calls.length; i++) {
          const call = calls[i]!
          onEvent?.({ kind: 'tool_start', tool: call.tool, callId: call.callId ?? String(i) })
        }
        const results = await toolExecutor(calls, triggerRoomId, signal)
        for (let i = 0; i < results.length; i++) {
          const call = calls[i]
          const result = results[i]
          if (!call || !result) continue
          onEvent?.({ kind: 'tool_result', tool: call.tool, callId: call.callId ?? String(i), success: result.success, preview: result.success ? undefined : result.error })
          toolTrace.push({
            tool: call.tool,
            ...traceArguments(call.tool, call.arguments),
            success: result.success,
            resultPreview: previewFor(result),
          })
        }
        const normalizedNativeCalls = streamResult.toolCalls.map((call, index) => ({ ...call, id: calls[index]?.callId ?? `call_${index}` }))
        const assistantToolMessage: ChatRequest['messages'][number] = { role: 'assistant', content: streamResult.content, toolCalls: normalizedNativeCalls }
        const toolMessages: Array<ChatRequest['messages'][number]> = []
        for (let i = 0; i < results.length; i++) {
          const call = calls[i]
          const result = results[i]
          if (!call || !result) continue
          toolMessages.push({ role: 'tool', toolCallId: call.callId ?? `call_${i}`, name: call.tool, content: formatToolResult(result) })
        }
        const fit = fitToolEvidence(context, assistantToolMessage, toolMessages, contextResult.tokenBudget)
        if (fit.overBudget) onEvent?.({ kind: 'warning', message: 'Current request and tool evidence exceed the model context budget. Evidence was preserved intact; use a narrower or paginated read.' })
        if (fit.droppedHistory > 0) onEvent?.({ kind: 'warning', message: `Dropped ${fit.droppedHistory} oldest context messages to retain current tool evidence.` })

        if (effectiveMaxIterations !== undefined && toolRound + 1 > effectiveMaxIterations) {
          if (requestToolCheckin) {
            const recentTools = toolTrace.slice(-3).map(t => ({ tool: t.tool, success: t.success }))
            onEvent?.({
              kind: 'tool_iteration_checkin',
              iterations: toolRound + 1,
              roomId: triggerRoomId,
              recentTools,
            })
            const shouldContinue = await requestToolCheckin({ iterations: toolRound + 1, recentTools })
            if (!shouldContinue) break
            // A human explicitly chose to continue this turn. Hand control
            // back to the Agent instead of imposing another arbitrary block.
            effectiveMaxIterations = undefined
          } else {
            break
          }
        }
        continue
      }

      // No tool calls → response text is the message.
      const content = streamResult.content.trim()
      if (content.length === 0) {
        return makeResult({
          response: { action: 'error', code: 'empty_response', message: 'LLM returned no content and no tool calls' },
          generationMs: totalGenerationMs,
          triggerRoomId,
        })
      }
      // Map-fence retry loop: validate any ```map / ```geojson fences in
      // the response. If invalid, append a synthetic correction prompt to
      // context and re-call the LLM up to MAX_FENCE_RETRIES times. Each
      // retry streams live (the user sees the rewrite); only the final
      // response is committed via makeResult. Retry budget is independent
      // of toolRound — fence retries don't consume tool-iteration budget.
      //
      // Map-only on purpose: mermaid's parser is browser-only and a
      // server-side validator would be a smell-test, not a real check.
      // Honest scoping > pretending to bulletproof.
      const finalContent = await retryInvalidMapFences(
        content,
        context,
        config,
        llmProvider,
        signal,
        onEvent,
        contextResult.systemBlocks,
        toolDefinitions,
        (ms) => { totalGenerationMs += ms },
        (m) => {
          metrics = mergeMetrics(metrics, m)
        },
        captureRequest,
      )
      return makeResult({ response: { action: 'respond', content: finalContent }, generationMs: totalGenerationMs, triggerRoomId })
    }

    // Max iterations reached. If the model produced any visible text along
    // the way, deliver it with a footer instead of replacing it with a bare
    // pass. Without this, the user sees streamed text disappear and a terse
    // [pass] error take its place.
    const loopReason = `Tool call loop reached the configured ${effectiveMaxIterations} iteration threshold`
    if (lastAssistantText.length > 0) {
      return makeResult({
        response: {
          action: 'respond',
          content: `${lastAssistantText}\n\n_⚠ ${loopReason} — partial result._`,
        },
        generationMs: totalGenerationMs,
        triggerRoomId,
      })
    }
    return makeResult({
      response: { action: 'error', code: 'tool_loop_exceeded', message: loopReason },
      generationMs: totalGenerationMs,
      triggerRoomId,
    })
  } catch (err) {
    const classified = classifyLLMError(err)
    // LLMService attaches `remediation` to thrown errors derived from the
    // structured attempts[] array. When present, append to the user-visible
    // message so the agent's error bubble includes actionable next steps
    // ("Set a fallback chain in Settings → Providers", etc.) rather than
    // just the raw upstream string.
    const remediation = (err as { remediation?: string }).remediation
    const message = remediation && remediation.length > 0
      ? `${classified.message}\n\n${remediation}`
      : classified.message
    onEvent?.({ kind: 'warning', message })
    return makeResult({
      response: {
        action: 'error',
        code: classified.code,
        message,
        ...(classified.providerHint ? { providerHint: classified.providerHint } : {}),
      },
      generationMs: totalGenerationMs,
      triggerRoomId,
    })
  }
}

// === Standalone LLM call ===
// Single-shot call with no agent state, no history management, no protocol parsing.
// Returns raw model output. Use jsonMode for structured extraction.
// Tool loop support is planned for a future phase — for now, tools are not supported.

export const callLLM = async (
  provider: LLMProvider,
  options: LLMCallOptions,
): Promise<string> => {
  const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = []
  if (options.systemPrompt) {
    messages.push({ role: 'system', content: options.systemPrompt })
  }
  for (const m of options.messages) messages.push(m)
  const response = await provider.chat({
    model: options.model,
    messages,
    temperature: options.temperature,
    ...(options.seed !== undefined ? { seed: options.seed } : {}),
    jsonMode: options.jsonMode,
  })
  return response.content
}

// Streaming variant — yields raw deltas as they arrive. Falls back to callLLM if
// the provider does not support streaming, emitting the full response as one chunk.
export const streamLLM = async function* (
  provider: LLMProvider,
  options: LLMCallOptions,
): AsyncGenerator<string> {
  const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = []
  if (options.systemPrompt) messages.push({ role: 'system', content: options.systemPrompt })
  for (const m of options.messages) messages.push(m)

  const request = {
    model: options.model,
    messages,
    temperature: options.temperature,
    ...(options.seed !== undefined ? { seed: options.seed } : {}),
    jsonMode: options.jsonMode,
  }

  if (provider.stream) {
    for await (const chunk of provider.stream(request)) {
      if (chunk.delta) yield chunk.delta
    }
  } else {
    // Provider doesn't support streaming — emit full response as a single delta
    const response = await provider.chat(request)
    yield response.content
  }
}
