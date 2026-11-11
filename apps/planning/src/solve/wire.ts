// The solver process boundary (pool.ts <-> child.ts): messages are JSON. Typed arrays and non-finite numbers
// are tagged on the way out and restored on the way in; a result is validated before the pool trusts it.
import { z } from 'zod'
import { datedRowSchema, instantSchema, keySchema, optionSchema } from '../plan/schema.ts'
import type { PreviewResult } from './preview.ts'
import type { SubSolveOutcome } from './generate.ts'
import type { EngineBudget, EngineResult, NormalizedProblem, Schedule } from './problem.ts'

export type ChildRequest =
  | { readonly type: 'solve'; readonly id: string; readonly problem: unknown; readonly budget: EngineBudget; readonly seed: number; readonly initial?: unknown; readonly rssLimitMb: number; readonly sampleMs: number }
  /** A whole sub-solve (generate.ts subSolve): compile, bounds, search and lane K's check, in the child. */
  | { readonly type: 'subsolve'; readonly id: string; readonly task: unknown; readonly rssLimitMb: number; readonly sampleMs: number }
  /** A preview (preview.ts previewOption): repair, lane K's check and a lock against the saved plan, in the child. */
  | { readonly type: 'preview'; readonly id: string; readonly task: unknown; readonly rssLimitMb: number; readonly sampleMs: number }
  | { readonly type: 'cancel'; readonly id: string; readonly who?: 'person' | 'host' }
  /** Lower the CPU budget so that from now on the solve uses at most `rate` cores. */
  | { readonly type: 'rebudget'; readonly id: string; readonly rate: number }
export type ChildResponse =
  /** `peakRssMb`: the child's own peak RSS, sampled while it solved. */
  | { readonly type: 'result'; readonly id: string; readonly result: unknown; readonly peakRssMb: number }
  | { readonly type: 'outcome'; readonly id: string; readonly outcome: unknown; readonly peakRssMb: number }
  | { readonly type: 'preview'; readonly id: string; readonly preview: unknown; readonly peakRssMb: number }
  /** A planning refusal raised in the child (code, HTTP status, details), passed on as it is. */
  | { readonly type: 'refusal'; readonly id: string; readonly status: number; readonly code: string; readonly message: string; readonly details?: Record<string, unknown> }
  | { readonly type: 'error'; readonly id: string; readonly message: string }

const typed = { Int8Array, Uint8Array, Int16Array, Uint16Array, Int32Array, Uint32Array, Float32Array, Float64Array } as const
type TypedName = keyof typeof typed

/** A value as JSON can carry it: typed arrays as {$typed, values}, non-finite numbers as {$number}. */
export const encode = (value: unknown): unknown => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : { $number: String(value) }
  if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
    const name = value.constructor.name as TypedName
    if (!(name in typed)) throw new TypeError(`Cannot send a ${name} to the solver process`)
    return { $typed: name, values: Array.from(value as unknown as ArrayLike<number>, encode) }
  }
  if (Array.isArray(value)) return value.map(encode)
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, encode(entry)]))
  return value
}

/** The inverse of `encode`. */
export const decode = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(decode)
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    if (typeof record.$number === 'string' && Object.keys(record).length === 1) return Number(record.$number)
    if (typeof record.$typed === 'string' && Array.isArray(record.values) && Object.keys(record).length === 2) {
      const make = typed[record.$typed as TypedName]
      if (make === undefined) throw new TypeError(`Unknown typed array ${record.$typed}`)
      return make.from(record.values.map(entry => decode(entry) as number))
    }
    return Object.fromEntries(Object.entries(record).map(([key, entry]) => [key, decode(entry)]))
  }
  return value
}

export const encodeProblem = (problem: NormalizedProblem): unknown => encode(problem)
export const decodeProblem = (wire: unknown): NormalizedProblem => decode(wire) as NormalizedProblem
export const encodeSchedule = (schedule: Schedule): unknown => encode(schedule)
export const decodeSchedule = (wire: unknown): Schedule => decode(wire) as Schedule

/** A result as the child sends it: candidates as plain integer arrays. */
const resultSchema = z.object({
  candidates: z.array(z.object({ mode: z.array(z.number().int()), start: z.array(z.number().int()) }).strict()),
  stoppedBy: z.enum(['done', 'evals', 'cpu', 'wall', 'memory', 'cancelled']),
  evals: z.number().int().nonnegative(), cpuMs: z.number().nonnegative(), wallMs: z.number().nonnegative(),
  bounds: z.array(z.object({ goal: z.number().int().nonnegative(), value: z.number().finite(), source: z.enum(['logic+calendars', 'crew-energy', 'availability-rule', 'fixed-costs']) }).strict()),
}).strict()

export const resultToWire = (result: EngineResult): unknown => ({
  ...result, candidates: result.candidates.map(candidate => ({ mode: Array.from(candidate.mode), start: Array.from(candidate.start) })),
})

/** The child's result, validated; a result that does not match is refused, never patched. */
export const resultFromWire = (wire: unknown): EngineResult | { readonly problem: string } => {
  const parsed = resultSchema.safeParse(wire)
  if (!parsed.success) return { problem: parsed.error.issues.slice(0, 3).map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ') }
  return { ...parsed.data, candidates: parsed.data.candidates.map(candidate => ({ mode: Int32Array.from(candidate.mode), start: Int32Array.from(candidate.start) })) }
}

const outcomeSchema = z.object({
  option: optionSchema,
  rounded: z.array(z.object({ about: z.string(), code: z.enum(['duration_rounded_up', 'lag_rounded_up', 'limit_rounded_down']), fromMs: z.number(), toMs: z.number() }).strict()),
  dropped: z.array(z.object({ purchase: z.string(), code: z.enum(['order_deadline_passed', 'not_in_variant', 'adds_crew_hours']) }).strict()),
}).strict()

/** The child's sub-solve outcome, validated (the option against the plan schema); refused, never patched. */
export const outcomeFromWire = (wire: unknown): SubSolveOutcome | { readonly problem: string } => {
  const parsed = outcomeSchema.safeParse(decode(wire))
  return parsed.success ? parsed.data : { problem: parsed.error.issues.slice(0, 3).map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ') }
}

const violationSchema = z.object({ code: z.string(), about: z.array(z.string()), words: z.string() }).strict()
const previewSchema = z.object({
  rows: z.array(datedRowSchema),
  violations: z.array(violationSchema),
  nearestAllowed: z.object({ job: keySchema, at: instantSchema }).strict().optional(),
  lockFindings: z.array(violationSchema).optional(),
}).strict()

/** The child's preview, validated; refused, never patched. */
export const previewFromWire = (wire: unknown): PreviewResult | { readonly problem: string } => {
  const parsed = previewSchema.safeParse(decode(wire))
  if (!parsed.success) return { problem: parsed.error.issues.slice(0, 3).map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ') }
  const { nearestAllowed, lockFindings, ...rest } = parsed.data
  return { ...rest, ...(nearestAllowed === undefined ? {} : { nearestAllowed }), ...(lockFindings === undefined ? {} : { lockFindings }) }
}
