/** Offline, opt-in replay of an immutable inspected execution. No provider,
 * network socket or World control is called. Captured Module bodies pass
 * through the real broker; synthetic checkpoint choices are not Agent success.
 *
 * bun run packages/integration-tests/tests/working-context-capture-replay.ts \
 *   <capture.json> <actual-billing.json> <private-final-model.json> <output-directory>
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  moduleCapabilityCollectionSchema, newWorkspaceId, workspaceCapabilityCatalogSchema,
  workspaceDefinitionCatalogSchema, workspaceResourceCatalogSchema, workspaceResourceReferenceSchema,
  type ModuleCapabilityDescriptor, type WorkspaceRoomScope,
} from '@leitbild/contracts'
import { createExecutionStore, type ExecutionCall } from '../../../apps/agents/src/core/executions/store.ts'
import { createToolRegistry } from '../../../apps/agents/src/core/tool-registry.ts'
import { createRoom } from '../../../apps/agents/src/core/rooms/room.ts'
import type { RoomDirectory } from '../../../apps/agents/src/core/rooms/directory.ts'
import type { ChatRequest, LLMProvider } from '../../../apps/agents/src/core/types/llm.ts'
import type { NativeToolCall, Tool, ToolResult } from '../../../apps/agents/src/core/types/tool.ts'
import type { ExecutionModelCall } from '../../../apps/agents/src/core/executions/model-evidence.ts'
import { createModelEvidenceStore, executionStageEvent } from '../../../apps/agents/src/core/executions/model-evidence.ts'
import { createWorkingContextArchive, type ContextCheckpointInput, type ContextCheckpointManifest } from '../../../apps/agents/src/core/working-context.ts'
import { createWorkspaceCapabilityTools } from '../../../apps/agents/src/tools/built-in/workspace-capability-tools.ts'
import { createConversationReadTool } from '../../../apps/agents/src/tools/built-in/conversation-read.ts'
import { createContextCheckpointTool } from '../../../apps/agents/src/tools/built-in/context-checkpoint.ts'
import { createToolExecutor } from '../../../apps/agents/src/agents/spawn.ts'
import { evaluate } from '../../../apps/agents/src/agents/evaluation.ts'
import { estimateRequestSize } from '../../../apps/agents/src/llm/request-size.ts'
import { createWorldWorkspaceRuntimeRegistry } from '../../../apps/world/src/core/workspaces/runtime-registry.ts'
import { createWorldModuleState } from '../../../apps/world/src/core/workspaces/module-state.ts'
import { handleWorldModuleApi } from '../../../apps/world/src/core/api/workspace-module-api.ts'
import { createTestPackRuntimeAdapters, createTestScenarioRuntimeResolver, testScenarioAuthoring } from '../../../apps/world/tests/helpers.ts'

type Json = Record<string, unknown>
const object = (value: unknown): Json => { assert(value !== null && typeof value === 'object' && !Array.isArray(value)); return value as Json }
const list = (value: unknown): unknown[] => { assert(Array.isArray(value)); return value }
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')
const jsonSha = (value: unknown) => sha(JSON.stringify(value) ?? 'undefined')
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value))
export interface CapturedCall extends ExecutionCall { readonly result: ToolResult; readonly providerCallId: string; readonly arguments: Record<string, unknown> }
interface Capture {
  readonly workspaceId: string; readonly roomId: string; readonly resource: unknown; readonly finishedAt: string
  readonly capture: {
    readonly turns: Record<string, { readonly turn: { readonly id: string; readonly agentId: string; readonly status: string } }>
    readonly calls: Record<string, CapturedCall>; readonly models: Record<string, ExecutionModelCall>
  }
}
interface BillingRow { readonly trial: string; readonly executionKey: string; readonly costUsd: string
  readonly metrics: { readonly promptTokens: number; readonly completionTokens: number; readonly cacheRead: number; readonly cacheCreation: number }
  readonly priceReconciliation: { readonly promptThreshold: number | null; readonly ratesUsdPerToken: {
    readonly prompt: string; readonly completion: string; readonly input_cache_read: string; readonly input_cache_write: string
  } }
}
interface RequestMeasure {
  readonly ordinal: number; readonly sourceModelOrdinal?: number; readonly kind: 'source-call' | 'checkpoint' | 'fixture-ending'
  readonly estimatedInputTokens: number; readonly requestBytes: number; readonly messageBytes: number
  readonly sharedPrefixEstimatedTokens: number; readonly opaqueContinuationBytes: number; readonly checkpointId?: string
  readonly exactOriginalCompletionTokens?: number; readonly extraCompletionTokenEstimate?: number
  readonly activeOriginalCallIds: ReadonlyArray<string>; readonly opaqueProtocolBytes: number
}

/** Real public World descriptors, assembled locally. Module business calls in
 * the replay are served exclusively by the immutable transport fixture below. */
const localWorldCatalog = async (): Promise<ReadonlyArray<ModuleCapabilityDescriptor>> => {
  const dataDir = await mkdtemp(join(tmpdir(), 'working-context-catalog-'))
  const registry = createWorldWorkspaceRuntimeRegistry({ dataDir, moduleState: createWorldModuleState({ dataDir }),
    scenarioRuntimeResolver: createTestScenarioRuntimeResolver(), ...testScenarioAuthoring(), runtimeAdapters: createTestPackRuntimeAdapters() })
  try {
    const workspaceId = newWorkspaceId()
    let url = new URL(`http://world.fixture.invalid/internal/workspaces/${workspaceId}`)
    const created = await handleWorldModuleApi(new Request(url.href, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workspaceId }) }), url, registry)
    assert.equal(created?.status, 201)
    await registry.getLoaded(workspaceId)!.simulationRuns.create({ scenarioId: 'test-plant' })
    url = new URL(`${url.href}/capabilities`)
    const response = await handleWorldModuleApi(new Request(url.href), url, registry)
    assert.equal(response?.status, 200)
    return moduleCapabilityCollectionSchema.parse(await response!.json()).capabilities
  } finally { await registry.shutdown(); await rm(dataDir, { recursive: true, force: true }) }
}

