import { z } from 'zod'
import { objectIdSchema, isoTimestampSchema } from '../../core/model/index.ts'
import { expandProcessPlantProcedureEvidence, type ProcessPlantProcedureEvidenceFrame } from './procedure-evidence-facts.ts'
import type { ProcessPlantProcedureCondition, ProcessPlantProcedureEvidence, ProcedureConditionStatus } from './condition-evidence.ts'
import type { CompiledPlantGraph, ProcessSignalBinding } from './graph/index.ts'
import { readableProcessPlantSignalBinding } from './signals.ts'

/** World supplies the retained native acquisition of the selected starting step.
 * This is a reading frame, not a caller-selected substitute for recorded history. */
export const processPlantResponseStartSchema = z.object({
  targetObjectId: objectIdSchema,
  status: z.enum(['satisfied', 'challenged', 'unknown']),
  simulationTime: isoTimestampSchema,
  simTimeMs: z.number().finite().nonnegative(),
  evidenceKind: z.literal('engineering-diagnostic'), provenance: z.literal('runtime-model'),
  modelRef: z.string(), modelDigest: z.string(), automationRef: z.string(), automationDigest: z.string(),
  readings: z.array(z.record(z.string(), z.unknown())),
  evidence: z.array(z.record(z.string(), z.unknown())),
}).passthrough()
export type ProcessPlantResponseStart = z.infer<typeof processPlantResponseStartSchema>

/** Every requested initial operand must actually have been acquired. A graph
 * lookup or an older exception-record point cannot supply that missing value. */
export const startingResponseReading = (start: { readonly readings: ReadonlyArray<unknown>; readonly evidence: ReadonlyArray<unknown> }, binding: ProcessSignalBinding, setting = false): ProcessPlantProcedureEvidence => {
  const rows = expandProcessPlantProcedureEvidence(start as unknown as ProcessPlantProcedureEvidenceFrame)
  const row = rows.find((candidate): candidate is ProcessPlantProcedureEvidence => 'reference' in candidate && candidate.signal?.path === binding.path
    && (candidate.type === 'setting') === setting)
  if (row === undefined || row.provenance !== 'runtime-model' || row.signal?.unit !== binding.unit || row.variable?.unit !== binding.unit
    || row.signal.writable !== setting || row.variable.writable !== setting || row.variable.path !== binding.path
    || row.quality.status !== 'good' || typeof row.variable.value !== (binding.quantity === 'boolean' ? 'boolean' : 'number')
    || typeof row.variable.value === 'number' && !Number.isFinite(row.variable.value)) {
    throw new Error(`The original starting acquisition does not establish ${setting ? 'configuration' : 'physical feedback'} for ${binding.path}.`)
  }
  return row
}

/** Reuse the acquired leaf verdicts with the authored group structure. The
 * original query must have acquired every required operand, including endpoint
 * flow readings that have no historian series. */
export const startingResponseCondition = (start: ProcessPlantResponseStart, condition: ProcessPlantProcedureCondition, graph: CompiledPlantGraph): ProcedureConditionStatus => {
  const rows = expandProcessPlantProcedureEvidence(start as unknown as ProcessPlantProcedureEvidenceFrame)
  const evaluate = (node: ProcessPlantProcedureCondition): ProcedureConditionStatus => {
    if (node.type === 'ic-rule-state') return rows.find(row => 'type' in row && row.type === 'ic-rule-state'
      && row.ruleId === node.ruleId && row.field === node.field && row.expected === node.value)?.status ?? 'unknown'
    if (node.type === 'comparison' || node.type === 'setting') {
      const binding = readableProcessPlantSignalBinding(graph, node.signal)
      startingResponseReading(start, binding, node.type === 'setting')
      return rows.find(row => 'reference' in row && row.signal?.path === binding.path && (row.type === 'setting') === (node.type === 'setting')
        && row.comparison.operator === node.operator && row.comparison.value === node.value && row.comparison.unit === node.unit)?.status ?? 'unknown'
    }
    if (node.type === 'not') {
      const value = evaluate(node.condition)
      return value === 'unknown' ? value : value === 'satisfied' ? 'challenged' : 'satisfied'
    }
    const statuses = node.conditions.map(evaluate), satisfied = statuses.filter(status => status === 'satisfied').length
    const required = node.type === 'vote' ? node.required : node.type === 'all' ? statuses.length : 1
    return satisfied >= required ? 'satisfied' : satisfied + statuses.filter(status => status === 'unknown').length < required ? 'challenged' : 'unknown'
  }
  return evaluate(condition)
}
