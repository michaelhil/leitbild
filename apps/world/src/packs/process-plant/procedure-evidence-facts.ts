import { z } from 'zod'
import type { ProcessSignalBinding } from './graph/index.ts'
import type { ProcessPlantVariableSnapshot } from './runtime/model.ts'
import type { ProcessPlantProcedureEvidence, ProcessPlantProcedureIcEvidence } from './condition-evidence.ts'

/** Facts needed to judge an operand, rather than another copy of its graph
 * schema. Exact static metadata remains discoverable by the canonical path or
 * tag through the signal APIs. Keep binding and acquired-snapshot facts distinct:
 * disagreement in unit, writability or ranges must remain inspectable. */
export type ProcessPlantEvidenceSignal = Pick<ProcessSignalBinding, 'path' | 'tagId' | 'label' | 'unit' | 'writable' | 'published' | 'limits' | 'simulatorOnly' | 'externalRefs'>
export const processPlantEvidenceSignal = (binding: ProcessSignalBinding): ProcessPlantEvidenceSignal => ({
  path: binding.path,
  ...(binding.tagId === undefined ? {} : { tagId: binding.tagId }),
  label: binding.label, unit: binding.unit, writable: binding.writable, published: binding.published,
  ...(binding.limits === undefined ? {} : { limits: binding.limits }),
  ...(binding.simulatorOnly === undefined ? {} : { simulatorOnly: binding.simulatorOnly }),
  ...(binding.externalRefs === undefined ? {} : { externalRefs: binding.externalRefs }),
})
export type ProcessPlantEvidenceVariable = Pick<ProcessPlantVariableSnapshot, 'path' | 'value' | 'canonicalValue' | 'unit' | 'writable' | 'published' | 'limits'>
export const processPlantEvidenceVariable = (variable: ProcessPlantVariableSnapshot): ProcessPlantEvidenceVariable => ({
  path: variable.path, value: variable.value, canonicalValue: variable.canonicalValue, unit: variable.unit,
  writable: variable.writable, published: variable.published,
  ...(variable.limits === undefined ? {} : { limits: variable.limits }),
})

/** One complete acquisition in this exact condition frame. Comparison-specific
 * references and outcomes remain on every leaf. Missing bindings retain their
 * unresolved identity rather than sharing a fabricated anonymous reading. */
export type ProcessPlantProcedureReading = Omit<ProcessPlantProcedureEvidence, 'reference' | 'comparison' | 'status' | 'reason'> & {
  readonly unresolvedReference?: ProcessPlantProcedureEvidence['reference']
}
export type ProcessPlantProcedureComparison = Pick<ProcessPlantProcedureEvidence, 'reference' | 'comparison' | 'status' | 'reason'> & { readonly readingIndex: number }
export interface ProcessPlantProcedureEvidenceFrame {
  readonly readings: ReadonlyArray<ProcessPlantProcedureReading>
  readonly evidence: ReadonlyArray<ProcessPlantProcedureComparison | ProcessPlantProcedureIcEvidence>
}
const exactReadingKey = (reading: ProcessPlantProcedureReading): string => JSON.stringify(reading, (_key, value: unknown) =>
  typeof value === 'number' && (!Number.isFinite(value) || Object.is(value, -0))
    ? { numberIdentity: Object.is(value, -0) ? '-0' : String(value) } : value)

/** Deduplicate only identical acquired facts, never canonical path alone. An
 * unavailable reading, contradictory metadata or distinct native/canonical
 * value therefore cannot inherit another operand's apparently healthy facts. */
export const normalizeProcessPlantProcedureEvidence = (
  acquired: ReadonlyArray<ProcessPlantProcedureEvidence | ProcessPlantProcedureIcEvidence>,
): ProcessPlantProcedureEvidenceFrame => {
  const readings: ProcessPlantProcedureReading[] = [], indices = new Map<string, number>()
  const evidence = acquired.map(row => {
    if (!('reference' in row)) return row
    const { reference, comparison, status, reason, ...facts } = row
    const reading: ProcessPlantProcedureReading = { ...facts, ...(facts.signal === undefined ? { unresolvedReference: reference } : {}) }
    const key = exactReadingKey(reading)
    let readingIndex = indices.get(key)
    if (readingIndex === undefined) { readingIndex = readings.length; readings.push(reading); indices.set(key, readingIndex) }
    return { reference, comparison, status, ...(reason === undefined ? {} : { reason }), readingIndex }
  })
  return { readings, evidence }
}

