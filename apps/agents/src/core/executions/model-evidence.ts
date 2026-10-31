import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import type { ChatRequest, ProviderContinuation } from '../types/llm.ts'
import type { NativeToolCall } from '../types/tool.ts'
import type { EvalEventCore } from '../types/agent-eval.ts'

export interface ExecutionModelMetrics {
  readonly promptTokens?: number
  readonly lastPromptTokens?: number
  readonly completionTokens?: number
  readonly cacheCreation?: number
  readonly cacheRead?: number
  readonly cacheMiss?: number
  /** Exact provider-reported billing, absent when the provider did not report it. */
  readonly costUsd?: number
  readonly generationId?: string
  readonly upstreamProvider?: string
  readonly modelCalls?: number
  readonly contextMax?: number
  readonly provider?: string
  readonly model?: string
}

export interface ExecutionModelResponse {
  readonly content: string
  readonly toolCalls?: ReadonlyArray<NativeToolCall>
  readonly continuation?: ProviderContinuation
  readonly finishReason?: string
  readonly durationMs: number
  readonly metrics: ExecutionModelMetrics
}

export interface ExecutionModelCallSummary {
  readonly id: string
  readonly ordinal: number
  readonly phase: 'initial' | 'tool-response' | 'correction'
  readonly startedAt: number
  readonly completedAt?: number
  readonly status: 'running' | 'completed' | 'failed' | 'cancelled'
  readonly requestedModel: string
  readonly model?: string
  readonly provider?: string
  readonly requestBytes: number
  readonly responseBytes?: number
  readonly messageCount: number
  readonly toolCount: number
  readonly metrics?: ExecutionModelMetrics
  /** These were requested by the model. Only an existing execution-call
   * record establishes that one was actually dispatched. */
  readonly requestedTools?: ReadonlyArray<{ readonly executionCallId?: string; readonly providerCallId?: string; readonly tool: string }>
}

export interface ExecutionModelCall extends ExecutionModelCallSummary {
  readonly request: ChatRequest
  readonly response?: ExecutionModelResponse
  readonly error?: string
  readonly protocolWithheld: boolean
}

type StageEvent = Exclude<EvalEventCore, { readonly kind: 'chunk' | 'thinking' | 'tool_start' | 'tool_result' | 'context_ready' }>
  | { readonly kind: 'context_ready'; readonly model: string; readonly toolCount: number; readonly messageCount: number }
export interface ExecutionStage { readonly id: string; readonly at: number; readonly event: StageEvent }

export const executionStageEvent = (event: EvalEventCore): StageEvent | undefined => {
  if (event.kind === 'chunk' || event.kind === 'thinking' || event.kind === 'tool_start' || event.kind === 'tool_result') return undefined
  if (event.kind === 'context_ready') return { kind: event.kind, model: event.model, toolCount: event.toolCount, messageCount: event.messages.length }
  return event
}

interface RequestParts {
  readonly settings: string
  readonly messages: ReadonlyArray<string>
  readonly tools?: string
  readonly systemBlocks?: string
}
interface StoredCall { readonly summary: ExecutionModelCallSummary; readonly request: RequestParts; readonly response?: string; readonly error?: string }
interface Manifest { readonly turnId: string; readonly roomId: string; readonly models: ReadonlyArray<StoredCall>; readonly stages: ReadonlyArray<ExecutionStage> }
const hash = (text: string): string => createHash('sha256').update(text).digest('hex')
const id = (value: string): string => {
  if (!/^[a-zA-Z0-9_-]+$/.test(value)) throw new Error('Invalid execution evidence identity')
  return value
}
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/)
const modelSummarySchema = z.object({
  id: z.string().min(1), ordinal: z.number().int().positive(), phase: z.enum(['initial', 'tool-response', 'correction']), startedAt: z.number().finite(),
  completedAt: z.number().finite().optional(), status: z.enum(['running', 'completed', 'failed', 'cancelled']), requestedModel: z.string(),
  model: z.string().optional(), provider: z.string().optional(), requestBytes: z.number().int().nonnegative(), responseBytes: z.number().int().nonnegative().optional(),
  messageCount: z.number().int().nonnegative(), toolCount: z.number().int().nonnegative(), metrics: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
  requestedTools: z.array(z.object({ executionCallId: z.string().optional(), providerCallId: z.string().optional(), tool: z.string() }).strict()).optional(),
}).strict()
const stageEventSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('context_ready'), model: z.string(), toolCount: z.number().int().nonnegative(), messageCount: z.number().int().nonnegative() }).strict(),
  z.object({ kind: z.literal('warning'), message: z.string() }).strict(),
  z.object({ kind: z.literal('model_fallback'), preferred: z.string(), effective: z.string(), reason: z.string() }).strict(),
  z.object({ kind: z.literal('eval_completed'), outcome: z.enum(['respond', 'pass', 'error', 'cancelled']) }).strict(),
  z.object({ kind: z.literal('correction'), causes: z.array(z.enum(['required-view', 'unpresented-view', 'view-fence', 'map-fence', 'contradiction', 'claimed-execution'])), issues: z.array(z.string()) }).strict(),
  z.object({ kind: z.literal('tool_iteration_checkin'), iterations: z.number().int().nonnegative(), roomId: z.string(), recentTools: z.array(z.object({ tool: z.string(), success: z.boolean() }).strict()) }).strict(),
])
const manifestSchema = z.object({
  turnId: z.string(), roomId: z.string(), models: z.array(z.object({
    summary: modelSummarySchema,
    request: z.object({ settings: hashSchema, messages: z.array(hashSchema), tools: hashSchema.optional(), systemBlocks: hashSchema.optional() }).strict(),
    response: hashSchema.optional(), error: z.string().optional(),
  }).strict()),
  stages: z.array(z.object({ id: z.string(), at: z.number().finite(), event: stageEventSchema }).strict()),
}).strict()

