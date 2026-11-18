import type { ProcedureAssessmentCondition, ProcedureDecision, ProcedureDecisionObservation } from '@leitbild/procmd'
import type { IsoTimestamp, ProcedureStep, ProcedureRunState, SimulationRunEvent } from '../../core/model/index.ts'
import type { ProcedureBranchAssessment, ProcedureCriterionReading as CriterionReading, ProcedureCriterionStatus } from '../../core/model/procedure-criteria.ts'
import type { ProcedureDocument } from '../../core/model/index.ts'
import { readProcedureTags, type ProcedureObservationPort, type ProcedureTagRead, type ProcedureTagValue } from './pack-observations.ts'

type AcquiredObservation = { readonly result?: Readonly<Record<string, unknown>>; readonly error?: string }

/** The tags whose readings a step's left column rests on: its Check, Expected and When lines, and what its forks test. */
export const procedureCheckedTagIds = (step: ProcedureStep): ReadonlyArray<string> => [...new Set([
  ...step.blocks.filter(block => block.kind === 'check' || block.kind === 'expected' || block.kind === 'when').flatMap(block => block.tagIds),
  ...step.branches.flatMap(branch => branch.limits?.comparisons.map(item => item.tagId) ?? []),
])]

/**
 * Why a reading cannot stand, for a limit and for a judgement alike. A limit adds
 * what only a stated comparison can ask, in `againstCriterion`.
 */
export const procedureReadingProblem = (read: ProcedureTagRead | undefined, tagId: string, frame: {
  readonly simulationTime: IsoTimestamp
  readonly plantId: string
  readonly maxAgeSeconds: number
}, againstCriterion?: (value: ProcedureTagValue) => string | undefined): string | undefined => {
  const value = read?.value
  const acquired = value?.evidence
  const ageSeconds = acquired === undefined ? undefined : (Date.parse(frame.simulationTime) - Date.parse(acquired.sampledAt)) / 1000
  return read === undefined ? `No observation acquired for ${tagId}.`
    : read.binding === 'unchecked' ? `Signal ${tagId} binding could not be checked.`
      : read.binding === 'missing' ? `Signal ${tagId} is not bound; absence does not establish a normal condition.`
        : value === undefined ? `Signal ${tagId} is unavailable: ${read.unavailable ?? 'no reading'}.`
          : typeof value.value === 'number' && !Number.isFinite(value.value) ? `Signal ${tagId} is not a finite observation.`
            : value.scopeId !== frame.plantId ? `Signal ${tagId} does not establish the requested plant scope.`
              : value.signalTagId !== tagId ? `Signal ${tagId} identity is not established by the returned binding.`
                : value.writable !== false ? `Signal ${tagId} is a command/demand or has unestablished writability; physical feedback is required.`
                  : value.quality !== 'good' ? `Signal ${tagId} quality is ${value.quality ?? 'unestablished'}.`
                    : againstCriterion?.(value)
                      ?? (ageSeconds === undefined || !Number.isFinite(ageSeconds) || ageSeconds < 0 || ageSeconds > frame.maxAgeSeconds ? `Signal ${tagId} sample is stale or is outside the current simulation-time frame.` : undefined)
}

const compare = (a: number | boolean, operator: string, b: number | boolean): boolean => {
  if (operator === '==') return a === b
  if (operator === '!=') return a !== b
  if (typeof a !== 'number' || typeof b !== 'number') throw new Error('Ordered comparison needs numeric operands')
  if (operator === '<') return a < b
  if (operator === '<=') return a <= b
  if (operator === '>') return a > b
  return a >= b
}

interface CriterionAcquisition {
  readonly reads: ReadonlyArray<ProcedureTagRead>
  readonly simulationTime: IsoTimestamp
  readonly plantId: string
}

