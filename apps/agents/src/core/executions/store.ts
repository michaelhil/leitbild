import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { Database } from 'bun:sqlite'
import type { ToolResult } from '../types/tool.ts'

/** Actual tool execution facts, not model requests or a second conversation. */
export interface ExecutionTurn {
  readonly id: string
  readonly roomId: string
  readonly agentId: string
  readonly startedAt: number
  readonly status: 'running' | 'completed' | 'interrupted' | 'failed'
  readonly finishedAt?: number
  readonly reason?: string
  readonly messageId?: string
}

export interface ExecutionCallSummary {
  readonly id: string
  readonly tool: string
  readonly providerCallId?: string
  readonly startedAt: number
  readonly completedAt?: number
  readonly argumentBytes: number
  readonly resultBytes?: number
}

export interface ExecutionCall extends ExecutionCallSummary {
  readonly arguments: unknown
  /** Absent means no durable outcome, not failure or permission to retry. */
  readonly result?: ToolResult
}

interface TurnRow {
  id: string; room_id: string; agent_id: string; started_at: number
  status: ExecutionTurn['status']; finished_at: number | null; reason: string | null; message_id: string | null
}
interface CallRow {
  id: string; tool: string; provider_call_id: string | null; started_at: number
  completed_at: number | null; arguments_json: string; result_json: string | null
  argument_bytes: number; result_bytes: number | null
}
type CallSummaryRow = Omit<CallRow, 'arguments_json' | 'result_json'>
const turnFromRow = (row: TurnRow): ExecutionTurn => ({
  id: row.id, roomId: row.room_id, agentId: row.agent_id, startedAt: row.started_at, status: row.status,
  ...(row.finished_at === null ? {} : { finishedAt: row.finished_at }),
  ...(row.reason === null ? {} : { reason: row.reason }),
  ...(row.message_id === null ? {} : { messageId: row.message_id }),
})
const callSummary = (row: CallSummaryRow): ExecutionCallSummary => ({
  id: row.id, tool: row.tool, startedAt: row.started_at, argumentBytes: row.argument_bytes,
  ...(row.provider_call_id === null ? {} : { providerCallId: row.provider_call_id }),
  ...(row.completed_at === null ? {} : { completedAt: row.completed_at }),
  ...(row.result_bytes === null ? {} : { resultBytes: row.result_bytes }),
})
const encode = (value: unknown): string => {
  const encoded = JSON.stringify(value)
  if (encoded === undefined) throw new Error('Execution evidence must be JSON serializable')
  return encoded
}
const missing = (): never => {
  throw Object.assign(new Error('Execution record no longer exists; a late completion cannot recreate deleted evidence'), { code: 'execution_record_missing' })
}

/** One connection per Workspace runtime. Synchronous commits complete before
 * returning, so callers can durably record intent before executing a tool.
 * Growth admission belongs to the existing Workspace storage policy.
 */