const rowsOf = (call: CapturedCall): Json[] => {
  if (call.tool !== 'workspace_call') return []
  return list(object(call.result.data).results).map(object)
}
const operationsOf = (call: CapturedCall): Json[] => call.tool === 'workspace_call' ? list(call.arguments.calls).map(object) : []
const walk = (value: unknown, visit: (node: Json) => void): void => {
  if (value === null || typeof value !== 'object') return
  if (Array.isArray(value)) { value.forEach(child => walk(child, visit)); return }
  const node = value as Json; visit(node); Object.values(node).forEach(child => walk(child, visit))
}
interface CallFacts {
  readonly sourceId: string; readonly time?: string; readonly stepId?: string; readonly procedureId?: string
  readonly pointFrame: boolean; readonly controllerFrame: boolean; readonly achievedDependencies: boolean
  readonly note: boolean; readonly sourceRead: boolean; readonly fullGuidance: boolean; readonly transition: boolean
}
const callFacts = (call: CapturedCall): CallFacts => {
  const operations = operationsOf(call)
  let time: string | undefined, stepId: string | undefined, procedureId: string | undefined, fullGuidance = false
  for (const row of rowsOf(call).filter(row => row.success === true)) {
    const data = object(row.data)
    const next = data.next === undefined ? undefined : object(data.next)
    const frame = next ?? data
    const evidence = data.evidence === undefined ? undefined : object(data.evidence)
    const actualTime = frame.simulationTime ?? evidence?.simulationTime ?? data.currentSimulationTime
    if (actualTime !== undefined) {
      assert.equal(typeof actualTime, 'string')
      if (!time || String(actualTime) > time) time = String(actualTime)
      walk(data, node => {
        if (typeof node.simulationTime === 'string') assert(node.simulationTime <= String(actualTime),
          `Nested future time cannot become current evidence in ${call.id}`)
      })
    }
    if (frame.run !== undefined) {
      const run = object(frame.run)
      if (typeof run.currentStepId === 'string' && typeof run.procedureId === 'string') { stepId = run.currentStepId; procedureId = run.procedureId }
    }
    if (frame.guidanceIncluded === true) fullGuidance = true
  }
  const signalInputs = operations.filter(op => op.operationId === 'world.process-plant.signals.read').map(op => object(op.input))
  const requested = signalInputs.flatMap(input => list(input.signals).map(object))
  return { sourceId: call.id, ...(time ? { time } : {}), ...(stepId ? { stepId } : {}), ...(procedureId ? { procedureId } : {}),
    pointFrame: rowsOf(call).some(row => row.operationId === 'world.simulation-run.wait' || row.operationId === 'world.procedure.run.step.read' || row.operationId === 'world.procedure.run.transition' || row.operationId === 'world.procedure.run.start'),
    controllerFrame: requested.some(ref => ref.tagId === 'AFW-A-CV-POS'),
    achievedDependencies: requested.some(ref => ref.tagId === 'TDAFW-SPEED') && requested.some(ref => ref.path === 'auxFeedwaterPumpTurbine.flowKgPerS'),
    note: operations.some(op => op.operationId === 'world.procedure.step.update'),
    sourceRead: operations.some(op => op.operationId === 'world.procedure.source.read'), fullGuidance,
    transition: operations.some(op => op.operationId === 'world.procedure.run.transition'),
  }
}

/** A benchmark schedule, not production Agent logic. Exact authored initial
 * source duty requires three equally spaced five-second acquisitions. Other
 * phases keep their current frame, monitoring origin and prior checkpoint.
 * No arbitrary message count or text-size policy participates. */
export type ReplayCheckpointSchedule = 'source-record-boundaries' | 'completed-phases-and-monitor-reviews'
export const createSemanticSchedule = (mode: ReplayCheckpointSchedule = 'source-record-boundaries') => {
  const facts: Array<CallFacts & { replayId: string; reason: string }> = []
  let currentStep: string | undefined, currentProcedure: string | undefined, currentTime: string | undefined
  let monitoringOrigin: string | undefined, priorMonitorTime: string | undefined
  const observe = (call: CapturedCall, replayId: string) => {
    const value = callFacts(call)
    if (value.stepId) currentStep = value.stepId
    if (value.procedureId) currentProcedure = value.procedureId
    if (value.time) currentTime = value.time
    facts.push({ ...value, ...(currentStep ? { stepId: currentStep } : {}), ...(currentProcedure ? { procedureId: currentProcedure } : {}),
      ...(currentTime ? { time: currentTime } : {}), replayId, reason: '' })
    if (currentStep === 'monitor-secondary-cooling' && !monitoringOrigin) monitoringOrigin = currentTime
    const signalReview = value.controllerFrame && currentStep === 'regulate-auxiliary-feed'
    return mode === 'source-record-boundaries'
      ? value.note || value.transition || signalReview
      : value.transition || (value.note && currentStep === 'monitor-secondary-cooling')
  }
  const prepare = (): { input: ContextCheckpointInput; semantic: Json } => {
    assert(facts.length > 0)
    const retain = new Map<string, string>()
    const keep = (fact: typeof facts[number] | undefined, reason: string) => { if (fact) retain.set(fact.replayId, reason) }
    const phase = facts.filter(f => f.procedureId === currentProcedure && f.stepId === currentStep)
    // Source is a pinned authority, not a synthetic summary. All actual read
    // sections for this procedure remain exact; old sections remain recallable.
    facts.filter(f => f.sourceRead).forEach(f => keep(f, 'Exact source/Basis section and revision already acquired; not a fresh physical observation.'))
    keep(phase.findLast(f => f.fullGuidance), 'Exact current step definition and native criteria; current phase authority.')
    keep(phase.findLast(f => f.note), 'Complete latest canonical source record, Human text and acquired invocation authority.')
    keep(phase.findLast(f => f.pointFrame), 'Latest actual current physical guard/CSFs and exact Run/source/driver scope.')
    keep(phase.findLast(f => f.controllerFrame), 'Latest achieved controller/valve facts for this phase, with original acquisition time.')
    keep(facts.findLast(f => f.achievedDependencies), 'Achieved AFW dependency lineup at its explicit historical acquisition time; receipts do not prove attainment.')
    const requiredTimes: string[] = []
    if (currentStep === 'establish-auxiliary-feed' && currentTime) {
      // These are source-defined exact time offsets, not a generic last-N cap.
      for (const offset of [10_000, 5_000, 0]) {
        const time = new Date(Date.parse(currentTime) - offset).toISOString()
        const frame = phase.filter(f => f.time === time)
        if (frame.some(f => f.pointFrame)) {
          requiredTimes.push(time)
          frame.forEach(f => keep(f, `Source-required initial acquisition frame ${time}; retain all current/WR/controller/record facts actually returned for that frame.`))
        }
      }
    } else if (currentStep === 'regulate-auxiliary-feed') {
      const times = [...new Set(phase.filter(f => f.pointFrame && f.time).map(f => f.time!))].sort()
      const previous = times.filter(t => t !== currentTime).at(-1)
      if (previous) phase.filter(f => f.time === previous && (f.controllerFrame || f.pointFrame)).forEach(f => keep(f, 'Actual previous receiver frame needed to compare measured progress, not a demand assumption.'))
    } else if (currentStep === 'monitor-secondary-cooling') {
      facts.filter(f => f.stepId === currentStep && f.time === monitoringOrigin).forEach(f => keep(f, 'Exact monitoring episode origin and requested horizon; no claim that historical qualification has completed.'))
      if (priorMonitorTime) phase.filter(f => f.time === priorMonitorTime && (f.note || f.controllerFrame || f.pointFrame)).forEach(f => keep(f, 'Previous monitoring checkpoint with exact scope, time and observed facts.'))
      if (currentTime) priorMonitorTime = currentTime
    }
    assert(retain.size > 0)
    return { input: { reason: `Offline captured ${currentProcedure ?? 'discovery'}/${currentStep ?? 'discovery'} acquisition/record boundary at ${currentTime ?? 'initial time'}`,
      retain: [...retain].map(([toolCallId, reason]) => ({ toolCallId, reason })) },
      semantic: { procedureId: currentProcedure, stepId: currentStep, simulationTime: currentTime, requiredInitialFrameTimes: requiredTimes,
        currentNoteCallId: phase.findLast(f => f.note)?.replayId, currentPointCallId: phase.findLast(f => f.pointFrame)?.replayId,
        currentControllerCallId: phase.findLast(f => f.controllerFrame)?.replayId, achievedDependencyCallId: facts.findLast(f => f.achievedDependencies)?.replayId,
        originalHumanMessagesMustRemainVerbatim: true, capturedSourceRecordsRetainedWithoutInventingMissingFacts: true, missingOriginalCaptureHealthNotRepaired: true } }
  }
  return { observe, prepare }
}

