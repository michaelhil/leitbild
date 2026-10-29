import { parseProcedureAssessment, type ProcedureAssessmentCondition } from './assessment.ts'

/** Branch eligibility is authored separately from human placekeeping and step engineering guidance. */
export interface ProcedureDecision {
  readonly branchIndex: number
  readonly condition: ProcedureAssessmentCondition
  /** A visible, sourced scope statement. It never changes condition truth by itself. */
  readonly applicability?: { readonly description: string; readonly source: string; readonly model?: { readonly ref: string; readonly digest: string }; readonly automation?: { readonly ref: string; readonly digest: string } }
}

export const parseProcedureDecisions = (value: unknown): ReadonlyArray<ProcedureDecision> => {
  if (!Array.isArray(value) || value.length === 0) throw new Error('procedure-decisions requires a nonempty array')
  const seen = new Set<number>()
  return value.map((item): ProcedureDecision => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) throw new Error('procedure-decisions requires branch objects')
    const row = item as Record<string, unknown>
    for (const key of Object.keys(row)) if (!['branchIndex', 'condition', 'applicability'].includes(key)) throw new Error(`unsupported procedure-decisions field ${key}`)
    if (typeof row.branchIndex !== 'number' || !Number.isSafeInteger(row.branchIndex) || row.branchIndex < 0) throw new Error('procedure-decisions requires a nonnegative branchIndex')
    if (seen.has(row.branchIndex)) throw new Error(`procedure-decisions repeats branchIndex ${row.branchIndex}`)
    seen.add(row.branchIndex)
    let applicability: ProcedureDecision['applicability']
    if (row.applicability !== undefined) {
      if (row.applicability === null || typeof row.applicability !== 'object' || Array.isArray(row.applicability)) throw new Error('procedure-decisions applicability requires an object')
      const scope = row.applicability as Record<string, unknown>
      for (const key of Object.keys(scope)) if (!['description', 'source', 'model', 'automation'].includes(key)) throw new Error(`unsupported applicability field ${key}`)
      if (typeof scope.description !== 'string' || !scope.description.trim() || typeof scope.source !== 'string' || !scope.source.trim()) throw new Error('procedure-decisions applicability requires description and source')
      const identity = (value: unknown): { readonly ref: string; readonly digest: string } => {
        if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('applicability identity requires ref and digest')
        const data = value as Record<string, unknown>
        if (Object.keys(data).some(key => !['ref', 'digest'].includes(key)) || typeof data.ref !== 'string' || !data.ref.trim() || typeof data.digest !== 'string' || !/^[a-f0-9]{64}$/.test(data.digest)) throw new Error('applicability identity requires exact ref and SHA-256 digest')
        return { ref: data.ref, digest: data.digest }
      }
      applicability = { description: scope.description, source: scope.source,
        ...(scope.model === undefined ? {} : { model: identity(scope.model) }), ...(scope.automation === undefined ? {} : { automation: identity(scope.automation) }) }
    }
    return { branchIndex: row.branchIndex, condition: parseProcedureAssessment({ condition: row.condition }).condition,
      ...(applicability === undefined ? {} : { applicability }) }
  })
}
