// ============================================================================
// Discovery memo — the Workspace operations an Agent already found and used
// in a conversation, so a later turn calls them instead of exploring again.
//
// Conversation evidence, not memory: it is read on every turn from the
// Agent's own execution record in the Room (what its workspace_call calls
// did and the input schemas its workspace_explore calls returned), and it
// goes when those turns go. Nothing is stored for it. Live state stays the
// Module's: a target or schema that changed since is refused with the
// current one (workspace_call hands an invalid input its schema).
// ============================================================================

import type { ExecutionDiscoveryEvidence, ExecutionTurn } from '../core/executions/store.ts'

export interface DiscoveryEvidence {
  readonly listTurns: (roomId: string, options?: { readonly limit?: number }) => ReadonlyArray<ExecutionTurn>
  readonly readDiscoveryEvidence: (roomId: string, turnId: string) => ReadonlyArray<ExecutionDiscoveryEvidence>
}

// The turns a conversation's operations are read from: one page of the
// Room's newest turns, all Agents (the browse page the execution record
// serves), of which this Agent's own count.
const RECENT_TURNS = 30
// The operations remembered, most recently used first: a display answer uses
// five to eight (Plants, signal search and read, assessments, compose,
// controls, propose, proposals).
const MEMO_OPERATIONS = 8
// Schemas carried in the memo, re-sent with every model call of a turn: about
// one focused explore page. Beyond it an operation is named without one.
const MEMO_SCHEMA_BYTES = 8192

interface Used {
  readonly operationId: string
  readonly target?: unknown
}

/**
 * The memo for an Agent's next turn in a Room, or '' where its earlier turns
 * there used no Workspace operation.
 */
export const discoveryMemo = (evidence: DiscoveryEvidence, roomId: string, agentId: string): string => {
  const turns = evidence.listTurns(roomId, { limit: RECENT_TURNS })
    .filter(turn => turn.agentId === agentId && turn.status !== 'running')
    .reverse()
  const used = new Map<string, Used>()
  const schemas = new Map<string, unknown>()
  for (const turn of turns) {
    for (const entry of evidence.readDiscoveryEvidence(roomId, turn.id)) {
      // Refused inner calls still teach their current input schema.
      if (entry.inputSchema !== undefined) schemas.set(entry.operationId, entry.inputSchema)
      if (!entry.used) continue
      // Most recent use last, so the newest target wins.
      used.delete(entry.operationId)
      used.set(entry.operationId, { operationId: entry.operationId, ...(entry.target === undefined ? {} : { target: entry.target }) })
    }
  }
  if (used.size === 0) return ''
  let schemaBytes = 0
  const lines = [...used.values()].reverse().slice(0, MEMO_OPERATIONS).map(({ operationId, target }) => {
    const schema = schemas.get(operationId)
    const schemaText = schema === undefined ? undefined : JSON.stringify(schema)
    const fits = schemaText !== undefined && schemaBytes + schemaText.length <= MEMO_SCHEMA_BYTES
    if (fits) schemaBytes += schemaText.length
    return `- ${operationId}${target === undefined ? '' : ` · target ${JSON.stringify(target)}`}`
      + (fits ? ` · input schema ${schemaText}` : ' · input schema: read it with workspace_explore operationIds if you need it')
  })
  return [
    'Workspace operations you used earlier in this conversation, with the exact target and input schema they had then. '
      + 'Call them again with workspace_call without exploring them first; a target or schema that changed is refused with the current one.',
    ...lines,
  ].join('\n')
}