const createOfflineBroker = (capture: Capture, capabilities: ReadonlyArray<ModuleCapabilityDescriptor>) => {
  const ref = workspaceResourceReferenceSchema.parse(capture.resource)
  const scope: WorkspaceRoomScope = { kind: 'resource', resource: ref }
  const modules = [{ moduleId: 'world', status: 'ready' }]
  const resources = workspaceResourceCatalogSchema.parse({ workspaceId: capture.workspaceId, modules, resources: [{ ref, title: 'Immutable replay Run',
    capabilityIds: capabilities.filter(op => op.scope.kind === 'resource' && op.scope.resourceType === ref.type).map(op => op.id),
    links: [], summary: [], observedAt: capture.finishedAt }] })
  const definitions = workspaceDefinitionCatalogSchema.parse({ workspaceId: capture.workspaceId, modules, definitions: [] })
  const operations = workspaceCapabilityCatalogSchema.parse({ workspaceId: capture.workspaceId, modules, capabilities })
  const catalogs = new Map<string, unknown>([['resources', resources], ['definitions', definitions], ['capabilities', operations]])
  let current: CapturedCall | undefined
  const consumed = new Set<string>()
  let transportCalls = 0
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    assert.equal(url.origin, 'http://working-context-replay.invalid', 'No external network is permitted')
    transportCalls++
    const prefix = `/api/workspaces/${capture.workspaceId}/`
    assert(url.pathname.startsWith(prefix), url.pathname)
    const tail = url.pathname.slice(prefix.length)
    if (init?.method !== 'POST') {
      const body = catalogs.get(tail)
      assert(body, `Unexpected offline catalog ${tail}`)
      const etag = `"${jsonSha(body)}"`
      if (new Headers(init?.headers).get('if-none-match') === etag) return new Response(null, { status: 304 })
      return Response.json(body, { headers: { etag } })
    }
    assert(current, 'No source call currently being replayed')
    const match = /^capabilities\/([^/]+)\/invoke$/.exec(tail)
    assert(match, `Unexpected fixture invocation ${tail}`)
    const operationId = decodeURIComponent(match[1]!)
    const invocation = object(JSON.parse(String(init.body)))
    const candidates = operationsOf(current).filter(op => op.operationId === operationId && JSON.stringify(op.input) === JSON.stringify(invocation.input))
    const op = candidates.find(candidate => !consumed.has(String(candidate.key)))
    assert(op, `Invocation does not match immutable input for ${current.id}/${operationId}`)
    consumed.add(String(op.key))
    const row = rowsOf(current).find(candidate => candidate.key === op.key)
    assert(row); assert.deepEqual(invocation.resource, ref)
    if (row.success === true) return Response.json({ result: row.data })
    const details = object(row.details), hostDetails = object(details.details)
    const separator = String(row.error).indexOf(': ')
    assert(separator > 0)
    return Response.json({ error: { code: String(row.error).slice(0, separator), message: String(row.error).slice(separator + 2),
      retryable: hostDetails.retryable, details: hostDetails.hostDetails } }, { status: Number(hostDetails.status) })
  }) as typeof fetch
  const tools = createWorkspaceCapabilityTools({ workspaceId: ref.workspaceId, hostBaseUrl: 'http://working-context-replay.invalid', getRoomScope: roomId => roomId === capture.roomId ? scope : undefined, fetchImpl })
  const wrapped = tools.map(tool => ({ ...tool, execute: async (args, context) => {
    assert(current && current.tool === tool.name)
    assert.deepEqual(args, current.arguments)
    const result = await tool.execute(args, context)
    if (tool.name === 'workspace_explore') {
      // Scope/catalog assembly is really executed, but the old public discovery
      // body remains the immutable fixture. Do not call it a byte-identical new
      // tool envelope: the executor adds trusted effects outside this body.
      assert.equal(result.success, true)
      return structuredClone(current.result)
    }
    const { effects, ...actualBody } = result
    assert.deepEqual(actualBody, current.result, `Broker changed captured payload ${current.id}`)
    assert.equal(effects?.length, operationsOf(current).length)
    return result
  } } satisfies Tool))
  return { tools: wrapped, select: (call: CapturedCall) => { current = call; consumed.clear() }, transportCount: () => transportCalls }
}

/** Same units as production request sizing. JSON escaping and opaque bytes
 * cannot become cacheable plaintext tokens. Only complete identical leading
 * messages count; changed static instructions/schema invalidate this model. */
export const sharedRequestInputTokens = (previous: ChatRequest | undefined, current: ChatRequest): number => {
  if (!previous || JSON.stringify(previous.tools) !== JSON.stringify(current.tools)
    || JSON.stringify(previous.systemBlocks) !== JSON.stringify(current.systemBlocks)) return 0
  const messages: ChatRequest['messages'][number][] = []
  for (let i = 0; i < Math.min(previous.messages.length, current.messages.length); i++) {
    if (JSON.stringify(previous.messages[i]) !== JSON.stringify(current.messages[i])) break
    messages.push(current.messages[i]!)
  }
  const shared = estimateRequestSize({ model: current.model, tools: current.tools, systemBlocks: current.systemBlocks, messages }).estimatedInputTokens
  assert(shared <= Math.min(estimateRequestSize(previous).estimatedInputTokens, estimateRequestSize(current).estimatedInputTokens),
    'Shared plaintext prefix cannot exceed either complete plaintext request')
  return shared
}
const quantile = (sorted: ReadonlyArray<number>, fraction: number) => sorted[Math.floor((sorted.length - 1) * fraction)]!
/** Independent test-only inverse. Production presents grouped descriptors;
 * this checks every actual ordered receipt/selector against its full archive. */
export const assertCheckpointReceiptLossless = (manifest: ContextCheckpointManifest, value: unknown): void => {
  const { kind, returnedChangeGroups, ...modelFields } = object(value)
  const { actionLedger, ...canonicalFields } = manifest
  assert.equal(kind, 'context-checkpoint')
  assert.deepEqual(modelFields, canonicalFields)
  const expanded: ContextCheckpointManifest['actionLedger'] = new Array(actionLedger.length)
  for (const raw of list(returnedChangeGroups)) {
    const group = object(raw)
    assert.equal(typeof group.tool, 'string')
    const effects = list(group.effects) as ContextCheckpointManifest['actionLedger'][number]['effects']
    for (const rawCall of list(group.calls)) {
      const call = object(rawCall), index = Number(call.index)
      assert(Number.isInteger(index) && index >= 0 && index < actionLedger.length)
      assert.equal(expanded[index], undefined, 'Duplicate ledger order index')
      assert.equal(typeof call.toolCallId, 'string')
      const toolCallId = String(call.toolCallId)
      expanded[index] = { toolCallId, tool: String(group.tool), effects,
        arguments: { turnId: manifest.turnId, toolCallId, part: 'arguments' }, read: { turnId: manifest.turnId, toolCallId, part: 'result' } }
    }
  }
  assert.equal(Object.keys(expanded).length, actionLedger.length, 'Missing exact action receipt')
  assert.deepEqual(expanded, actionLedger)
}
/** Separate from receipt inversion: compare canonical ledger order with the
 * actual calls observed by this replay executor, not archival insertion order,
 * lexically sorted IDs or potentially equal wall-clock timestamps. */
