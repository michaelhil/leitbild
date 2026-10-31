import { z } from 'zod'
import { processVariableValueSchema, variablePathSchema, type CompiledPlantGraph, type VariablePath } from '../graph/index.ts'
import {
  expireProposals,
  operationOriginSchema,
  processPlantProposalSchema,
  supersedeByCommand,
  type ProcessPlantProposalBook,
  type ProposalClock,
  type ProposalTransition,
} from './proposals.ts'

// What people and AI agents did to a Plant, and what they propose: the
// commands they issued that it accepted (who, when, what it wrote, and the
// proposal an approval executed), and its proposal book. This is the Pack's
// runtime-private index for displays, proposals and the latest accepted
// intervention on each canonical control; the Run's durable events stay the record. It
// persists with the Plant's runtime state as an optional field, written only
// while it holds something (plan-final O-D4): a state without it has none.

/** Recent commands shown by the UI; this does not bound control-response evidence. */
export const OPERATIONS_KEPT = 64

export const operationRecordSchema = z.object({
  commandId: z.string().min(1),
  path: variablePathSchema,
  value: processVariableValueSchema,
  origin: operationOriginSchema,
  actorId: z.string().min(1),
  /** Plant time it was accepted at. */
  elapsedMs: z.number().finite().nonnegative(),
  /** A write, a ramp (to its target), or a person's approval that executed a proposal's write. */
  kind: z.enum(['write', 'ramp', 'approval']),
  proposalId: z.string().min(1).optional(),
  /**
   * The standing protection actuations it throttles: they drove its demand
   * to an end of its span and it sets a value between (command-guard.ts
   * throttledUnder); absent for any other command.
   */
  throttledUnder: z.array(z.object({ ruleId: z.string().min(1), label: z.string().min(1), action: z.string().min(1) }).strict()).min(1).optional(),
}).strict()

export type OperationRecord = z.infer<typeof operationRecordSchema>

/** A person's reset of a latched actuation (actuation-reset.ts), as they executed it or approved it from a proposal. */
export const resetRecordSchema = z.object({
  commandId: z.string().min(1),
  kind: z.literal('reset'),
  ruleId: z.string().min(1),
  label: z.string().min(1),
  /** The commands its effects wrote, whose QA-2 hold the reset lifted. */
  holds: z.array(variablePathSchema),
  origin: operationOriginSchema,
  actorId: z.string().min(1),
  elapsedMs: z.number().finite().nonnegative(),
  proposalId: z.string().min(1).optional(),
}).strict()

export type ResetRecord = z.infer<typeof resetRecordSchema>

export const plantOperationsStateSchema = z.object({
  log: z.array(operationRecordSchema).max(OPERATIONS_KEPT),
  /** One latest accepted receipt per canonical writable path, independent of the recent UI log. */
  latestByPath: z.array(operationRecordSchema),
  proposals: z.array(processPlantProposalSchema),
  /** The actuation resets people executed, newest last; absent while there are none. */
  resets: z.array(resetRecordSchema).max(OPERATIONS_KEPT).optional(),
}).strict().superRefine((state, context) => {
  const latest = new Map<string, OperationRecord>()
  for (const [index, record] of state.latestByPath.entries()) {
    if (latest.has(record.path)) context.addIssue({ code: 'custom', path: ['latestByPath', index], message: 'Latest accepted-operation index repeats a canonical path.' })
    latest.set(record.path, record)
  }
  const recent = new Map(state.log.map(record => [record.path, record]))
  for (const [path, record] of recent) {
    if (JSON.stringify(latest.get(path)) !== JSON.stringify(record)) context.addIssue({ code: 'custom', path: ['latestByPath'], message: `Latest accepted-operation index disagrees with the retained recent receipt for ${path}.` })
  }
})
export type PlantOperationsState = z.infer<typeof plantOperationsStateSchema>