export const readProcessPlantProcedureEvidence = (frame: Pick<ProcessPlantProcedureEvidenceFrame, 'readings'>, readingIndex: number): ProcessPlantProcedureReading => {
  if (!Array.isArray(frame.readings) || !Number.isSafeInteger(readingIndex) || readingIndex < 0 || readingIndex >= frame.readings.length) {
    throw new Error('Procedure evidence reading index does not identify an acquisition in this frame')
  }
  const reading = frame.readings[readingIndex]
  if (typeof reading !== 'object' || reading === null) throw new Error('Procedure evidence acquisition is absent from this frame')
  return reading
}

/** Explicit expansion for current readers and Inspector presentation. This
 * accepts only the table format; absent indices/tables are errors, never a
 * second parser or a fallback to a historical wire shape. */
export const expandProcessPlantProcedureEvidence = (frame: ProcessPlantProcedureEvidenceFrame): ReadonlyArray<ProcessPlantProcedureEvidence | ProcessPlantProcedureIcEvidence> => {
  if (!Array.isArray(frame.readings) || !Array.isArray(frame.evidence)) throw new Error('Procedure evidence requires this frame\'s readings and evidence arrays')
  return frame.evidence.map(row => {
    if (!('reference' in row)) return row
    const { unresolvedReference, ...reading } = readProcessPlantProcedureEvidence(frame, row.readingIndex)
    if (unresolvedReference !== undefined && JSON.stringify(unresolvedReference) !== JSON.stringify(row.reference)) throw new Error('Unresolved procedure reading does not match its leaf reference')
    if (row.reference.path !== undefined && reading.signal !== undefined && row.reference.path !== reading.signal.path) throw new Error('Procedure reading path does not match its leaf reference')
    if (row.reference.tagId !== undefined && reading.signal !== undefined && row.reference.tagId !== reading.signal.tagId) {
      // Signal resolution gives a canonical tag precedence over a graph's
      // declared external identity. No new identity or guessed match is added.
      const canonicalTagPresent = frame.readings.some(candidate => candidate.signal?.tagId === row.reference.tagId)
      if (canonicalTagPresent || !reading.signal.externalRefs?.includes(row.reference.tagId)) throw new Error('Procedure reading tag does not match its leaf reference')
    }
    return { ...reading, reference: row.reference, comparison: row.comparison, status: row.status, ...(row.reason === undefined ? {} : { reason: row.reason }) }
  })
}

/** Lossless ordered timestamp offsets. A negative step records an invalid
 * reversing history honestly; a zero step preserves duplicate timestamps.
 * Neither encoding nor decoding invents cadence, drops samples or caps detail. */
export const processPlantSampleTimeRunSchema = z.object({
  firstOffsetMs: z.number().finite(), stepMs: z.number().finite(), count: z.number().int().positive(),
}).strict()
export type ProcessPlantSampleTimeRun = z.infer<typeof processPlantSampleTimeRunSchema>
export const encodeProcessPlantSampleTimeRuns = (offsets: ReadonlyArray<number>): ReadonlyArray<ProcessPlantSampleTimeRun> => {
  if (offsets.some(offset => !Number.isFinite(offset))) throw new Error('Sample timestamp offsets must be finite')
  const runs: ProcessPlantSampleTimeRun[] = []
  for (let index = 0; index < offsets.length;) {
    const firstOffsetMs = offsets[index]!, stepMs = index + 1 < offsets.length ? offsets[index + 1]! - firstOffsetMs : 0
    let count = 1
    // Equality is exact. Irregular offsets remain separate runs, never rounded
    // onto a supposed regular sample interval.
    while (index + count < offsets.length && offsets[index + count] === firstOffsetMs + stepMs * count) count++
    runs.push({ firstOffsetMs, stepMs: count === 1 ? 0 : stepMs, count })
    index += count
  }
  return runs
}
export const decodeProcessPlantSampleTimeRuns = (runs: ReadonlyArray<ProcessPlantSampleTimeRun>): ReadonlyArray<number> => runs.flatMap(input => {
  const run = processPlantSampleTimeRunSchema.parse(input)
  return Array.from({ length: run.count }, (_, index) => run.firstOffsetMs + run.stepMs * index)
})
