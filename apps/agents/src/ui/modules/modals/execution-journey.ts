import type { ExecutionCallSummary, ExecutionTurn } from '../../../core/executions/store.ts'
import type { ExecutionModelCallSummary, ExecutionStage } from '../../../core/executions/model-evidence.ts'
import type { ProviderContinuation } from '../../../core/types/llm.ts'

export interface QueryMessage extends Record<string, unknown> {
  readonly role: string
  readonly content: string
  readonly toolCalls?: ReadonlyArray<{
    readonly id?: string
    readonly function: { readonly name: string; readonly arguments: unknown }
  }>
  readonly toolCallId?: string
  readonly name?: string
  readonly continuation?: ProviderContinuation
}

// Ordinary prompt/tool inspection must not disclose provider protocol payloads.
// The original inspection remains intact for explicit sensitive inspection/copy.
export const readableQueryMessage = (message: QueryMessage): Omit<QueryMessage, 'continuation'> => {
  const { continuation: _continuation, ...readable } = message
  return readable
}

export const continuationMetadata = (messages: ReadonlyArray<QueryMessage>) => messages.flatMap((message, index) => {
  const state = message.continuation
  return state ? [{
    messageIndex: index,
    provider: state.provider,
    model: state.model,
    endpointHash: state.endpointHash,
    detailCount: state.reasoningDetails?.length ?? 0,
    detailTypes: [...new Set(state.reasoningDetails?.map(detail => detail.type).filter(type => typeof type === 'string'))],
    hasReasoning: state.reasoning !== undefined,
    bytes: new TextEncoder().encode(JSON.stringify(state)).byteLength,
  }] : []
})

export interface GenerationQueryInspection {
  readonly messageId: string
  readonly traceId: string
  readonly query: {
    readonly model: string
    readonly messages: ReadonlyArray<QueryMessage>
    readonly tools?: ReadonlyArray<Record<string, unknown> & {
      readonly function?: { readonly name?: string; readonly description?: string; readonly parameters?: unknown }
    }>
    readonly systemBlocks?: ReadonlyArray<{ readonly text: string; readonly cacheable?: boolean }>
    readonly [key: string]: unknown
  }
  readonly generation: Readonly<Record<string, unknown>>
  readonly executionCalls?: ReadonlyArray<unknown>
  readonly startingInput?: unknown
  readonly nestedQueries?: ReadonlyArray<GenerationQueryInspection['query']>
}

export interface ExecutionInspection {
  readonly evidencePath?: string
  readonly turn: ExecutionTurn
  readonly calls: ReadonlyArray<ExecutionCallSummary>
  readonly modelCapture: 'recorded' | 'unavailable'
  readonly models: ReadonlyArray<ExecutionModelCallSummary>
  readonly stages: ReadonlyArray<ExecutionStage>
}

export interface PromptInspectionSection {
  readonly key: string
  readonly label: string
  readonly content: string
}

const PROMPT_LABELS: Readonly<Record<string, string>> = {
  workspace_rules: 'Workspace rules',
  room: 'Room prompt',
  identity: 'Agent identity',
  skills: 'Skills',
  wikis: 'Wiki catalogue',
  response_format: 'Response format',
  context: 'Runtime context',
}

export const extractPromptSections = (systemPrompt: string): ReadonlyArray<PromptInspectionSection> => {
  const sections: PromptInspectionSection[] = []
  const pattern = /<leitbild:([a-z_]+)(?:\s[^>]*)?>([\s\S]*?)<\/leitbild:\1>/g
  for (const match of systemPrompt.matchAll(pattern)) {
    const key = match[1]!
    sections.push({
      key,
      label: PROMPT_LABELS[key] ?? key.replaceAll('_', ' '),
      content: match[2]!.trim(),
    })
  }
  return sections.length > 0
    ? sections
    : [{ key: 'system', label: 'System prompt', content: systemPrompt }]
}

export type JourneyActor = 'context' | 'model' | 'tools' | 'system'
export type JourneyState = 'recorded' | 'running' | 'unknown' | 'warning' | 'failed' | 'cancelled'
export interface JourneyEvent {
  readonly id: string
  readonly actor: JourneyActor
  readonly title: string
  readonly description: string
  readonly state: JourneyState
  readonly at?: number
  readonly finishedAt?: number
  readonly source:
    | { readonly kind: 'model'; readonly call: ExecutionModelCallSummary }
    | { readonly kind: 'tool'; readonly call: ExecutionCallSummary }
    | { readonly kind: 'stage'; readonly stage: ExecutionStage }
    | { readonly kind: 'snapshot'; readonly query: GenerationQueryInspection['query']; readonly label: string }
    | { readonly kind: 'comparison'; readonly record: unknown }
    | { readonly kind: 'starting'; readonly input: unknown }
}

const stageDescription = (stage: ExecutionStage): { title: string; description: string; state: JourneyState; actor: JourneyActor } => {
  const event = stage.event
  switch (event.kind) {
    case 'context_ready': return { title: 'Context ready', description: `${event.messageCount} messages · ${event.toolCount} available tools`, state: 'recorded', actor: 'context' }
    case 'warning': return { title: 'Warning', description: event.message, state: 'warning', actor: 'system' }
    case 'correction': return { title: 'Correction requested', description: event.causes.join(' · '), state: 'warning', actor: 'system' }
    case 'model_fallback': return { title: 'Model changed', description: `${event.preferred} → ${event.effective}`, state: 'warning', actor: 'system' }
    case 'tool_iteration_checkin': return { title: 'Continuation requested', description: `${event.iterations} tool iterations`, state: 'warning', actor: 'system' }
    case 'eval_completed': return { title: `Evaluation ${event.outcome === 'respond' ? 'responded' : event.outcome === 'pass' ? 'passed' : event.outcome}`, description: 'Recorded evaluation outcome', state: event.outcome === 'error' ? 'failed' : event.outcome === 'cancelled' ? 'cancelled' : 'recorded', actor: 'system' }
  }
}

