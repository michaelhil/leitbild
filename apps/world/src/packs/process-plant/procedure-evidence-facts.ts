import { z } from 'zod'
import type { ProcessSignalBinding } from './graph/index.ts'
import type { ProcessPlantVariableSnapshot } from './runtime/model.ts'

/** Facts needed to judge an operand, rather than another copy of its graph
 * schema. Exact static metadata remains discoverable by the canonical path or
 * tag through the signal APIs. Keep binding and acquired-snapshot facts distinct:
 * disagreement in unit, writability or ranges must remain inspectable. */
export type ProcessPlantEvidenceSignal = Pick<ProcessSignalBinding, 'path' | 'tagId' | 'label' | 'unit' | 'writable' | 'published' | 'limits' | 'simulatorOnly'>
export const processPlantEvidenceSignal = (binding: ProcessSignalBinding): ProcessPlantEvidenceSignal => ({
  path: binding.path,
  ...(binding.tagId === undefined ? {} : { tagId: binding.tagId }),
  label: binding.label, unit: binding.unit, writable: binding.writable, published: binding.published,
  ...(binding.limits === undefined ? {} : { limits: binding.limits }),
  ...(binding.simulatorOnly === undefined ? {} : { simulatorOnly: binding.simulatorOnly }),
})
export type ProcessPlantEvidenceVariable = Pick<ProcessPlantVariableSnapshot, 'path' | 'value' | 'canonicalValue' | 'unit' | 'writable' | 'published' | 'limits'>
export const processPlantEvidenceVariable = (variable: ProcessPlantVariableSnapshot): ProcessPlantEvidenceVariable => ({
  path: variable.path, value: variable.value, canonicalValue: variable.canonicalValue, unit: variable.unit,
  writable: variable.writable, published: variable.published,
  ...(variable.limits === undefined ? {} : { limits: variable.limits }),
})

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
