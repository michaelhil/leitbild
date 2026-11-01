import { z } from 'zod'
import type { ChatRequest } from './types/llm.ts'
import type { ToolCall, ToolResult } from './types/tool.ts'
import type { ExecutionCall, ExecutionStore } from './executions/store.ts'

export const CONTEXT_CHECKPOINT_TOOL = 'context_checkpoint'
export const contextCheckpointInputSchema = z.object({
  reason: z.string().trim().min(1).describe('The completed semantic boundary; not a replacement summary or new instruction.'),
  retain: z.array(z.object({
    toolCallId: z.string().min(1).describe('Exact execution toolCallId from a returned recall selector in this turn.'),
    reason: z.string().trim().min(1).describe('Why this exact evidence remains necessary for continuing the task.'),
  }).strict()).min(1),
}).strict()
export type ContextCheckpointInput = z.infer<typeof contextCheckpointInputSchema>

export const executionRecallSelectorSchema = z.object({
  turnId: z.string().min(1), toolCallId: z.string().min(1), part: z.enum(['arguments', 'result']),
}).strict()
export type ExecutionRecallSelector = z.infer<typeof executionRecallSelectorSchema>
const effectSchema = z.object({
  kind: z.enum(['read', 'change', 'unknown']),
  outcome: z.enum(['returned', 'not-dispatched', 'unknown']),
  operationId: z.string().min(1).optional(), target: z.record(z.string(), z.unknown()).optional(),
}).strict()
const groupReferenceSchema = z.object({
  groupId: z.string().min(1), callIds: z.array(z.string().min(1)).min(1),
  read: z.array(executionRecallSelectorSchema).min(1),
  reasons: z.array(z.object({ kind: z.enum(['model', 'runtime']), text: z.string().min(1) }).strict()).min(1),
}).strict()
export const contextCheckpointManifestSchema = z.object({
  checkpointId: z.string().min(1), turnId: z.string().min(1), precedingModelId: z.string().min(1), reason: z.string().min(1),
  previousCheckpoint: z.object({ checkpointId: z.string().min(1), read: executionRecallSelectorSchema }).strict().optional(),
  retainedGroups: z.array(groupReferenceSchema),
  /** Only groups newly moved out of the working context at this checkpoint. */
  archivedGroups: z.array(groupReferenceSchema),
  /** Invocation facts only: returned is not physical attainment or native qualification. */
  actionLedger: z.array(z.object({ toolCallId: z.string(), tool: z.string(), effects: z.array(effectSchema), arguments: executionRecallSelectorSchema, read: executionRecallSelectorSchema }).strict()),
  counts: z.object({ retainedGroups: z.number().int().nonnegative(), archivedGroups: z.number().int().nonnegative(),
    retainedCalls: z.number().int().nonnegative(), archivedCalls: z.number().int().nonnegative() }).strict(),
}).strict()
export type ContextCheckpointManifest = z.infer<typeof contextCheckpointManifestSchema>

/** Model presentation only: factor repeated cumulative invocation descriptors.
 * All other manifest fields and the archived full outcome remain exact. */
export const contextCheckpointReceiptForModel = (manifest: ContextCheckpointManifest) => {
  const returnedChangeGroups: Array<{
    tool: string; effects: ContextCheckpointManifest['actionLedger'][number]['effects']
    calls: Array<{ index: number; toolCallId: string }>
  }> = []
  const descriptors = new Map<string, number>()
  manifest.actionLedger.forEach((entry, index) => {
    if (!equalJson(entry.arguments, { turnId: manifest.turnId, toolCallId: entry.toolCallId, part: 'arguments' })
      || !equalJson(entry.read, { turnId: manifest.turnId, toolCallId: entry.toolCallId, part: 'result' })) {
      throw new Error('context_checkpoint_receipt_invalid: ledger recall selectors do not match their exact turn/call identity')
    }
    const descriptor = { tool: entry.tool, effects: entry.effects }
    const key = JSON.stringify(descriptor)
    const existing = descriptors.get(key)
    if (existing === undefined) {
      descriptors.set(key, returnedChangeGroups.length)
      returnedChangeGroups.push({ ...descriptor, calls: [{ index, toolCallId: entry.toolCallId }] })
    } else returnedChangeGroups[existing]!.calls.push({ index, toolCallId: entry.toolCallId })
  })
  const { actionLedger: _ledger, ...exactManifest } = manifest
  return { kind: 'context-checkpoint' as const, ...exactManifest, returnedChangeGroups }
}
export type WorkingMessage = ChatRequest['messages'][number]
export interface WorkingContextGroup {
  readonly groupId: string
  readonly calls: ReadonlyArray<{ readonly call: ToolCall & { readonly callId: string }; readonly result: ToolResult }>
  /** The original complete assistant-tool group, in protocol order. */
  readonly messages: ReadonlyArray<WorkingMessage>
}
export interface WorkingContextArchive {
  readonly roomId: string
  readonly turnId: string
  readonly readCall: (toolCallId: string) => ExecutionCall | undefined
  /** Await durable stage admission before changing the working prompt. */
  readonly commit: (manifest: ContextCheckpointManifest) => Promise<void>
}
export interface PreparedWorkingContext {
  readonly manifest: ContextCheckpointManifest
  readonly retainedGroupIds: ReadonlySet<string>
  readonly archivedGroupIds: ReadonlySet<string>
}
const invalid = (message: string): never => { throw new Error(`context_checkpoint_refused: ${message}`) }
export const workingContextArchiveFailure = (message: string): Error & { readonly code: 'context_checkpoint_archive_failed' } =>
  Object.assign(new Error(`context_checkpoint_archive_failed: ${message}`), { code: 'context_checkpoint_archive_failed' as const })