export const assertLedgerInvocationChronology = (manifest: ContextCheckpointManifest, orderedExecutionCallIds: ReadonlyArray<string>): void => {
  const ordinals = new Map(orderedExecutionCallIds.map((id, index) => [id, index]))
  assert.equal(ordinals.size, orderedExecutionCallIds.length, 'Duplicate observed invocation identity')
  let previous = -1
  for (const entry of manifest.actionLedger) {
    const ordinal = ordinals.get(entry.toolCallId)
    assert(ordinal !== undefined, `Ledger contains an unobserved invocation ${entry.toolCallId}`)
    assert(ordinal > previous, 'Ledger order differs from actual invocation chronology')
    previous = ordinal
  }
}
export const priceReplay = (requests: ReadonlyArray<RequestMeasure>, sourceModels: ReadonlyArray<ExecutionModelCall>, billed: ReadonlyArray<BillingRow>, options: { opaqueStress?: boolean } = {}) => {
  const byId = new Map(billed.map(row => [row.executionKey.split('/').at(-1)!, row]))
  const ratios = sourceModels.map(model => byId.get(model.id)!.metrics.promptTokens / estimateRequestSize(model.request).estimatedInputTokens).sort((a, b) => a - b)
  const lowRates = billed.find(row => row.priceReconciliation.promptThreshold === null)!.priceReconciliation.ratesUsdPerToken
  const high = billed.find(row => row.priceReconciliation.promptThreshold !== null)!
  const highRates = high.priceReconciliation.ratesUsdPerToken, threshold = high.priceReconciliation.promptThreshold!
  const maxObservedCompletion = Math.max(...billed.map(row => row.metrics.completionTokens))
  const scenarios = []
  for (const multiplier of [quantile(ratios, 0.5), ratios.at(-1)!]) {
    for (const cache of ['cold-every-request', 'shared-prefix-with-cold-rebase', 'adjacent-prefix-without-forced-cold-rebase'] as const) {
      let cost = 0, promptTokens = 0, longContextRequests = 0, cacheReadTokens = 0, cacheWriteTokens = 0
      let sourceCallCost = 0, checkpointCost = 0, fixtureEndingCost = 0
      for (let i = 0; i < requests.length; i++) {
        const request = requests[i]!
        const plaintextTokens = Math.ceil(request.estimatedInputTokens * multiplier)
        // BASE calibration already includes original transport/tokenizer/opaque
        // overhead. Only the separately named stress case adds opaque writes.
        const tokens = plaintextTokens + (options.opaqueStress === true ? Math.ceil(request.opaqueProtocolBytes / 4) : 0)
        const long = tokens >= threshold
        const rates = long ? highRates : lowRates
        const afterRebase = i > 0 && request.checkpointId !== requests[i - 1]!.checkpointId
        const read = cache === 'cold-every-request' || (cache === 'shared-prefix-with-cold-rebase' && afterRebase) ? 0 : Math.min(plaintextTokens, Math.floor(request.sharedPrefixEstimatedTokens * multiplier))
        const write = tokens - read
        const completion = request.exactOriginalCompletionTokens ?? Math.ceil((request.extraCompletionTokenEstimate ?? 0) * multiplier)
        const value = read * Number(rates.input_cache_read) + write * Number(rates.input_cache_write) + completion * Number(rates.completion)
        cost += value; promptTokens += tokens; cacheReadTokens += read; cacheWriteTokens += write
        if (long) longContextRequests++
        if (request.kind === 'source-call') sourceCallCost += value
        else if (request.kind === 'checkpoint') checkpointCost += value
        else fixtureEndingCost += value
      }
      scenarios.push({ calibration: multiplier === ratios.at(-1)! ? 'maximum-observed-input-ratio' : 'median-observed-input-ratio', multiplier,
        cache, estimatedUsd: cost, estimatedPromptTokens: promptTokens, estimatedCacheReadTokens: cacheReadTokens,
        estimatedCacheWriteTokens: cacheWriteTokens, estimatedLongContextRequests: longContextRequests,
        sourceCallCostUsd: sourceCallCost, extraCheckpointCostUsd: checkpointCost, fixtureEndingCostUsd: fixtureEndingCost })
    }
  }
  return { method: options.opaqueStress === true ? 'OPTIONAL STRESS: calibrated input plus all selected opaque bytes write-charged again' : 'BASE: empirical actual-input/text-size ratio, already including original opaque/tokenizer/transport overhead',
    tokenEstimation: 'Production estimateRequestSize counts complete textual request, approximately characters/4. Calibrated ratios are observed on the original 205 requests; these are not GPT tokenization or served bills.',
    calibration: { minimum: ratios[0], median: quantile(ratios, 0.5), maximum: ratios.at(-1) },
    exactCapturedRateSnapshot: { promptThreshold: threshold, lowRates, highRates },
    cacheAssumptions: 'Cold-every-request charges cache writes for every estimated input token (more expensive than ordinary uncached prompt). Shared-prefix compares exact static schemas/instructions and complete consecutive identical messages, counted and scaled in the same units as the complete text estimate. Either every post-checkpoint request is fully cold or only the changed message suffix is. No cache hit is guaranteed.',
    opaqueAssumptions: options.opaqueStress === true
      ? 'Opaque byte allowance is deliberately double-counted beyond the empirical input ratio and write-charged on every request. This is a stress case, not a calibrated cost forecast.'
      : 'The observed actual-input/text-size ratio already includes original hidden protocol and other overhead. No additional opaque byte charge is added in the base calculation. Actual selected opaque bytes remain exactly recorded separately.',
    additionalCheckpointOutputSensitivity: { maximumObservedOriginalCompletionTokens: maxObservedCompletion,
      extraCheckpointRounds: requests.filter(request => request.kind === 'checkpoint').length,
      allowanceUsdAtHighestCapturedOutputRate: requests.filter(request => request.kind === 'checkpoint').length * maxObservedCompletion * Number(highRates.completion),
      meaning: 'Possible additional allowance for unserved checkpoint reasoning/output, above the explicit serialized-arguments estimate already charged. Uses the largest original completion on every new checkpoint; it is not an actual charge or guaranteed upper bound.' }, scenarios }
}