/** Shared by branch admission and read-only advisory checks. */
export const assessProcedureBranch = (config: CriterionAcquisition & {
  readonly decision?: ProcedureDecision | undefined
  readonly branchIndex: number
  readonly observation?: AcquiredObservation | undefined
  /** Why a branch with no authored criterion is unestablished, where the document says more than the default. */
  readonly noCriterionReason?: string | undefined
}): { readonly assessment: ProcedureBranchAssessment; readonly validThrough?: IsoTimestamp; readonly observationApplies: boolean } => {
  const { branchIndex, decision, observation: observed } = config
  const readings: CriterionReading[] = []
  const reasons = new Set<string>()
  let validThroughMs = Infinity
  let observationApplies = false
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
      const reason = procedureReadingProblem(read, condition.tagId, { simulationTime: config.simulationTime, plantId: config.plantId, maxAgeSeconds: condition.maxAgeSeconds }, reading =>
        reading.conversionStatus === 'unavailable' || reading.unit !== condition.unit ? `Signal ${condition.tagId} does not supply criterion unit ${condition.unit}.`
          : reading.evidence === undefined || reading.evidence.kind !== condition.evidence ? `Signal ${condition.tagId} does not establish ${condition.evidence} evidence.`
            : decision?.applicability?.model !== undefined && (reading.evidence.modelRef !== decision.applicability.model.ref || reading.evidence.modelDigest !== decision.applicability.model.digest) ? `Signal ${condition.tagId} model identity does not match the pinned criterion applicability.`
              : undefined)
        ?? (typeof condition.value === 'number' && condition.bound !== 'value' ? `Signal ${condition.tagId} supplies a scalar; the requested ${condition.bound} interval bound is not established.`
          : typeof value!.value !== typeof condition.value ? `Signal ${condition.tagId} value type does not match the criterion.` : undefined)
      if (reason === undefined) validThroughMs = Math.min(validThroughMs, Date.parse(acquired!.sampledAt) + condition.maxAgeSeconds * 1000)
      const status = reason === undefined ? compare(value!.value as number | boolean, condition.operator, condition.value) ? 'supported' : 'contradicted' : unknown(reason)
      readings.push({ tagId: condition.tagId, source: condition.source, operator: condition.operator, expected: condition.value,
        ...(read === undefined ? {} : { binding: read.binding, warnings: [...read.warnings] }),
        evidence: condition.evidence, ...(condition.bound === undefined ? {} : { bound: condition.bound }),
        ...(value === undefined ? {} : { ...(typeof value.value === 'number' && Number.isFinite(value.value) || typeof value.value === 'boolean' ? { value: value.value as number | boolean } : {}),
          ...(value.unit === undefined ? {} : { unit: value.unit }), ...(value.path === undefined ? {} : { path: value.path }),
          ...(value.writable === undefined ? {} : { writable: value.writable }), ...(value.quality === undefined ? {} : { quality: value.quality }),
          ...(value.conversionStatus === undefined ? {} : { conversionStatus: value.conversionStatus }), ...(value.scopeId === undefined ? {} : { scopeId: value.scopeId }),
          ...(value.signalTagId === undefined ? {} : { signalTagId: value.signalTagId }) }),
        ...(acquired === undefined ? {} : { sampledAt: acquired.sampledAt, acquiredEvidence: acquired.kind, provenance: acquired.provenance,
          ...(acquired.modelRef === undefined ? {} : { modelRef: acquired.modelRef }), ...(acquired.modelDigest === undefined ? {} : { modelDigest: acquired.modelDigest }),
          ...(acquired.automationRef === undefined ? {} : { automationRef: acquired.automationRef }), ...(acquired.automationDigest === undefined ? {} : { automationDigest: acquired.automationDigest }) }),
        status, ...(reason === undefined ? {} : { reason }) })
      return status
    }
    if (condition.type === 'not-acquired') {
      // Explicit authored absence: only the owning Pack's own report that the tag is unbound on this Plant supports it.
      const statuses = condition.tagIds.map((tagId): ProcedureCriterionStatus => {
        const read = config.reads.find(candidate => candidate.tagId === tagId)
        const reason = read?.binding === 'missing' ? `Not acquired on this Plant: ${condition.description}`
          : read?.value !== undefined ? `Signal ${tagId} is acquired on this Plant; this not-acquired route does not apply.`
            : `Signal ${tagId} acquisition is not established: ${read?.unavailable ?? 'no reading'}.`
        const status = read?.binding === 'missing' ? 'supported' : read?.value !== undefined ? 'contradicted' : unknown(reason)
        readings.push({ tagId, source: condition.source, description: condition.description, ...(read === undefined ? {} : { binding: read.binding }), status, reason })
        return status
      })
      return statuses.includes('contradicted') ? 'contradicted' : statuses.includes('unknown') ? 'unknown' : 'supported'
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
  let status: ProcedureCriterionStatus
  if (decision?.observation !== undefined) {
    const result = observed?.result
    const age = typeof result?.simulationTime === 'string' ? (Date.parse(config.simulationTime) - Date.parse(result.simulationTime)) / 1000 : Number.NaN
    const scope = decision.applicability
    const reason = observed?.error ?? (result === undefined ? 'Declared branch observation was not acquired.'
      : result.targetObjectId !== config.plantId ? 'Branch observation does not establish its scoped operational object.'
        : result.evidenceKind !== 'engineering-diagnostic' || result.provenance !== 'runtime-model' ? 'Branch observation does not establish engineering diagnostic evidence provenance.'
          : !Number.isFinite(age) || age < 0 || age > decision.observation.maxAgeSeconds ? 'Branch observation is stale or outside the current simulation-time frame.'
            : scope?.model !== undefined && (result.modelRef !== scope.model.ref || result.modelDigest !== scope.model.digest) ? 'Branch observation model identity does not match the pinned criterion applicability.'
                : result.status !== 'satisfied' && result.status !== 'challenged' && result.status !== 'unknown' ? 'Branch observation returned an unrecognized status.' : undefined)
    status = reason !== undefined ? unknown(reason) : result!.status === 'satisfied' ? 'supported' : result!.status === 'challenged' ? 'contradicted' : unknown(typeof result!.reason === 'string' ? result!.reason : 'Declared branch observation is unestablished.')
    observationApplies = reason === undefined
    if (observationApplies) validThroughMs = Date.parse(result!.simulationTime as string) + decision.observation.maxAgeSeconds * 1000
  } else status = decision?.condition === undefined ? unknown(config.noCriterionReason ?? 'No authored eligibility criterion for this branch; a person may placekeep, but automatic qualification is unestablished.') : evaluate(decision.condition)
  const assessment: ProcedureBranchAssessment = { branchIndex, status, simulationTime: config.simulationTime,
    ...(decision === undefined ? {} : { ...(decision.condition === undefined ? {} : { condition: decision.condition }),
      ...(decision.observation === undefined ? {} : { observation: { ...decision.observation, ...(observed?.result === undefined ? {} : { result: observed.result }) } }),
      ...(decision.applicability === undefined ? {} : { applicability: decision.applicability }) }),
    readings, reasons: [...reasons] }
  // Expire conservatively if any acquired deciding input may age out.
  if ((!observationApplies && status === 'unknown') || !Number.isFinite(validThroughMs)) return { assessment, observationApplies }
  const lastIsoTimestampMs = Date.UTC(9999, 11, 31, 23, 59, 59, 999)
  return { assessment, observationApplies, validThrough: new Date(Math.min(validThroughMs, lastIsoTimestampMs)).toISOString() as IsoTimestamp }
}

