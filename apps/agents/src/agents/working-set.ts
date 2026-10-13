// ============================================================================
// Working set — what an answer's turn established, carried into later turns.
//
// A turn's tool results stay inside that turn: the next turn sees the answer,
// not the evidence. Without what the turn established, a "continue" turn
// rediscovered operations, the target and the Run, and reread the
// conversation for ids (production, 2026-10-13: 4 explore and 3
// conversation_read calls of 13). The tool trace therefore records, per
// workspace operation, what a later turn reuses (traceOperations), and the
// context renders it inline with the answer (renderWorkingSet).
//
// The record is historical. A later call with a stale id or target is
// refused by the Module that owns it (World), and the Agent then reads again.
// ============================================================================

import { workspaceDefinitionRevisionReferenceSchema, workspaceResourceReferenceSchema } from '@leitbild/contracts'
import type { ToolTraceEntry, ToolTraceOperation, WorkspaceOperationTarget } from '../core/types/messaging.ts'
import type { ToolResult } from '../core/types/tool.ts'
import { PROPOSE_OPERATION_ID } from './operation-claims.ts'
import { PROPOSALS_OPERATION_ID } from './proposal-cards.ts'

// Bounds keep one answer's record small however many calls its turn made.
const MAX_INPUT_KEYS = 16
const MAX_IDS_PER_OPERATION = 12
const MAX_ID_LENGTH = 128
const MAX_RENDERED_OPERATIONS = 16
const MAX_RENDERED_TARGETS = 3
const MAX_VALUES_PER_ID = 3

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

// An identifier is a camelCase field ending in "Id" with a short one-line
// string value (plantId, runId, procedureId, stepId, tagId). Lists are left
// out: they name what a call looked at, not what the work rests on.
const IDENTIFIER_KEY = /^[a-z][A-Za-z0-9]*Id$/
const isIdentifier = (key: string, value: unknown): value is string =>
  IDENTIFIER_KEY.test(key) && key !== 'commandId' && typeof value === 'string'
  && value.length > 0 && value.length <= MAX_ID_LENGTH && !/\s/.test(value)

/** Identifiers at the top two levels of an input or a result, in the order they appear. */
const identifiersIn = (value: unknown, into: Map<string, string>): void => {
  if (!isRecord(value)) return
  for (const [key, field] of Object.entries(value)) {
    if (isIdentifier(key, field)) { if (!into.has(key)) into.set(key, field); continue }
    if (!isRecord(field)) continue
    for (const [nestedKey, nested] of Object.entries(field)) {
      if (isIdentifier(nestedKey, nested) && !into.has(nestedKey)) into.set(nestedKey, nested)
    }
  }
}

const targetOf = (value: unknown): WorkspaceOperationTarget | undefined => {
  if (!isRecord(value)) return undefined
  if (value.kind === 'resource') {
    const ref = workspaceResourceReferenceSchema.safeParse(value.ref)
    return ref.success ? { kind: 'resource', ref: ref.data } : undefined
  }
  if (value.kind === 'definition') {
    const ref = workspaceDefinitionRevisionReferenceSchema.safeParse(value.ref)
    return ref.success ? { kind: 'definition', ref: ref.data } : undefined
  }
  return undefined
}

/**
 * The operations one workspace_call issued, each with what a later turn
 * reuses where it succeeded: its input keys (a shape the operation took),
 * the exact target it went to, the identifiers its input named or its result
 * returned, and the id of a command the Module accepted.
 */
export const traceOperations = (tool: string, args: unknown, result: ToolResult): ReadonlyArray<ToolTraceOperation> | undefined => {
  if (tool !== 'workspace_call' || !result.success || !isRecord(result.data)) return undefined
  const entries = result.data.results
  if (!Array.isArray(entries)) return undefined
  const calls = isRecord(args) && Array.isArray(args.calls) ? args.calls.filter(isRecord) : []
  const operations = entries.flatMap((entry): ToolTraceOperation[] => {
    if (!isRecord(entry) || typeof entry.key !== 'string' || typeof entry.operationId !== 'string' || typeof entry.success !== 'boolean') return []
    const outcome = { key: entry.key, operationId: entry.operationId, success: entry.success }
    if (!entry.success) return [outcome]
    const input = calls.find(call => call.key === entry.key)?.input
    const ids = new Map<string, string>()
    identifiersIn(input, ids)
    identifiersIn(entry.data, ids)
    const target = targetOf(entry.target)
    const commandId = isRecord(entry.data) && entry.data.ok === true && typeof entry.data.commandId === 'string' ? entry.data.commandId : undefined
    return [{
      ...outcome,
      inputKeys: isRecord(input) ? Object.keys(input).slice(0, MAX_INPUT_KEYS) : [],
      ...(target === undefined ? {} : { target }),
      ...(ids.size === 0 ? {} : { ids: Object.fromEntries([...ids].slice(0, MAX_IDS_PER_OPERATION)) }),
      ...(commandId === undefined ? {} : { commandId }),
    }]
  })
  return operations.length === 0 ? undefined : operations
}

const shortList = <T>(values: ReadonlyArray<T>, max: number): ReadonlyArray<T> => values.slice(-max)

/**
 * The working set of one answer's turn, as its context shows it: the
 * operations that succeeded with the input keys they took, the targets they
 * went to, the identifiers they used or returned, and the proposals the turn
 * made. Empty when the turn called no workspace operation successfully.
 */
export const renderWorkingSet = (trace: ReadonlyArray<ToolTraceEntry>): string => {
  const succeeded = trace.flatMap(entry => entry.operationOutcomes ?? []).filter(operation => operation.success)
  if (succeeded.length === 0) return ''
  // Each operation once, where it was first used, with the input of its latest success.
  const inputs = new Map<string, ReadonlyArray<string>>()
  const targets = new Map<string, WorkspaceOperationTarget>()
  const ids = new Map<string, string[]>()
  const proposals: string[] = []
  for (const operation of succeeded) {
    inputs.set(operation.operationId, operation.inputKeys ?? [])
    if (operation.target !== undefined) targets.set(JSON.stringify(operation.target), operation.target)
    for (const [key, value] of Object.entries(operation.ids ?? {})) {
      const values = ids.get(key) ?? []
      ids.set(key, [...values.filter(known => known !== value), value])
    }
    if (operation.operationId === PROPOSE_OPERATION_ID && operation.commandId !== undefined) proposals.push(operation.commandId)
  }
  const lines = [
    `- operations: ${[...inputs].slice(0, MAX_RENDERED_OPERATIONS).map(([id, keys]) => `${id} {${keys.join(', ')}}`).join('; ')}`,
  ]
  if (targets.size > 0) lines.push(`- target: ${shortList([...targets.values()], MAX_RENDERED_TARGETS).map(target => JSON.stringify(target)).join('; ')}`)
  if (ids.size > 0) lines.push(`- ids: ${[...ids].map(([key, values]) => `${key} ${shortList(values, MAX_VALUES_PER_ID).join(', ')}`).join('; ')}`)
  if (proposals.length > 0) lines.push(`- proposals (their status: ${PROPOSALS_OPERATION_ID}): ${proposals.join(', ')}`)
  return `Working set, reusable without rediscovery; the owning Module refuses an id or target that is no longer valid, then read it again:\n${lines.join('\n')}`
}