const publicRequest = (request: ChatRequest): ChatRequest => ({
  ...request, messages: request.messages.map(({ continuation: _protocol, ...message }) => message),
})
const publicResponse = (response: ExecutionModelResponse): ExecutionModelResponse => {
  const { continuation: _protocol, ...readable } = response
  return readable
}

/** Model-pass evidence belongs to an execution turn. Common request parts are
 * stored once inside that turn, not copied into every prompt snapshot. This
 * is an inspection document beside the existing execution DB, not a database
 * migration, a conversation cache or a second execution engine. */
export const createModelEvidenceStore = (root?: string) => {
  const memory = new Map<string, { manifest: Manifest; parts: Map<string, string> }>()
  const directory = (turnId: string): string => join(root!, id(turnId))
  const atomic = (path: string, text: string): void => {
    const temporary = `${path}.${randomUUID()}.tmp`
    try { writeFileSync(temporary, text, { mode: 0o600 }); renameSync(temporary, path) }
    finally { rmSync(temporary, { force: true }) }
  }
  const read = (turnId: string): Manifest | undefined => {
    if (!root) return memory.get(turnId)?.manifest
    const path = join(directory(turnId), 'manifest.json')
    if (!existsSync(path)) return undefined
    const value = manifestSchema.parse(JSON.parse(readFileSync(path, 'utf8'))) as Manifest
    if (value.turnId !== turnId) throw new Error('Execution model evidence identity does not match its file')
    return value
  }
  const save = (value: Manifest): void => {
    if (!root) { const entry = memory.get(value.turnId); if (!entry) throw new Error('Execution model evidence no longer exists'); entry.manifest = value; return }
    atomic(join(directory(value.turnId), 'manifest.json'), JSON.stringify(value))
  }
  const requireManifest = (turnId: string): Manifest => {
    const value = read(turnId)
    if (!value) throw new Error('Execution model evidence no longer exists; a late completion cannot recreate it')
    return value
  }
  const intern = (turnId: string, value: unknown): string => {
    const text = JSON.stringify(value)
    if (text === undefined) throw new Error('Execution model evidence must be JSON serializable')
    const key = hash(text)
    if (!root) memory.get(turnId)!.parts.set(key, text)
    else {
      const path = join(directory(turnId), 'parts', `${key}.json`)
      if (!existsSync(path)) atomic(path, text)
    }
    return key
  }
  const part = (turnId: string, key: string): unknown => {
    hashSchema.parse(key)
    const text = root ? readFileSync(join(directory(turnId), 'parts', `${key}.json`), 'utf8') : memory.get(turnId)?.parts.get(key)
    if (text === undefined || hash(text) !== key) throw new Error('Execution model evidence content hash does not match')
    return JSON.parse(text)
  }
  const update = (turnId: string, modelId: string, change: (call: StoredCall) => StoredCall): void => {
    const value = requireManifest(turnId), found = value.models.find(call => call.summary.id === modelId)
    if (!found) throw new Error('Execution model call does not exist')
    if (found.summary.status !== 'running') throw new Error('Execution model outcome already recorded')
    save({ ...value, models: value.models.map(call => call === found ? change(call) : call) })
  }
  return {
    begin: (turnId: string, roomId: string): void => {
      if (read(turnId)) throw new Error('Execution model evidence already exists')
      const manifest: Manifest = { turnId, roomId, models: [], stages: [] }
      if (root) { mkdirSync(join(directory(turnId), 'parts'), { recursive: true }); atomic(join(directory(turnId), 'manifest.json'), JSON.stringify(manifest)) }
      else memory.set(turnId, { manifest, parts: new Map() })
    },
    start: (turnId: string, summary: Omit<ExecutionModelCallSummary, 'requestBytes' | 'messageCount' | 'toolCount'>, request: ChatRequest): void => {
      const value = requireManifest(turnId)
      if (value.models.some(call => call.summary.id === summary.id)) throw new Error('Execution model call already exists')
      const { messages, tools, systemBlocks, ...settings } = request
      const parts: RequestParts = { settings: intern(turnId, settings), messages: messages.map(message => intern(turnId, message)),
        ...(tools === undefined ? {} : { tools: intern(turnId, tools) }), ...(systemBlocks === undefined ? {} : { systemBlocks: intern(turnId, systemBlocks) }) }
      save({ ...value, models: [...value.models, { summary: { ...summary, requestBytes: Buffer.byteLength(JSON.stringify(request)), messageCount: messages.length, toolCount: tools?.length ?? 0 }, request: parts }] })
    },
    complete: (turnId: string, modelId: string, response: ExecutionModelResponse, requestedTools: ExecutionModelCallSummary['requestedTools'], completedAt = Date.now()): void => update(turnId, modelId, call => ({
      ...call, response: intern(turnId, response), summary: { ...call.summary, status: 'completed', completedAt, metrics: response.metrics,
        ...(response.metrics.model ? { model: response.metrics.model } : {}), ...(response.metrics.provider ? { provider: response.metrics.provider } : {}),
        responseBytes: Buffer.byteLength(JSON.stringify(response)), ...(requestedTools?.length ? { requestedTools } : {}) },
    })),
    fail: (turnId: string, modelId: string, error: string, cancelled: boolean, partial?: ExecutionModelResponse, completedAt = Date.now()): void => update(turnId, modelId, call => ({
      ...call, error, ...(partial === undefined ? {} : { response: intern(turnId, partial) }),
      summary: { ...call.summary, status: cancelled ? 'cancelled' : 'failed', completedAt,
        ...(partial === undefined ? {} : { responseBytes: Buffer.byteLength(JSON.stringify(partial)), metrics: partial.metrics }) },
    })),
    stage: (turnId: string, event: StageEvent, at = Date.now()): void => {
      const value = requireManifest(turnId)
      save({ ...value, stages: [...value.stages, { id: `stage_${value.stages.length + 1}`, at, event }] })
    },
    summary: (roomId: string, turnId: string): { modelCapture: 'recorded' | 'unavailable'; models: ReadonlyArray<ExecutionModelCallSummary>; stages: ReadonlyArray<ExecutionStage> } => {
      const value = read(turnId)
      if (!value) return { modelCapture: 'unavailable', models: [], stages: [] }
      if (value.roomId !== roomId) throw new Error('Execution model evidence belongs to another Room')
      return { modelCapture: 'recorded', models: value.models.map(call => call.summary), stages: value.stages }
    },
    get: (roomId: string, turnId: string, modelId: string, sensitive = false): ExecutionModelCall | undefined => {
      const value = read(turnId)
      if (!value || value.roomId !== roomId) return undefined
      const call = value.models.find(candidate => candidate.summary.id === modelId)
      if (!call) return undefined
      const request: ChatRequest = { ...part(turnId, call.request.settings) as Omit<ChatRequest, 'messages'>,
        messages: call.request.messages.map(key => part(turnId, key) as ChatRequest['messages'][number]),
        ...(call.request.tools === undefined ? {} : { tools: part(turnId, call.request.tools) as ChatRequest['tools'] }),
        ...(call.request.systemBlocks === undefined ? {} : { systemBlocks: part(turnId, call.request.systemBlocks) as ChatRequest['systemBlocks'] }) }
      const response = call.response === undefined ? undefined : part(turnId, call.response) as ExecutionModelResponse
      const protocolWithheld = !sensitive && (request.messages.some(message => message.continuation !== undefined) || response?.continuation !== undefined)
      return { ...call.summary, request: sensitive ? request : publicRequest(request),
        ...(response === undefined ? {} : { response: sensitive ? response : publicResponse(response) }), ...(call.error === undefined ? {} : { error: call.error }), protocolWithheld }
    },
    // The execution DB has already established this Room/turn ownership.
    // Even a crash before the first manifest left parts must remove them.
    remove: (turnId: string): void => {
      if (root) rmSync(directory(turnId), { recursive: true, force: true }); else memory.delete(turnId)
    },
  }
}