/** A question no limit decides, with an answer that leaves the document. On a marked document a person answers it. */
export const procedureStepAsksPerson = (step: ProcedureStep): boolean =>
  (step.decisions?.length ?? 0) === 0 && step.branches.some(branch => branch.targetKind === 'procedure')

const judgementReason = (step: ProcedureStep, targetKind: ProcedureStep['branches'][number]['targetKind']): string =>
  targetKind === 'procedure' ? 'No limit decides this transfer. An AI agent stops and asks a person.'
    : targetKind === 'end' || targetKind === 'abort' ? 'No limit decides this ending. An AI agent stops and asks a person.'
      : procedureStepAsksPerson(step) ? 'No limit decides this step, and one of its answers leaves the procedure. An AI agent stops and asks a person.'
        : 'No limit decides this branch. It is a judgement: an AI agent decides it on a stated basis, if the readings on the step\'s lines are valid.'

export const assessProcedureBranches = (config: CriterionAcquisition & {
  readonly step: ProcedureStep
  readonly document?: Pick<ProcedureDocument, 'annotations'>
  readonly observations?: ReadonlyMap<number, AcquiredObservation>
}): ReadonlyArray<ProcedureBranchAssessment> => config.step.branches.map((branch, branchIndex) => assessProcedureBranch({
  ...config, branchIndex, decision: config.step.decisions?.find(candidate => candidate.branchIndex === branchIndex),
  noCriterionReason: config.document?.annotations?.['ai-workable'] === 'true' ? judgementReason(config.step, branch.targetKind) : undefined,
  observation: config.observations?.get(branchIndex),
}).assessment)