export const createExecutionStore = (path: string) => {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  const db = new Database(path, { create: true, strict: true })
  try {
    db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = DELETE; PRAGMA synchronous = EXTRA')
    // Rollback journaling avoids checkpoint machinery and the WAL-reset issue
    // in SQLite 3.51.0 bundled with the pinned Bun 1.4.0 runtime.
    const schema = db.query<{ user_version: number }, []>('PRAGMA user_version').get()!.user_version
    if (schema !== 0 && schema !== 1) throw new Error(`Unsupported execution storage schema: ${schema}`)
    if (schema === 0) {
      const tables = db.query<{ count: number }, []>("SELECT count(*) AS count FROM sqlite_master WHERE type='table'").get()!.count
      if (tables !== 0) throw new Error('Unrecognized execution storage; existing tables are not replaced')
      // New database only: deletion must return free pages to the filesystem,
      // otherwise the physical-byte admission budget cannot recover after clearing a Room.
      db.exec('PRAGMA auto_vacuum = FULL')
      db.transaction(() => {
      db.exec(`
      CREATE TABLE turns (
        id TEXT PRIMARY KEY CHECK(length(id)>0), room_id TEXT NOT NULL CHECK(length(room_id)>0),
        agent_id TEXT NOT NULL CHECK(length(agent_id)>0), started_at INTEGER NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('running','completed','interrupted','failed')),
        finished_at INTEGER, reason TEXT, message_id TEXT
      ) STRICT;
      CREATE INDEX turns_room ON turns(room_id, started_at DESC, id);
      CREATE INDEX turns_message ON turns(room_id, message_id);
      CREATE TABLE calls (
        turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
        id TEXT NOT NULL CHECK(length(id)>0), tool TEXT NOT NULL CHECK(length(tool)>0),
        provider_call_id TEXT, started_at INTEGER NOT NULL, completed_at INTEGER,
        arguments_json TEXT NOT NULL CHECK(json_valid(arguments_json)),
        result_json TEXT CHECK(result_json IS NULL OR json_valid(result_json)),
        argument_bytes INTEGER NOT NULL, result_bytes INTEGER,
        PRIMARY KEY(turn_id,id)
      ) STRICT;
      PRAGMA user_version = 1;
    `)
      })()
    }
    // Opening is owned by an exclusive Workspace runtime. A previous process
    // cannot still be executing its turns; preserve their evidence as uncertain.
    db.query("UPDATE turns SET status='interrupted', finished_at=?, reason='Runtime stopped before the turn finished' WHERE status='running'").run(Date.now())
  } catch (error) { db.close(); throw error }

  const getTurn = (roomId: string, turnId: string): ExecutionTurn | undefined => {
    const row = db.query<TurnRow, [string, string]>('SELECT * FROM turns WHERE room_id=? AND id=?').get(roomId, turnId)
    return row ? turnFromRow(row) : undefined
  }
  const recordOutcome = db.transaction((turnId: string, callId: string, result: ToolResult, completedAt: number) => {
    const existing = db.query<{ result_json: string | null }, [string, string]>('SELECT result_json FROM calls WHERE turn_id=? AND id=?').get(turnId, callId)
    if (!existing) missing()
    if (existing!.result_json !== null) throw new Error('Execution outcome already recorded')
    const serialized = encode(result)
    db.query('UPDATE calls SET result_json=?,result_bytes=?,completed_at=? WHERE turn_id=? AND id=?')
      .run(serialized, Buffer.byteLength(serialized), completedAt, turnId, callId)
  })
  const recordAttempt = db.transaction((turnId: string, call: {
    readonly id: string; readonly tool: string; readonly arguments: unknown
    readonly providerCallId?: string; readonly startedAt: number
  }) => {
    const turn = db.query<{ status: ExecutionTurn['status'] }, [string]>('SELECT status FROM turns WHERE id=?').get(turnId)
    if (!turn) missing()
    if (turn!.status !== 'running') throw new Error('Cannot dispatch another tool for a finished execution turn')
    const serialized = encode(call.arguments)
    db.query('INSERT INTO calls(turn_id,id,tool,provider_call_id,started_at,arguments_json,argument_bytes) VALUES(?,?,?,?,?,?,?)')
      .run(turnId, call.id, call.tool, call.providerCallId ?? null, call.startedAt, serialized, Buffer.byteLength(serialized))
  })
  return {
    beginTurn: (turn: Pick<ExecutionTurn, 'id' | 'roomId' | 'agentId' | 'startedAt'>): void => {
      db.query("INSERT INTO turns(id,room_id,agent_id,started_at,status) VALUES(?,?,?,?,'running')")
        .run(turn.id, turn.roomId, turn.agentId, turn.startedAt)
    },
    recordAttempt: (turnId: string, call: Parameters<typeof recordAttempt>[1]): void => recordAttempt(turnId, call),
    recordOutcome: (turnId: string, callId: string, result: ToolResult, completedAt = Date.now()): void => recordOutcome(turnId, callId, result, completedAt),
    finishTurn: (turnId: string, status: Exclude<ExecutionTurn['status'], 'running'>, reason?: string): boolean =>
      db.query("UPDATE turns SET status=?,finished_at=?,reason=? WHERE id=? AND status='running'")
        .run(status, Date.now(), reason ?? null, turnId).changes > 0,
    linkMessage: (turnId: string, messageId: string): boolean =>
      db.query('UPDATE turns SET message_id=? WHERE id=? AND (message_id IS NULL OR message_id=?)').run(messageId, turnId, messageId).changes > 0,
    getTurn,
    listTurns: (roomId: string, options: { readonly limit?: number; readonly before?: Pick<ExecutionTurn, 'startedAt' | 'id'> } = {}): ExecutionTurn[] => {
      const limit = options.limit ?? 30 // A browse page, never a retention or tool-use cap.
      if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Execution page limit must be a positive integer')
      return db.query<TurnRow, [string, number | null, number | null, number | null, string | null, number]>(
        'SELECT * FROM turns WHERE room_id=? AND (? IS NULL OR started_at<? OR (started_at=? AND id<?)) ORDER BY started_at DESC,id DESC LIMIT ?',
      ).all(roomId, options.before?.startedAt ?? null, options.before?.startedAt ?? null,
        options.before?.startedAt ?? null, options.before?.id ?? null, limit).map(turnFromRow)
    },
    listCalls: (roomId: string, turnId: string): ExecutionCallSummary[] => db.query<CallSummaryRow, [string, string]>(
      `SELECT c.id,c.tool,c.provider_call_id,c.started_at,c.completed_at,c.argument_bytes,c.result_bytes
       FROM calls c JOIN turns t ON t.id=c.turn_id WHERE t.room_id=? AND t.id=? ORDER BY c.started_at,c.rowid`,
    ).all(roomId, turnId).map(callSummary),
    getCall: (roomId: string, turnId: string, callId: string): ExecutionCall | undefined => {
      const row = db.query<CallRow, [string, string, string]>(
        'SELECT c.* FROM calls c JOIN turns t ON t.id=c.turn_id WHERE t.room_id=? AND t.id=? AND c.id=?',
      ).get(roomId, turnId, callId)
      if (!row) return undefined
      return { ...callSummary(row), arguments: JSON.parse(row.arguments_json), ...(row.result_json === null ? {} : { result: JSON.parse(row.result_json) as ToolResult }) }
    },
    deleteMessage: (roomId: string, messageId: string): void => { db.query('DELETE FROM turns WHERE room_id=? AND message_id=?').run(roomId, messageId) },
    deleteRoom: (roomId: string): void => { db.query('DELETE FROM turns WHERE room_id=?').run(roomId) },
    close: (): void => db.close(),
  }
}

export type ExecutionStore = ReturnType<typeof createExecutionStore>