export const isWorkingContextArchiveFailure = (error: unknown): boolean =>
  error !== null && typeof error === 'object' && 'code' in error && error.code === 'context_checkpoint_archive_failed'
const recall = (turnId: string, toolCallId: string): ExecutionRecallSelector => ({ turnId, toolCallId, part: 'result' })
const equalJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

/** Bind admission to the actual Room/Agent turn in the existing archive. */
export const createWorkingContextArchive = (store: ExecutionStore, config: {
  readonly roomId: string; readonly turnId: string; readonly agentId: string
  readonly commit: WorkingContextArchive['commit']
}): WorkingContextArchive => {
  const active = () => {
    try {
      const turn = store.getTurn(config.roomId, config.turnId)
      if (!turn || turn.agentId !== config.agentId || turn.status !== 'running') throw workingContextArchiveFailure('current Room/Agent execution is unavailable or no longer running')
    } catch (error) {
      if (isWorkingContextArchiveFailure(error)) throw error
      throw workingContextArchiveFailure(`archive access failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return { roomId: config.roomId, turnId: config.turnId,
    readCall: callId => {
      active()
      try { return store.getCall(config.roomId, config.turnId, callId) }
      catch (error) { throw workingContextArchiveFailure(`call access failed: ${error instanceof Error ? error.message : String(error)}`) }
    },
    commit: async manifest => { active(); await config.commit(manifest); active() },
  }
}

const validateGroup = (group: WorkingContextGroup): void => {
  const [assistant, ...results] = group.messages
  if (!assistant || assistant.role !== 'assistant' || !assistant.toolCalls || assistant.toolCalls.length !== group.calls.length
    || results.length !== group.calls.length) invalid('incomplete native protocol group')
  group.calls.forEach(({ call }, i) => {
    const wire = assistant!.toolCalls![i]!, result = results[i]!
    if (wire.id !== (call.providerCallId ?? call.callId) || wire.function.name !== call.tool || !equalJson(wire.function.arguments, call.arguments)
      || result.role !== 'tool' || result.toolCallId !== wire.id || result.name !== call.tool) invalid('protocol group does not match exact execution identities')
  })
}

/** This checks archive/protocol provenance, never Pack-specific physical criteria. */
export const prepareWorkingContextCheckpoint = (config: {
  readonly input: ContextCheckpointInput
  readonly groups: ReadonlyArray<WorkingContextGroup>
  readonly archive: WorkingContextArchive
  readonly checkpointCallId: string
  readonly precedingModelId: string
  readonly ordinal: number
  readonly previous?: { readonly manifest: ContextCheckpointManifest; readonly callId: string }
  readonly previouslyArchived?: ReadonlySet<string>
}): PreparedWorkingContext => {
  const input = contextCheckpointInputSchema.parse(config.input)
  const byCall = new Map<string, WorkingContextGroup>()
  const groupIds = new Set<string>()
  for (const group of config.groups) {
    if (groupIds.has(group.groupId)) invalid('duplicate protocol group identity')
    groupIds.add(group.groupId); validateGroup(group)
    for (const { call, result } of group.calls) {
    if (byCall.has(call.callId)) invalid('duplicate execution identity in the working archive')
    const stored = config.archive.readCall(call.callId)
    if (!stored || stored.completedAt === undefined || stored.result === undefined) throw workingContextArchiveFailure(`no completed durable outcome for ${call.callId}`)
    if (stored.tool !== call.tool || !equalJson(stored.arguments, call.arguments) || !equalJson(stored.result, result)) throw workingContextArchiveFailure(`durable evidence differs for ${call.callId}`)
    byCall.set(call.callId, group)
    }
  }
  const reasons = new Map<string, Array<{ kind: 'model' | 'runtime'; text: string }>>()
  for (const item of input.retain) {
    const group = byCall.get(item.toolCallId)
    if (!group) invalid(`unseen or foreign-turn call ${item.toolCallId}`)
    const list = reasons.get(group!.groupId) ?? []
    list.push({ kind: 'model', text: item.reason }); reasons.set(group!.groupId, list)
  }
  for (const group of config.groups) {
    const pinned = group.calls.some(({ result }) => !result.success || !result.effects?.length
      || result.effects.some(effect => effect.kind === 'unknown' || effect.outcome !== 'returned'))
    if (pinned) {
      const list = reasons.get(group.groupId) ?? []
      list.push({ kind: 'runtime', text: 'Failed, unknown or unclassified outcome remains active; no physical success is inferred.' })
      reasons.set(group.groupId, list)
    }
  }
  const retainedGroupIds = new Set(reasons.keys())
  const archivedGroupIds = new Set(config.groups.filter(g => !retainedGroupIds.has(g.groupId)).map(g => g.groupId))
  const reference = (group: WorkingContextGroup, why: Array<{ kind: 'model' | 'runtime'; text: string }>) => ({
    groupId: group.groupId, callIds: group.calls.map(c => c.call.callId), read: group.calls.map(c => recall(config.archive.turnId, c.call.callId)), reasons: why,
  })
  const retainedGroups = config.groups.filter(g => retainedGroupIds.has(g.groupId)).map(g => reference(g, reasons.get(g.groupId)!))
  // The checkpoint receipt itself is retained after its actual outcome commits.
  retainedGroups.push({ groupId: `group_${config.checkpointCallId}`, callIds: [config.checkpointCallId], read: [recall(config.archive.turnId, config.checkpointCallId)],
    reasons: [{ kind: 'runtime', text: 'Current checkpoint receipt and exact archive lineage.' }] })
  retainedGroupIds.add(`group_${config.checkpointCallId}`)
  const newlyArchived = config.groups.filter(g => archivedGroupIds.has(g.groupId) && !config.previouslyArchived?.has(g.groupId))
  const archivedGroups = newlyArchived.map(g => reference(g, [{ kind: 'model', text: 'Completed protocol group omitted from the declared working set; exact evidence remains archived.' }]))
  const ledger = new Map(config.previous?.manifest.actionLedger.map(entry => [entry.toolCallId, entry]) ?? [])
  for (const group of newlyArchived) for (const c of group.calls) if (c.result.effects?.some(e => e.kind !== 'read')) ledger.set(c.call.callId, {
    toolCallId: c.call.callId, tool: c.call.tool, effects: [...c.result.effects],
    arguments: { ...recall(config.archive.turnId, c.call.callId), part: 'arguments' }, read: recall(config.archive.turnId, c.call.callId),
  })
  for (const callId of ledger.keys()) if (!byCall.has(callId)) {
    throw workingContextArchiveFailure(`accumulated invocation ${callId} is absent from the original turn groups`)
  }
  // Archival can happen later than invocation. Order the cumulative ledger by
  // the original complete protocol groups, never by first archival or ID text.
  const actionLedger = config.groups.flatMap(group => group.calls.flatMap(({ call }) => {
    const entry = ledger.get(call.callId)
    return entry ? [entry] : []
  }))
  const manifest = contextCheckpointManifestSchema.parse({
    checkpointId: `context_${config.ordinal}`, turnId: config.archive.turnId, precedingModelId: config.precedingModelId, reason: input.reason,
    ...(config.previous ? { previousCheckpoint: { checkpointId: config.previous.manifest.checkpointId, read: recall(config.archive.turnId, config.previous.callId) } } : {}),
    retainedGroups, archivedGroups, actionLedger,
    counts: { retainedGroups: retainedGroups.length, archivedGroups: archivedGroups.length,
      retainedCalls: retainedGroups.reduce((n, g) => n + g.callIds.length, 0), archivedCalls: archivedGroups.reduce((n, g) => n + g.callIds.length, 0) },
  })
  return { manifest, retainedGroupIds, archivedGroupIds }
}

/** Keep original roles and selected protocol groups verbatim, including their
 * required per-assistant reasoning blocks. Omitted groups leave as a whole;
 * current ProviderContinuation has no server-prefix/previous-response link. */
export const projectWorkingContextMessages = (allMessages: ReadonlyArray<WorkingMessage>, groups: ReadonlyArray<WorkingContextGroup>, retained: ReadonlySet<string>): WorkingMessage[] => {
  const owners = new Map<WorkingMessage, string>()
  for (const group of groups) {
    validateGroup(group)
    const start = allMessages.indexOf(group.messages[0]!)
    if (start < 0 || group.messages.some((message, i) => allMessages[start + i] !== message)) throw workingContextArchiveFailure('protocol group references are absent or no longer contiguous in the original transcript')
    for (const message of group.messages) {
      if (owners.has(message)) invalid('message belongs to multiple protocol groups')
      owners.set(message, group.groupId)
    }
  }
  return allMessages.filter(message => message.role === 'system' || message.role === 'user' || !owners.has(message) || retained.has(owners.get(message)!))
}