export const replayCapturedWorkingContext = async (paths: { capture: string; billing: string; protocol: string; output: string; schedule?: ReplayCheckpointSchedule }) => {
  const repository = fileURLToPath(new URL('../../../', import.meta.url))
  const sourceFiles = { benchmarkSha256: import.meta.path, evaluatorSha256: join(repository, 'apps/agents/src/agents/evaluation.ts'),
    archiveHelperSha256: join(repository, 'apps/agents/src/core/working-context.ts'), executorSha256: join(repository, 'apps/agents/src/agents/spawn.ts'),
    brokerSha256: join(repository, 'apps/agents/src/tools/built-in/workspace-capability-tools.ts') }
  const implementationHashes: Record<string, string> = {}
  for (const [name, path] of Object.entries(sourceFiles)) implementationHashes[name] = sha(new Uint8Array(await Bun.file(path).arrayBuffer()))
  const revision = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: repository })
  assert.equal(revision.exitCode, 0)
  await mkdir(paths.output, { recursive: true })
  const captureBytes = new Uint8Array(await Bun.file(paths.capture).arrayBuffer())
  const captureHash = sha(captureBytes)
  assert.equal(captureHash, '817a944704951885e13414e9b20501887d88c9a362af35473c92a9be06daf843',
    'This source-duty benchmark is pinned to the audited immutable continuation fixture, not arbitrary procedure text')
  const capture = JSON.parse(Buffer.from(captureBytes).toString('utf8')) as Capture
  const billingBytes = new Uint8Array(await Bun.file(paths.billing).arrayBuffer())
  const allBilling = JSON.parse(Buffer.from(billingBytes).toString('utf8')) as BillingRow[]
  const turns = Object.values(capture.capture.turns)
  assert.equal(turns.length, 1, 'One immutable execution turn per replay')
  const sourceTurn = turns[0]!.turn
  const sourceModels = Object.values(capture.capture.models).filter(model => model.status === 'completed').sort((a, b) => a.ordinal - b.ordinal)
  const sourceCalls = Object.values(capture.capture.calls).sort((a, b) => a.startedAt - b.startedAt)
  assert.equal(sourceModels.length, sourceCalls.length, 'This replay needs exactly one completed native call per original model round')
  assert(sourceModels.every(model => model.response?.toolCalls?.length === 1))
  const billed = allBilling.filter(row => row.executionKey.startsWith(`${sourceTurn.id}/`))
  assert.equal(billed.length, sourceModels.length)
  const byBilled = new Map(billed.map(row => [row.executionKey.split('/').at(-1)!, row]))
  const byCall = new Map(sourceCalls.map(call => [call.id, call]))
  const byProvider = new Map(sourceCalls.map(call => [call.providerCallId, call]))
  const protocolBytes = new Uint8Array(await Bun.file(paths.protocol).arrayBuffer())
  const sensitiveFinal = JSON.parse(Buffer.from(protocolBytes).toString('utf8')) as ExecutionModelCall
  assert.equal(sensitiveFinal.protocolWithheld, false)
  const publicFinal = Object.values(capture.capture.models).find(model => model.id === sensitiveFinal.id)!
  assert(publicFinal)
  const redact = (request: ChatRequest): ChatRequest => ({ ...request, messages: request.messages.map(({ continuation: _hidden, ...message }) => message) })
  assert.deepEqual(redact(sensitiveFinal.request), publicFinal.request, 'Recovered sensitive request must match the exact immutable public request after redaction')
  const nativeGroups = sensitiveFinal.request.messages.filter(message => message.role === 'assistant' && message.toolCalls?.length)
  assert.equal(nativeGroups.length, sourceCalls.length)
  const continuationByProvider = new Map(nativeGroups.map(message => {
    assert.equal(message.toolCalls!.length, 1)
    const id = message.toolCalls![0]!.id!
    const original = byProvider.get(id)
    assert(original); assert.deepEqual(message.toolCalls![0]!.function.arguments, original.arguments)
    return [id, message.continuation]
  }))
  assert.equal(continuationByProvider.size, sourceCalls.length)
  const capabilities = await localWorldCatalog()
  // Advertised risk used in the original discovery must agree with today's
  // real catalog; otherwise the fixture refuses to invent historical authority.
  const capturedRisks = new Map<string, unknown>()
  sourceCalls.filter(call => call.tool === 'workspace_explore').forEach(call => {
    list(object(call.result.data).operations).map(object).forEach(op => capturedRisks.set(String(op.operationId), op.risk))
  })
  for (const call of sourceCalls) for (const op of operationsOf(call)) {
    const actual = capabilities.find(descriptor => descriptor.id === op.operationId)
    assert(actual); assert.equal(actual.risk, capturedRisks.get(String(op.operationId)), `Risk metadata changed for ${op.operationId}`)
  }
  const broker = createOfflineBroker(capture, capabilities)
  const turnId = `offline_${sourceTurn.id}`, roomId = capture.roomId, agentId = sourceTurn.agentId
  const databasePath = join(paths.output, 'execution.sqlite')
  assert(!await Bun.file(databasePath).exists(), 'Choose a new output directory; immutable replay archives are never overwritten')
  const store = createExecutionStore(databasePath)
  const room = createRoom({ id: roomId, name: 'Offline immutable capture replay', createdBy: 'offline-fixture', createdAt: 1,
    scope: { kind: 'resource', resource: workspaceResourceReferenceSchema.parse(capture.resource) }, scopeRevision: 0 })
  room.addMember(agentId)
  const rooms = { getRoom: (id: string) => id === roomId ? room : undefined } as RoomDirectory
  store.beginTurn({ id: turnId, roomId, agentId, startedAt: Date.now() })
  store.beginModelCapture(turnId, roomId)
  const registry = createToolRegistry()
  registry.registerAll(broker.tools)
  registry.register(createContextCheckpointTool())
  const recall = createConversationReadTool(rooms, store)
  registry.register(recall)
  const firstRequest = sourceModels[0]!.request
  const checkpoint = registry.get('context_checkpoint')!
  const definitions = [...firstRequest.tools!, { type: 'function' as const,
    function: { name: checkpoint.name, description: checkpoint.description, parameters: checkpoint.parameters } }]
  assert.equal(new Set(definitions.map(definition => definition.function.name)).size, definitions.length)
  const realExecutor = createToolExecutor(registry, definitions.map(definition => definition.function.name), { callerId: agentId, callerName: 'Offline scripted capture replay' },
    undefined, undefined, store, async (_bytes, work) => work())
  const workingContext = createWorkingContextArchive(store, { roomId, turnId, agentId,
    commit: async manifest => store.recordStage(turnId, { kind: 'context_checkpoint', manifest }) })
  const scheduleMode = paths.schedule ?? 'source-record-boundaries'
  const schedule = createSemanticSchedule(scheduleMode)
  const mapping: Array<{ sourceCallId: string; providerCallId: string; replayCallId: string; argumentSha256: string; dataSha256: string }> = []
  const measured: RequestMeasure[] = [], checkpoints: Array<{ input: ContextCheckpointInput; semantic: Json; manifest?: ContextCheckpointManifest }> = []
  const replayToSource = new Map<string, string>()
  const unresolvedSourceCalls = new Set<string>()
  let sourceIndex = 0, currentOriginal: CapturedCall | undefined
  let pending: ReturnType<typeof schedule.prepare> | undefined
  let currentKind: RequestMeasure['kind'] = 'source-call', originalModel: ExecutionModelCall | undefined
  let previousRequest: ChatRequest | undefined, checkpointId: string | undefined, endingReturned = false
  const knownProtocolBytes = new Map(sourceModels.map(model => {
    const callId = model.requestedTools?.[0]?.executionCallId
    assert(callId)
    const continuation = continuationByProvider.get(byCall.get(callId)!.providerCallId)
    return [callId, continuation === undefined ? 0 : bytes(continuation)]
  }))
  let previousOriginalRequest: ChatRequest | undefined
  const originalRequestMeasures: RequestMeasure[] = sourceModels.map(model => {
    const restored: ChatRequest = { ...model.request, messages: model.request.messages.map(message => {
      if (message.role !== 'assistant' || !message.toolCalls?.length) return message
      const protocol = continuationByProvider.get(message.toolCalls[0]!.id!)
      return protocol ? { ...message, continuation: protocol } : message
    }) }
    const size = estimateRequestSize(restored)
    assert.equal(bytes(restored), model.requestBytes, 'Recovered original request must match its complete recorded byte boundary')
    const activeOriginalCallIds = restored.messages.filter(message => message.role === 'tool').flatMap(message => {
      const source = byProvider.get(message.toolCallId ?? '')
      return source ? [source.id] : []
    })
    const measured: RequestMeasure = { ordinal: model.ordinal, sourceModelOrdinal: model.ordinal, kind: 'source-call',
      estimatedInputTokens: size.estimatedInputTokens, requestBytes: bytes(restored), messageBytes: bytes(restored.messages),
      sharedPrefixEstimatedTokens: sharedRequestInputTokens(previousOriginalRequest, restored), opaqueContinuationBytes: size.continuationBytes,
      activeOriginalCallIds, opaqueProtocolBytes: activeOriginalCallIds.reduce((n, id) => n + knownProtocolBytes.get(id)!, 0),
      exactOriginalCompletionTokens: byBilled.get(model.id)!.metrics.completionTokens }
    previousOriginalRequest = restored
    return measured
  })
  const assertions = { originalArgumentAndDataParity: 0, exactRecall: 0, humanRoleEquality: 0, selectedGroupsVisible: 0,
    failedOrUnknownPinned: 0, durableCheckpointLinks: 0, modelBillingUnknown: 0, immutableSourceHash: 0, losslessModelReceiptChecks: 0, invocationChronologyChecks: 0 }
  const originalHuman = firstRequest.messages.filter(message => message.role === 'user' || message.role === 'system')
  const provider: LLMProvider = {
    models: async () => ['offline-scripted-capture'],
    chat: async request => {
      let toolCalls: ReadonlyArray<NativeToolCall> | undefined, content = ''
      let extraCompletionTokenEstimate: number | undefined
      originalModel = undefined
      if (pending) {
        currentKind = 'checkpoint'; currentOriginal = undefined
        checkpoints.push(pending)
        toolCalls = [{ id: `offlineCheckpoint${checkpoints.length}`, function: { name: 'context_checkpoint', arguments: pending.input } }]
        extraCompletionTokenEstimate = Math.ceil(JSON.stringify(toolCalls).length / 4)
        pending = undefined
      } else if (sourceIndex < sourceModels.length) {
        currentKind = 'source-call'; originalModel = sourceModels[sourceIndex++]!
        toolCalls = originalModel.response!.toolCalls!
        content = originalModel.response!.content
        currentOriginal = byProvider.get(toolCalls[0]!.id!)
        assert(currentOriginal)
        broker.select(currentOriginal)
      } else {
        assert(!endingReturned, 'Unexpected Agent correction or additional scripted model call')
        currentKind = 'fixture-ending'; currentOriginal = undefined; endingReturned = true
        content = 'Offline replay reached the original captured stopping boundary. The original provider ran out of credits; the delegated ten-minute monitoring task remains incomplete. No new physical execution or Agent judgment occurred.'
        extraCompletionTokenEstimate = Math.ceil(content.length / 4)
      }
      const requestSize = estimateRequestSize(request)
      for (const message of request.messages.filter(message => message.role === 'tool' && message.name === 'context_checkpoint')) {
        const projected = object(object(JSON.parse(message.content)).result)
        const canonical = checkpoints.find(checkpoint => checkpoint.manifest?.checkpointId === projected.checkpointId)?.manifest
        assert(canonical, 'Every projected receipt must identify an admitted canonical manifest')
        assertCheckpointReceiptLossless(canonical, projected)
        assertions.losslessModelReceiptChecks++
      }
      for (const message of request.messages.filter(message => message.role === 'assistant' && message.toolCalls?.length)) {
        const source = byProvider.get(message.toolCalls![0]!.id ?? '')
        if (source) assert.equal(jsonSha(message.continuation), jsonSha(continuationByProvider.get(source.providerCallId)), 'Retained opaque per-call protocol changed')
      }
      const human = request.messages.filter(message => message.role === 'user' || message.role === 'system')
      assert.deepEqual(human, originalHuman); assertions.humanRoleEquality++
      const activeOriginalCallIds = request.messages.filter(message => message.role === 'tool').flatMap(message => {
        const original = byProvider.get(message.toolCallId ?? '')
        return original ? [original.id] : []
      })
      for (const id of unresolvedSourceCalls) assert(activeOriginalCallIds.includes(id), `Runtime-unknown outcome was silently removed: ${id}`)
      if (checkpoints.at(-1)?.manifest) {
        const last = checkpoints.at(-1)!
        for (const retained of last.input.retain) {
          const source = replayToSource.get(retained.toolCallId)
          assert(source && activeOriginalCallIds.includes(source), `Selected required group vanished: ${retained.toolCallId}`)
          assertions.selectedGroupsVisible++
        }
      }
      measured.push({ ordinal: measured.length + 1, ...(originalModel ? { sourceModelOrdinal: originalModel.ordinal,
        exactOriginalCompletionTokens: byBilled.get(originalModel.id)!.metrics.completionTokens } : {}),
        ...(extraCompletionTokenEstimate === undefined ? {} : { extraCompletionTokenEstimate }), kind: currentKind,
        estimatedInputTokens: requestSize.estimatedInputTokens, requestBytes: bytes(request), messageBytes: bytes(request.messages),
        sharedPrefixEstimatedTokens: sharedRequestInputTokens(previousRequest, request), opaqueContinuationBytes: requestSize.continuationBytes,
        ...(checkpointId ? { checkpointId } : {}), activeOriginalCallIds,
        opaqueProtocolBytes: activeOriginalCallIds.reduce((n, id) => n + knownProtocolBytes.get(id)!, 0) })
      previousRequest = structuredClone(request)
      // No historical served usage or billing is attached to this synthetic
      // result. The estimator and old real bills live only in the report.
      const continuation = currentOriginal ? continuationByProvider.get(currentOriginal.providerCallId) : undefined
      return { content, ...(toolCalls ? { toolCalls } : {}), ...(continuation ? { continuation } : {}),
        finishReason: toolCalls ? 'tool_calls' : 'stop', generationMs: 0, tokensUsed: { prompt: 0, completion: 0 } }
    },
  }
  try {
    const result = await evaluate({ messages: firstRequest.messages, systemBlocks: firstRequest.systemBlocks?.map(block => ({ text: block.text, cacheable: block.cacheable === true })),
      flushInfo: { ids: new Set(), triggerRoomId: roomId }, warnings: [] },
    { name: 'Offline scripted capture replay', model: firstRequest.model, persona: 'Offline capture replay; never a new physical execution', reasoningEffort: firstRequest.reasoningEffort },
    provider, realExecutor, undefined, roomId, { executionTurnId: turnId, workingContext, toolDefinitions: definitions,
      modelObserver: { start: async (summary, request) => store.recordModelStart(turnId, summary, request),
        complete: async (id, response, requested) => { assert.equal(response.metrics.costUsd, undefined); assertions.modelBillingUnknown++; store.recordModelComplete(turnId, id, response, requested) },
        fail: async (id, error, cancelled, partial) => store.recordModelFailure(turnId, id, error, cancelled, partial) },
      onEvent: event => {
        if (event.kind === 'context_checkpoint') {
          const record = checkpoints.at(-1)!
          assert.deepEqual(event.manifest.reason, record.input.reason)
          assertLedgerInvocationChronology(event.manifest, mapping.map(call => call.replayCallId))
          assertions.invocationChronologyChecks++
          record.manifest = event.manifest; checkpointId = event.manifest.checkpointId; assertions.durableCheckpointLinks++
        } else if (event.kind === 'tool_result' && currentOriginal) {
          const archived = store.getCall(roomId, turnId, event.callId)
          assert(archived?.result)
          assert.deepEqual(archived.arguments, currentOriginal.arguments)
          const { effects: _effects, recall: _recall, ...body } = archived.result as ToolResult & { recall?: unknown }
          assert.deepEqual(body, currentOriginal.result)
          if (!archived.result.success || !archived.result.effects?.length || archived.result.effects.some(effect => effect.kind === 'unknown' || effect.outcome !== 'returned')) unresolvedSourceCalls.add(currentOriginal.id)
          const selected = { sourceCallId: currentOriginal.id, providerCallId: currentOriginal.providerCallId, replayCallId: event.callId,
            argumentSha256: jsonSha(archived.arguments), dataSha256: jsonSha(archived.result.data) }
          mapping.push(selected); replayToSource.set(event.callId, currentOriginal.id); assertions.originalArgumentAndDataParity++
          if (schedule.observe(currentOriginal, event.callId)) pending = schedule.prepare()
        }
        const stage = executionStageEvent(event)
        // Checkpoint admission itself already wrote this exact durable stage.
        if (stage && event.kind !== 'context_checkpoint') store.recordStage(turnId, stage)
      },
    })
    assert.equal(result.decision.response.action, 'respond', JSON.stringify(result.decision.response))
    assert.equal(sourceIndex, sourceModels.length); assert.equal(mapping.length, sourceCalls.length)
    for (const entry of mapping) {
      const actual = await recall.execute({ turnId, toolCallId: entry.replayCallId, part: 'result' }, { callerId: agentId, callerName: 'Offline', roomId })
      assert.equal(actual.success, true)
      assert.deepEqual(object(actual.data).result, store.getCall(roomId, turnId, entry.replayCallId)!.result)
      assert.equal(jsonSha(object(object(actual.data).result).data), entry.dataSha256)
      assertions.exactRecall++
    }
    const evidence = store.modelEvidence(roomId, turnId)
    assert.equal(evidence.stages.filter(stage => stage.event.kind === 'context_checkpoint').length, checkpoints.length)
    for (const checkpoint of checkpoints) {
      assert(checkpoint.manifest)
      for (const group of checkpoint.manifest.retainedGroups) for (const reason of group.reasons) if (reason.kind === 'runtime' && reason.text.startsWith('Failed')) assertions.failedOrUnknownPinned++
    }
    store.finishTurn(turnId, 'completed', 'Offline scripted replay, not a served response or physical qualification')
    assert.equal(sha(new Uint8Array(await Bun.file(paths.capture).arrayBuffer())), captureHash)
    assertions.immutableSourceHash++
    for (const [name, path] of Object.entries(sourceFiles)) assert.equal(sha(new Uint8Array(await Bun.file(path).arrayBuffer())), implementationHashes[name],
      'Implementation changed during replay; do not label the archive with a different source identity')
    const report = { qualification: 'OFFLINE COUNTERFACTUAL; fixed original calls, synthetic semantic checkpoint choices. Not a successful new Agent run and not a served bill.',
      implementation: { appCommit: revision.stdout.toString().trim(), ...implementationHashes },
      source: { capturePath: resolve(paths.capture), sha256: captureHash, billingSha256: sha(billingBytes), sourceTurnId: sourceTurn.id,
        sensitiveProtocolCaptureSha256: sha(protocolBytes), sensitiveProtocolNativeGroups: nativeGroups.length,
        nativeGroupsWithContinuation: nativeGroups.filter(message => message.continuation !== undefined).length,
        originalCompletedModelCalls: sourceModels.length, originalToolOutcomes: sourceCalls.length,
        actualCostUsd: billed.reduce((n, row) => n + Number(row.costUsd), 0), actualPromptTokens: billed.reduce((n, row) => n + row.metrics.promptTokens, 0),
        actualCacheReadTokens: billed.reduce((n, row) => n + row.metrics.cacheRead, 0), actualCacheWriteTokens: billed.reduce((n, row) => n + row.metrics.cacheCreation, 0),
        failedLastModelNotPricedAsCompleted: Object.values(capture.capture.models).filter(model => model.status !== 'completed').length,
        sourcePhysicalGoalRemainsIncomplete: true, accepted300SecondEpisodes: 0, sourceHistoryCaptureHealthAbsent: true },
      checkpointSchedule: scheduleMode,
      productionPath: 'evaluate → createToolExecutor → real createWorkspaceCapabilityTools → immutable offline transport bodies; real createWorkingContextArchive admission/projection → SQLite/model sidecar → real conversation_read',
      trustedEffects: 'Generated by actual validated Module descriptors and real broker; old raw envelopes lacked them. Exact original arguments/data/progress/errors remain unchanged. Counterfactual envelope adds recall/effects; old capture is never rewritten.',
      unresolvedRuntimeOutcomesPinnedThroughout: [...unresolvedSourceCalls],
      protocol: 'All original native groups were matched by exact provider ID and arguments to the separately recovered sensitive final request, whose redacted form equals the immutable public request. Selected whole groups preserve exact original continuation; omitted groups archive it. Sensitive payload is never copied into this aggregate report.',
      archive: { databasePath, turnId, roomId, agentId, checkpointCount: checkpoints.length, originalOutcomeMappings: mapping,
        selectedCheckpoint: checkpoints.at(-1)?.manifest, servedGenerationBillingAbsent: true }, assertions,
      callAccounting: { unchangedSourceModelCalls: sourceModels.length, extraCheckpointModelCalls: measured.filter(r => r.kind === 'checkpoint').length,
        extraFixtureEndingModelCalls: measured.filter(r => r.kind === 'fixture-ending').length, totalScriptedModelCalls: measured.length,
        toolDefinitionNames: definitions.map(definition => definition.function.name), newToolSchemaChargedEveryRequest: true,
        sourceCallEstimatedInputTokens: measured.filter(r => r.kind === 'source-call').reduce((n, row) => n + row.estimatedInputTokens, 0),
        allEstimatedInputTokens: measured.reduce((n, row) => n + row.estimatedInputTokens, 0), peakEstimatedInputTokens: Math.max(...measured.map(r => r.estimatedInputTokens)),
        offlineFixtureTransportCalls: broker.transportCount(), externalNetworkCalls: 0, providerCalls: 0 },
      pricing: { counterfactualReplay: priceReplay(measured, sourceModels, billed),
        likeForLikeOriginalRequests: priceReplay(originalRequestMeasures, sourceModels, billed),
        optionalOpaqueStress: { counterfactualReplay: priceReplay(measured, sourceModels, billed, { opaqueStress: true }),
          likeForLikeOriginalRequests: priceReplay(originalRequestMeasures, sourceModels, billed, { opaqueStress: true }) },
        contrast: 'Original and checkpointed request estimates use the same observed calibration, opaque-byte accounting and cache scenarios. These conditional estimates are distinct from the actual original provider bill; neither scenario is a realized new bill.' },
      requests: measured,
      checkpointDecisions: checkpoints.map(({ input, semantic, manifest }) => ({ input, semantic, manifest })),
      limitations: ['Retention choices were scripted from already captured phases, not generated by a new LLM. Behavior and task completion require later separate evaluation.',
        'No missing capture-health acquisition, due history proof or physical fact is supplied by checkpointing. The original 600-second goal did not complete.',
        'Working context grows with explicitly retained source facts, unresolved groups and cumulative action-ledger identities. There is no fixed-size guarantee or silent history cap.',
        'The generic runtime recognizes failed/uncertain invocation outcomes, not Pack-specific unknown criteria or physical attainment. Selecting complete current deciding evidence remains a tested semantic schedule responsibility here.',
        'Local request-size estimates and cache scenarios are not a tokenizer, future provider cache promise or actual new charge. Original real cost is independently retained.'] }
    await Bun.write(join(paths.output, 'report.json'), JSON.stringify(report, null, 2) + '\n')
    await Bun.write(join(paths.output, 'inspector-fixture.json'), JSON.stringify({ databasePath, roomId, turnId, agentId, selectedCheckpoint: checkpoints.at(-1)?.manifest?.checkpointId,
      classification: 'Offline synthetic replay; no generation charge is known', sourceCaptureSha256: captureHash }, null, 2) + '\n')
    return report
  } finally { store.close() }
}