export const readProcedureBranchObservation = async (
  port: () => ProcedureObservationPort, binding: ProcedureDecisionObservation,
  context?: { readonly run: ProcedureRunState; readonly step: ProcedureStep; readonly events: ReadonlyArray<SimulationRunEvent> },
): Promise<AcquiredObservation> => {
  try {
    if (binding.afterStep === undefined) return { result: await port().readObservation(binding) }
    if (context === undefined || context.run.status !== 'active' || context.run.currentStepId !== context.step.id) throw new Error('The observation requires the accepted starting transition for the current step.')
    // Use the latest navigation event for this exact visit, never a comment or
    // an old successful step state. Manual repositioning and resumption break
    // the anchor; changing driver alone does not erase an ongoing observation.
    let navigationIndex = -1
    for (let index = context.events.length - 1; index >= 0; index--) {
      const event = context.events[index]!
      const navigation = event.type === 'procedure.run.started' ? event.run.runId === context.run.runId
        : 'runId' in event && event.runId === context.run.runId && (event.type === 'procedure.branch.selected'
          || event.type === 'procedure.run.resumed' || event.type === 'procedure.run.closed'
          || event.type === 'procedure.step.updated' && event.currentStepId !== undefined)
      if (navigation) { navigationIndex = index; break }
    }
    let latest = context.events[navigationIndex]
    // A selected branch and its placekeeping update are one accepted batch.
    // Only that adjacent update may share the branch's anchor.
    if (latest?.type === 'procedure.step.updated') {
      const selected = context.events[navigationIndex - 1]
      if (selected?.type === 'procedure.branch.selected' && selected.runId === latest.runId && selected.stepId === latest.stepId
        && selected.targetKind === 'step' && selected.target === latest.currentStepId
        && selected.provenance.causedByCommandId !== undefined && selected.provenance.causedByCommandId === latest.provenance.causedByCommandId) latest = selected
    }
    if (latest?.type !== 'procedure.branch.selected' || latest.targetKind !== 'step'
      || latest.target !== context.step.id || latest.criterion?.status !== 'supported') throw new Error('No supported observed transition establishes this visit\'s starting frame.')
    const repeated = latest.stepId === context.step.id && latest.outcome === 'normal' && latest.criterion.observation?.afterStep === binding.afterStep
    if (latest.stepId !== binding.afterStep && !repeated) throw new Error('The latest navigation did not enter from the declared observation start.')
    const retained = latest.criterion.observation?.result
    if (retained?.status !== 'satisfied') throw new Error('The preceding interval has no supported native observation.')
    // A supported self-loop starts at the preceding checked endpoint. Any gap
    // before the next read remains inside the next interval, never rolled away.
    const startingObservation = repeated ? retained.current as Readonly<Record<string, unknown>> | undefined : retained
    if (startingObservation === undefined || startingObservation.status !== 'satisfied' || startingObservation.targetObjectId !== context.run.scope.plantId
      || startingObservation.evidenceKind !== 'engineering-diagnostic' || startingObservation.provenance !== 'runtime-model'
      || typeof startingObservation.simulationTime !== 'string' || !Number.isFinite(Date.parse(startingObservation.simulationTime))
      || Date.parse(startingObservation.simulationTime) > Date.parse(latest.simulationTime)) throw new Error('The accepted starting transition has no applicable native observation.')
    return { result: await port().readObservation({ ...binding, input: { ...binding.input, startingObservation } }) }
  }
  catch (error) { return { error: error instanceof Error ? error.message : String(error) } }
}

/** Acquire the native tag frame once and every explicitly declared read-only branch query. */
export const readProcedureBranchEvidence = async (config: {
  readonly step: ProcedureStep
  readonly document: ProcedureDocument
  readonly observations: () => ProcedureObservationPort
  readonly branchIndex?: number
  readonly run?: ProcedureRunState
  readonly events?: ReadonlyArray<SimulationRunEvent>
}): Promise<{ readonly reads: ReadonlyArray<ProcedureTagRead>; readonly observations: ReadonlyMap<number, AcquiredObservation> }> => {
  const reads = await readProcedureTags({ observations: config.observations, declared: config.document.tags, tagIds: config.step.tagIds })
  const observations = new Map<number, AcquiredObservation>()
  for (const decision of config.step.decisions ?? []) {
    if (decision.observation === undefined || config.branchIndex !== undefined && config.branchIndex !== decision.branchIndex) continue
    observations.set(decision.branchIndex, await readProcedureBranchObservation(config.observations, decision.observation,
      config.run === undefined ? undefined : { run: config.run, step: config.step, events: config.events ?? [] }))
  }
  return { reads, observations }
}
