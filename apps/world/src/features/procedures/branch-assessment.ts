import type { ProcedureAssessmentCondition } from '@leitbild/procmd'
import type { IsoTimestamp, ProcedureStep } from '../../core/model/index.ts'
import type { ProcedureBranchAssessment, ProcedureCriterionReading as CriterionReading, ProcedureCriterionStatus } from '../../core/model/procedure-criteria.ts'
import type { ProcedureTagRead } from './pack-observations.ts'

const compare = (a: number | boolean, operator: string, b: number | boolean): boolean => {
  if (operator === '==') return a === b
  if (operator === '!=') return a !== b
  if (typeof a !== 'number' || typeof b !== 'number') throw new Error('Ordered comparison needs numeric operands')
  if (operator === '<') return a < b
  if (operator === '<=') return a <= b
  if (operator === '>') return a > b
  return a >= b
}

/** Only explicit authored comparisons are evaluated. This is not a plant diagnostic or a procedure execution engine. */
export const assessProcedureBranches = (config: {
  readonly step: ProcedureStep
  readonly reads: ReadonlyArray<ProcedureTagRead>
  readonly simulationTime: IsoTimestamp
  readonly plantId: string
}): ReadonlyArray<ProcedureBranchAssessment> => config.step.branches.map((_branch, branchIndex) => {
  const decision = config.step.decisions?.find(candidate => candidate.branchIndex === branchIndex)
  const readings: CriterionReading[] = []
  const reasons = new Set<string>()
  const unknown = (reason: string): 'unknown' => { reasons.add(reason); return 'unknown' }
  const evaluate = (condition: ProcedureAssessmentCondition): ProcedureCriterionStatus => {
    if (condition.type === 'manual') {
      const reason = `Human judgment required: ${condition.description}`
      readings.push({ source: condition.source, description: condition.description, status: 'unknown', reason })
      return unknown(reason)
    }
    if (condition.type === 'comparison') {
      const read = config.reads.find(candidate => candidate.tagId === condition.tagId)
      const value = read?.value
      const acquired = value?.evidence
      const ageSeconds = acquired === undefined ? undefined : (Date.parse(config.simulationTime) - Date.parse(acquired.sampledAt)) / 1000
      const reason = read === undefined ? `No observation acquired for ${condition.tagId}.`
        : read.binding === 'unchecked' ? `Signal ${condition.tagId} binding could not be checked.`
          : read.binding === 'missing' ? `Signal ${condition.tagId} is not bound; absence does not establish a normal condition.`
          : value === undefined ? `Signal ${condition.tagId} is unavailable: ${read.unavailable ?? 'no reading'}.`
            : value.scopeId !== config.plantId ? `Signal ${condition.tagId} does not establish the requested plant scope.`
              : value.signalTagId !== condition.tagId ? `Signal ${condition.tagId} identity is not established by the returned binding.`
                : value.writable !== false ? `Signal ${condition.tagId} is a command/demand or has unestablished writability; physical feedback is required.`
                  : value.quality !== 'good' ? `Signal ${condition.tagId} quality is ${value.quality ?? 'unestablished'}.`
                    : value.conversionStatus === 'unavailable' || value.unit !== condition.unit ? `Signal ${condition.tagId} does not supply criterion unit ${condition.unit}.`
                      : acquired === undefined || acquired.kind !== condition.evidence ? `Signal ${condition.tagId} does not establish ${condition.evidence} evidence.`
                        : decision?.applicability?.model !== undefined && (acquired.modelRef !== decision.applicability.model.ref || acquired.modelDigest !== decision.applicability.model.digest) ? `Signal ${condition.tagId} model identity does not match the pinned criterion applicability.`
                          : decision?.applicability?.automation !== undefined && (acquired.automationRef !== decision.applicability.automation.ref || acquired.automationDigest !== decision.applicability.automation.digest) ? `Signal ${condition.tagId} I&C configuration does not match the pinned criterion applicability.`
                            : ageSeconds === undefined || !Number.isFinite(ageSeconds) || ageSeconds < 0 || ageSeconds > condition.maxAgeSeconds ? `Signal ${condition.tagId} sample is stale or is outside the current simulation-time frame.`
                          : typeof condition.value === 'number' && condition.bound !== 'value' ? `Signal ${condition.tagId} supplies a scalar; the requested ${condition.bound} interval bound is not established.`
                            : typeof value.value !== typeof condition.value ? `Signal ${condition.tagId} value type does not match the criterion.` : undefined
      const status = reason === undefined ? compare(value!.value as number | boolean, condition.operator, condition.value) ? 'supported' : 'contradicted' : unknown(reason)
      readings.push({ tagId: condition.tagId, source: condition.source, operator: condition.operator, expected: condition.value,
        evidence: condition.evidence, ...(condition.bound === undefined ? {} : { bound: condition.bound }),
        ...(value === undefined ? {} : { ...(typeof value.value === 'number' || typeof value.value === 'boolean' ? { value: value.value } : {}),
          ...(value.unit === undefined ? {} : { unit: value.unit }), ...(value.path === undefined ? {} : { path: value.path }),
          ...(value.writable === undefined ? {} : { writable: value.writable }) }),
        ...(acquired === undefined ? {} : { sampledAt: acquired.sampledAt, provenance: acquired.provenance,
          ...(acquired.modelRef === undefined ? {} : { modelRef: acquired.modelRef }), ...(acquired.modelDigest === undefined ? {} : { modelDigest: acquired.modelDigest }),
          ...(acquired.automationRef === undefined ? {} : { automationRef: acquired.automationRef }), ...(acquired.automationDigest === undefined ? {} : { automationDigest: acquired.automationDigest }) }),
        status, ...(reason === undefined ? {} : { reason }) })
      return status
    }
    if (condition.type === 'not') {
      const result = evaluate(condition.condition)
      return result === 'unknown' ? 'unknown' : result === 'supported' ? 'contradicted' : 'supported'
    }
    if (condition.type === 'held') {
      evaluate(condition.condition)
      return unknown(`A current sample does not establish continuous evidence for ${condition.durationSeconds} simulation seconds.`)
    }
    // Read all operands; a decisive any/all still retains every missing observation.
    const statuses = condition.conditions.map(evaluate)
    const supported = statuses.filter(status => status === 'supported').length
    const uncertain = statuses.filter(status => status === 'unknown').length
    const required = condition.type === 'vote' ? condition.required! : condition.type === 'all' ? statuses.length : 1
    return supported >= required ? 'supported' : supported + uncertain < required ? 'contradicted' : 'unknown'
  }
  const status = decision === undefined ? unknown('No authored eligibility criterion for this branch; a person may placekeep, but automatic qualification is unestablished.') : evaluate(decision.condition)
  return { branchIndex, status, simulationTime: config.simulationTime,
    ...(decision === undefined ? {} : { condition: decision.condition, ...(decision.applicability === undefined ? {} : { applicability: decision.applicability }) }),
    readings, reasons: [...reasons] }
})