/** Reprice exact finished production-path request snapshots. This performs no
 * evaluation, transport fixture or writes to the immutable execution archive. */
export const repriceArchivedWorkingContext = async (paths: { report: string; billing: string; protocol: string; output: string }) => {
  const reportBytes = new Uint8Array(await Bun.file(paths.report).arrayBuffer())
  const report = JSON.parse(Buffer.from(reportBytes).toString('utf8')) as Awaited<ReturnType<typeof replayCapturedWorkingContext>>
  const captureBytes = new Uint8Array(await Bun.file(report.source.capturePath).arrayBuffer())
  assert.equal(sha(captureBytes), report.source.sha256)
  const capture = JSON.parse(Buffer.from(captureBytes).toString('utf8')) as Capture
  const models = Object.values(capture.capture.models).filter(model => model.status === 'completed').sort((a, b) => a.ordinal - b.ordinal)
  const billingBytes = new Uint8Array(await Bun.file(paths.billing).arrayBuffer())
  assert.equal(sha(billingBytes), report.source.billingSha256)
  const billed = (JSON.parse(Buffer.from(billingBytes).toString('utf8')) as BillingRow[]).filter(row => row.executionKey.startsWith(`${report.source.sourceTurnId}/`))
  const protocolBytes = new Uint8Array(await Bun.file(paths.protocol).arrayBuffer())
  assert.equal(sha(protocolBytes), report.source.sensitiveProtocolCaptureSha256)
  const protocol = JSON.parse(Buffer.from(protocolBytes).toString('utf8')) as ExecutionModelCall
  const continuations = new Map(protocol.request.messages.filter(message => message.role === 'assistant' && message.toolCalls?.length)
    .map(message => [message.toolCalls![0]!.id!, message.continuation]))
  const observer = createModelEvidenceStore(`${report.archive.databasePath}.models`)
  const index = observer.summary(report.archive.roomId, report.archive.turnId)
  assert.equal(index.models.length, report.requests.length)
  const repriced: RequestMeasure[] = []
  let previous: ChatRequest | undefined
  for (const measure of report.requests) {
    const actual = observer.get(report.archive.roomId, report.archive.turnId, `model_${measure.ordinal}`, true)
    assert(actual)
    assert.equal(bytes(actual.request), measure.requestBytes)
    assert.equal(estimateRequestSize(actual.request).estimatedInputTokens, measure.estimatedInputTokens)
    assert.equal(estimateRequestSize(actual.request).continuationBytes, measure.opaqueContinuationBytes)
    repriced.push({ ...measure, sharedPrefixEstimatedTokens: sharedRequestInputTokens(previous, actual.request) })
    previous = actual.request
  }
  const original: RequestMeasure[] = []
  previous = undefined
  for (const model of models) {
    const request: ChatRequest = { ...model.request, messages: model.request.messages.map(message => {
      const continuation = message.role === 'assistant' && message.toolCalls?.length ? continuations.get(message.toolCalls[0]!.id!) : undefined
      return continuation ? { ...message, continuation } : message
    }) }
    const size = estimateRequestSize(request)
    assert.equal(bytes(request), model.requestBytes, 'Recovered original request must match its complete recorded byte boundary')
    original.push({ ordinal: model.ordinal, sourceModelOrdinal: model.ordinal, kind: 'source-call', estimatedInputTokens: size.estimatedInputTokens,
      requestBytes: bytes(request), messageBytes: bytes(request.messages), sharedPrefixEstimatedTokens: sharedRequestInputTokens(previous, request),
      opaqueContinuationBytes: size.continuationBytes, opaqueProtocolBytes: size.continuationBytes, activeOriginalCallIds: [],
      exactOriginalCompletionTokens: billed.find(row => row.executionKey.endsWith(`/${model.id}`))!.metrics.completionTokens })
    previous = request
  }
  const originalPricing = priceReplay(original, models, billed)
  const originalStressPricing = priceReplay(original, models, billed, { opaqueStress: true })
  const actualWrites = billed.reduce((sum, row) => sum + row.metrics.cacheCreation, 0)
  assert(originalStressPricing.scenarios.every(scenario => scenario.estimatedCacheWriteTokens >= actualWrites),
    'The explicitly conservative stress case must not contradict observed original cache writes')
  const result = { qualification: 'PURE REPRICING of finished real-runtime request snapshots; no new evaluation or changed archive/retention proof.',
    supersedesAllPricingInReport: { path: resolve(paths.report), sha256: sha(reportBytes) },
    runtimeQualificationUnchanged: report.assertions, runtimeImplementation: report.implementation,
    repricingCodeSha256: sha(new Uint8Array(await Bun.file(import.meta.path).arrayBuffer())),
    source: report.source, checkpointSchedule: report.checkpointSchedule,
    exactRequestByteComparison: { boundary: 'Exact provider-independent serialized ChatRequest bytes, including available opaque protocol; completed original205 requests versus all repaired rounds including checkpoint inferences and fixture ending.',
      originalCompletedRequests: models.length, originalTotalBytes: models.reduce((sum, model) => sum + model.requestBytes, 0), originalPeakBytes: Math.max(...models.map(model => model.requestBytes)),
      repairedRequests: report.requests.length, repairedTotalBytes: report.requests.reduce((sum, request) => sum + request.requestBytes, 0), repairedPeakBytes: Math.max(...report.requests.map(request => request.requestBytes)),
      reductionFraction: 1 - report.requests.reduce((sum, request) => sum + request.requestBytes, 0) / models.reduce((sum, model) => sum + model.requestBytes, 0) },
    correctedPrefixRule: 'Exact same schemas/instructions plus whole consecutive identical messages, sized/scaled in the same units as the production full-text estimate. No JSON serialization inflation. Base ratio already includes original opaque overhead; only the separately named stress case adds opaque-write allowance.',
    sourceObservedWriteSanity: { actualOriginalCacheWriteTokens: actualWrites, conservativeStressScenariosAtLeastObservedWrites: true,
      baseOriginalPredictedCacheWriteTokens: originalPricing.scenarios.map(scenario => ({ calibration: scenario.calibration, cache: scenario.cache, tokens: scenario.estimatedCacheWriteTokens,
        differenceFromObservedTokens: scenario.estimatedCacheWriteTokens - actualWrites, ratioToObservedWrites: scenario.estimatedCacheWriteTokens / actualWrites })) },
    pricing: { counterfactualReplay: priceReplay(repriced, models, billed), likeForLikeOriginalRequests: originalPricing,
      optionalOpaqueStress: { counterfactualReplay: priceReplay(repriced, models, billed, { opaqueStress: true }), likeForLikeOriginalRequests: originalStressPricing } },
    archive: { databasePath: report.archive.databasePath, roomId: report.archive.roomId, turnId: report.archive.turnId },
    requestCount: repriced.length, requests: repriced }
  assert(!await Bun.file(paths.output).exists(), 'Pure repricing must write a new artifact, never replace original evidence')
  await Bun.write(paths.output, JSON.stringify(result, null, 2) + '\n')
  return result
}