export interface PlantOperations {
  readonly log: () => ReadonlyArray<OperationRecord>
  /** Latest accepted control receipt; unrelated operations cannot evict it. */
  readonly latest: (path: VariablePath) => OperationRecord | undefined
  readonly resets: () => ReadonlyArray<ResetRecord>
  readonly book: () => ProcessPlantProposalBook
  /** Takes the book a proposal transition left (proposals.ts). */
  readonly setBook: (book: ProcessPlantProposalBook) => void
  /**
   * Logs an accepted command of a person's or an AI agent's. A write or ramp
   * supersedes what was proposed for the same equipment; an approval already
   * closed its proposal and the others on it.
   */
  readonly record: (record: OperationRecord, at: ProposalClock) => ReadonlyArray<ProposalTransition>
  /** Logs a person's actuation reset; executed directly, it supersedes what was proposed for the same actuation. */
  readonly recordReset: (record: ResetRecord, at: ProposalClock) => ReadonlyArray<ProposalTransition>
  /** Lapses the proposals whose time is up. */
  readonly expire: (at: ProposalClock) => ReadonlyArray<ProposalTransition>
  /** What to persist; undefined while it holds nothing. */
  readonly snapshot: () => PlantOperationsState | undefined
}

export const createPlantOperations = (config: { readonly graph: CompiledPlantGraph; readonly restored?: PlantOperationsState }): PlantOperations => {
  const parsed = config.restored === undefined ? undefined : plantOperationsStateSchema.parse(config.restored)
  const validate = (record: OperationRecord): OperationRecord => {
    const accepted = operationRecordSchema.parse(record)
    const binding = config.graph.signalBindingByPath.get(accepted.path)
    if (binding?.writable !== true) throw new Error(`Accepted-operation receipt does not name a canonical writable path of the current Plant: ${accepted.path}`)
    if ((binding.quantity === 'boolean') !== (typeof accepted.value === 'boolean')) throw new Error(`Accepted-operation receipt has the wrong value type for ${accepted.path}`)
    const range = binding.limits?.hardRange
    if (typeof accepted.value === 'number' && range !== undefined && (accepted.value < range.min || accepted.value > range.max)) throw new Error(`Accepted-operation receipt is outside the current declared range for ${accepted.path}`)
    return accepted
  }
  const latestByPath = new Map((parsed?.latestByPath ?? []).map(record => [record.path, validate(record)]))
  let log: ReadonlyArray<OperationRecord> = parsed?.log ?? []
  let resets: ReadonlyArray<ResetRecord> = parsed?.resets ?? []
  let book: ProcessPlantProposalBook = { proposals: parsed?.proposals ?? [] }
  return {
    log: () => log,
    latest: path => latestByPath.get(path),
    resets: () => resets,
    book: () => book,
    setBook: next => { book = next },
    record: (record, at) => {
      const accepted = validate(record)
      const previous = latestByPath.get(accepted.path)
      if (previous !== undefined && accepted.elapsedMs < previous.elapsedMs) throw new Error(`Accepted-operation time reverses for ${accepted.path}`)
      latestByPath.set(accepted.path, accepted)
      log = [...log, accepted].slice(-OPERATIONS_KEPT)
      if (record.kind === 'approval') return []
      const step = supersedeByCommand(book, { path: record.path, commandId: record.commandId, actorId: record.actorId, at })
      book = step.book
      return step.transitions
    },
    recordReset: (record, at) => {
      resets = [...resets, resetRecordSchema.parse(record)].slice(-OPERATIONS_KEPT)
      if (record.proposalId !== undefined) return []
      const step = supersedeByCommand(book, { ruleId: record.ruleId, commandId: record.commandId, actorId: record.actorId, at })
      book = step.book
      return step.transitions
    },
    expire: at => {
      const step = expireProposals(book, at)
      book = step.book
      return step.transitions
    },
    snapshot: () => log.length === 0 && latestByPath.size === 0 && book.proposals.length === 0 && resets.length === 0 ? undefined
      : { log: [...log], latestByPath: [...latestByPath.values()].sort((left, right) => String(left.path).localeCompare(String(right.path))), proposals: [...book.proposals], ...(resets.length === 0 ? {} : { resets: [...resets] }) },
  }
}