/** A projection of recorded facts. No iterations, tool dispatches or success
 * states are inferred from a later model request or from provider call ids. */
export const buildExecutionJourney = (
  execution?: ExecutionInspection,
  inspection?: GenerationQueryInspection,
): ReadonlyArray<JourneyEvent> => {
  const events: JourneyEvent[] = []
  if (execution) {
    for (const stage of execution.stages) events.push({ id: `stage:${stage.id}`, ...stageDescription(stage), at: stage.at, source: { kind: 'stage', stage } })
    for (const call of execution.models) {
      const state = call.status === 'running' && execution.turn.status !== 'running' ? 'unknown' : call.status === 'completed' ? 'recorded' : call.status
      events.push({
        id: `model:${call.id}`, actor: 'model', title: `Model ${call.ordinal}`,
        description: `${call.phase === 'tool-response' ? 'After tools' : call.phase === 'correction' ? 'Correction' : 'Initial request'} · ${call.model ?? call.requestedModel}`,
        state, at: call.startedAt, finishedAt: call.completedAt, source: { kind: 'model', call },
      })
    }
    for (const call of execution.calls) events.push({
      id: `tool:${call.id}`, actor: 'tools', title: call.tool,
      description: call.completedAt === undefined ? 'Outcome unknown' : 'Result recorded',
      state: call.completedAt === undefined ? 'unknown' : 'recorded', at: call.startedAt,
      finishedAt: call.completedAt, source: { kind: 'tool', call },
    })
  }
  if (inspection) {
    if (inspection.startingInput !== undefined) {
      const input = inspection.startingInput
      const at = input && typeof input === 'object' && 'capturedAt' in input && typeof input.capturedAt === 'number' ? input.capturedAt : undefined
      events.push({ id: 'starting', actor: 'context', title: 'Task starting input', description: `Captured before comparison calls${at === undefined ? ' · untimed' : ''}`, state: 'recorded', at, source: { kind: 'starting', input } })
    }
    if (!execution || execution.modelCapture === 'unavailable') events.push({
      id: 'snapshot:final', actor: 'model', title: 'Final request snapshot', description: 'Retained request · earlier model calls unavailable', state: 'recorded',
      source: { kind: 'snapshot', query: inspection.query, label: 'Final request snapshot' },
    })
    for (const [index, query] of (inspection.nestedQueries ?? []).entries()) events.push({
      id: `snapshot:nested:${index}`, actor: 'model', title: `Nested request ${index + 1}`, description: `${query.model} · untimed snapshot`, state: 'recorded',
      source: { kind: 'snapshot', query, label: `Nested request ${index + 1}` },
    })
    for (const [index, record] of (inspection.executionCalls ?? []).entries()) {
      const call = record && typeof record === 'object' ? record : undefined
      const at = call && 'startedAt' in call && typeof call.startedAt === 'number' ? call.startedAt : undefined
      const finishedAt = call && 'completedAt' in call && typeof call.completedAt === 'number' ? call.completedAt : undefined
      const tool = call && 'tool' in call && typeof call.tool === 'string' ? call.tool : `Call ${index + 1}`
      const observed = call && 'result' in call && call.result !== undefined
      events.push({ id: `comparison:${index}`, actor: 'tools', title: tool, description: `Comparison · ${observed ? 'result recorded' : 'outcome unknown'}${at === undefined ? ' · untimed' : ''}`, state: observed ? 'recorded' : 'unknown', at, finishedAt, source: { kind: 'comparison', record } })
    }
  }
  // Missing times remain separate snapshots, never invented timestamps.
  return events.sort((a, b) => a.at === undefined ? b.at === undefined ? 0 : 1 : b.at === undefined ? -1 : a.at - b.at)
}

export const formatElapsed = (milliseconds: number): string => {
  const seconds = Math.max(0, milliseconds) / 1000
  return seconds < 60 ? `${seconds.toFixed(seconds < 10 ? 1 : 0)} s` : `${Math.floor(seconds / 60)} min ${Math.round(seconds % 60)} s`
}

/** Starting-input/comparison records may also contain message continuations.
 * Ordinary raw inspection redacts protocol at every depth, without mutating
 * the retained record. Complete access remains a deliberate UI action. */
export const readableEvidence = (record: unknown): { readonly value: unknown; readonly protocolPaths: ReadonlyArray<string> } => {
  const paths: string[] = []
  const visit = (value: unknown, path: string): unknown => {
    if (Array.isArray(value)) return value.map((item, index) => visit(item, `${path}[${index}]`))
    if (value === null || typeof value !== 'object') return value
    return Object.fromEntries(Object.entries(value).flatMap(([key, item]) => {
      if (key === 'continuation' && item !== null && typeof item === 'object' && 'provider' in item && typeof item.provider === 'string' && 'model' in item && typeof item.model === 'string' && 'endpointHash' in item && typeof item.endpointHash === 'string') { paths.push(`${path}.${key}`); return [] }
      return [[key, visit(item, `${path}.${key}`)]]
    }))
  }
  return { value: visit(record, 'record'), protocolPaths: paths }
}