if (import.meta.main && Bun.argv[2] === '--reprice') {
  const [, report, billing, protocol, output] = Bun.argv.slice(2)
  assert(report && billing && protocol && output, 'Supply --reprice report.json billing.json private-final-model.json NEW-output.json')
  const result = await repriceArchivedWorkingContext({ report, billing, protocol, output })
  console.log(JSON.stringify({ qualification: result.qualification, sourceObservedWriteSanity: result.sourceObservedWriteSanity, pricing: result.pricing }, null, 2))
} else if (import.meta.main) {
  const [capture, billing, protocol, output, rawSchedule] = Bun.argv.slice(2)
  assert(capture && billing && protocol && output, 'Supply immutable capture.json, actual-billing.json, private final-model.json and a NEW output directory')
  assert(rawSchedule === undefined || rawSchedule === 'source-record-boundaries' || rawSchedule === 'completed-phases-and-monitor-reviews', 'Choose an explicit supported semantic schedule')
  const report = await replayCapturedWorkingContext({ capture, billing, protocol, output, ...(rawSchedule ? { schedule: rawSchedule } : {}) })
  console.log(JSON.stringify({ qualification: report.qualification, assertions: report.assertions, callAccounting: report.callAccounting, pricing: report.pricing, archive: { ...report.archive, originalOutcomeMappings: undefined, selectedCheckpoint: undefined } }, null, 2))
}
