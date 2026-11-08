import { z } from 'zod'
import {
  planningSourceBasisSchema, planningSourceQualificationResultSchema, planningSourceRequestSchema,
  type AccessContext, type PlanningSourceBasis, type PlanningSourceRequest, type WorkspaceId,
} from '@leitbild/contracts'
import { checkPlanningProblem, planningProblemSchema, type PlanningProblem } from './model.ts'
import { scheduleProblem } from './scheduler.ts'
import { checkCandidate } from './checker.ts'
import { compareMetrics, dominatesMetrics } from './metrics.ts'
import { isPlanningError, planningError } from './errors.ts'
import { currentProblemRevision, planningAssumptionSchema, sourceBindingSchema, studySchema, type Candidate, type PlanningAssumption, type ProblemRevision, type SourceBinding, type Study } from './study-model.ts'
import type { PlanningSourceActivation, PlanningSourcePort } from './source-port.ts'
import type { StudyStore } from './study-store.ts'

export type { PlanningSourcePort, PlanningSources } from './source-port.ts'
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)
const sameSource = (a: PlanningSourceRequest['source'], b: PlanningSourceRequest['source']): boolean => a.workspaceId === b.workspaceId && a.moduleId === b.moduleId && a.type === b.type && a.id === b.id
const assertProblem = (input: unknown, workspaceId: WorkspaceId): PlanningProblem => {
  const check = checkPlanningProblem(input)
  if (check.status !== 'valid') throw planningError(400, check.status === 'unsupported' ? 'unsupported_profile' : 'invalid_problem', 'Planning problem is not supported or internally consistent', { issues: check.issues })
  if (check.problem.axis.run.workspaceId !== workspaceId || check.problem.activities.some(activity => activity.subject !== undefined && activity.subject.resource.workspaceId !== workspaceId)) throw planningError(400, 'workspace_scope_mismatch', 'Problem references must belong to the Study Workspace')
  return check.problem
}

export interface CreateStudyInput {
  readonly title: string
  readonly problem: unknown
  readonly sourceBindings?: ReadonlyArray<SourceBinding> | undefined
  readonly assumptions?: ReadonlyArray<PlanningAssumption> | undefined
}
export interface CreateSourcedStudyInput extends CreateStudyInput {
  readonly basis: PlanningSourceBasis
  readonly request: PlanningSourceRequest
}
export interface ReviseStudyInput {
  readonly expectedRevision: number
  readonly problem: unknown
  readonly sourceBindings?: ReadonlyArray<SourceBinding> | undefined
  readonly assumptions?: ReadonlyArray<PlanningAssumption> | undefined
}

const assertSource = (workspaceId: WorkspaceId, problem: PlanningProblem, request: PlanningSourceRequest, basis: PlanningSourceBasis): void => {
  if (request.source.workspaceId !== workspaceId || !sameSource(request.source, basis.source) || !sameSource(problem.axis.run, basis.source) || request.profile !== basis.profile) throw planningError(400, 'source_scope_mismatch', 'Problem, capture request and retained evidence must identify the same Run and profile')
}

const sourceFacts = (basis: PlanningSourceBasis) => {
  const facts = new Map<string, PlanningSourceBasis['subjects'][number]['facts'][number]>()
  for (const subject of basis.subjects) for (const fact of subject.facts) {
    if (facts.has(fact.id)) throw planningError(400, 'ambiguous_source_fact', `Owner returned duplicate fact identity: ${fact.id}`)
    facts.set(fact.id, fact)
  }
  return facts
}

const boundValue = (problem: PlanningProblem, binding: SourceBinding, facts: ReturnType<typeof sourceFacts>): number => {
  const fact = facts.get(binding.factId), target = binding.target
  if (!fact || typeof fact.value !== 'number' || !Number.isSafeInteger(fact.value) || fact.value < 0) throw planningError(400, 'source_binding_unavailable', `Bound source fact must be a nonnegative integer: ${binding.factId}`)
  if (target.kind === 'remaining') throw planningError(400, 'remaining_binding_unsupported', 'The current owner projections do not declare remaining-duration scope; author a remaining estimate explicitly instead')
  if (target.kind === 'duration') {
    if (!['duration', 'quantity'].includes(fact.semantic) || fact.unit !== 's') throw planningError(400, 'source_binding_unit_mismatch', `Duration binding requires an explicitly selected owner numeric quantity in seconds: ${binding.factId}`)
  } else {
    if (fact.semantic !== 'capacity') throw planningError(400, 'source_binding_semantic_mismatch', `Capacity binding requires an owner capacity: ${binding.factId}`)
    const supply = problem.supplies.find(supply => supply.id === target.supplyId)
    if (!supply) throw planningError(400, 'source_binding_target_missing', `Bound supply is absent: ${target.supplyId}`)
    if (!fact.unit || !supply.unit || fact.unit !== supply.unit) throw planningError(400, 'source_binding_unit_mismatch', `Capacity binding requires identical explicit owner and supply units (use '1' for counts): ${binding.factId}`)
  }
  return fact.value
}

const assertBindings = (problem: PlanningProblem, bindings: ReadonlyArray<SourceBinding>, basis?: PlanningSourceBasis): void => {
  const targets = new Set<string>()
  const facts = basis === undefined ? undefined : sourceFacts(basis)
  for (const binding of bindings) {
    const target = binding.target
    if (target.kind === 'remaining') throw planningError(400, 'remaining_binding_unsupported', 'The current owner projections do not declare remaining-duration scope; author a remaining estimate explicitly instead')
    const key = target.kind === 'duration' ? `duration:${target.activityId}` : `capacity:${target.supplyId}`
    if (targets.has(key)) throw planningError(400, 'duplicate_source_binding', 'Only one owner fact may bind a problem field')
    targets.add(key)
    if (target.kind === 'duration' && !problem.activities.some(activity => activity.id === target.activityId)) throw planningError(400, 'source_binding_target_missing', 'A duration binding must name an activity in the problem')
    if (target.kind === 'capacity' && !problem.supplies.some(supply => supply.id === target.supplyId)) throw planningError(400, 'source_binding_target_missing', 'A capacity binding must name a supply in the problem')
    if (facts === undefined) continue
    const value = boundValue(problem, binding, facts)
    if (target.kind === 'duration') {
      const activity = problem.activities.find(activity => activity.id === target.activityId)!
      // Duration bindings govern planned work, never recorded total/remaining work.
      if (activity.progress.kind === 'planned' && activity.durationSeconds !== value) throw planningError(400, 'source_binding_value_mismatch', 'A planned duration must equal its retained bound fact; remove the binding to author an override')
    } else if (problem.supplies.find(supply => supply.id === target.supplyId)!.segments.some(segment => segment.capacity !== value)) {
      throw planningError(400, 'source_binding_value_mismatch', 'Every bound capacity window must equal its retained scalar fact; represent unavailable windows as gaps or remove the binding to author capacities')
    }
  }
}

const applySource = (revision: ProblemRevision, request: PlanningSourceRequest, basis: PlanningSourceBasis): PlanningProblem => {
  assertSource(basis.source.workspaceId, revision.problem, request, basis)
  if (revision.basis !== undefined && !sameSource(revision.basis.source, basis.source)) throw planningError(409, 'source_rebind_unsupported', 'Create a new Study to bind a different Simulation Run')
  if (revision.basis !== undefined && revision.basis.qualification.epoch !== basis.qualification.epoch) throw planningError(409, 'source_epoch_changed', 'The source Run was reset or replaced during capture; create a new Study for the new epoch')
  const epoch = revision.sourceEpochAt ?? basis.simulationAt
  const elapsedMs = Date.parse(basis.simulationAt) - Date.parse(epoch)
  if (elapsedMs < 0) throw planningError(409, 'source_time_reversed', 'Source time precedes the retained Study epoch; copy or reset requires a new Study')
  // The first model uses whole elapsed seconds. Preserve the original ISO stamp as evidence.
  const asOf = Math.floor(elapsedMs / 1000)
  if (asOf < revision.problem.asOf) throw planningError(409, 'source_frame_behind_progress', 'The source frame precedes retained Study progress; advance the source before refreshing')
  if (asOf > revision.problem.horizon.end) throw planningError(409, 'planning_horizon_elapsed', 'The source advanced beyond this Study horizon; extend the authored horizon before refreshing')
  const facts = sourceFacts(basis)
  const problem = structuredClone(revision.problem)
  problem.asOf = asOf
  for (const activity of problem.activities) if (activity.progress.kind === 'started') activity.progress = {
    ...activity.progress, asOf, remainingSeconds: asOf === revision.problem.asOf ? activity.progress.remainingSeconds : null,
  }
  for (const binding of revision.sourceBindings) {
    const target = binding.target
    const value = boundValue(problem, binding, facts)
    if (target.kind === 'duration' || target.kind === 'remaining') {
      const activity = problem.activities.find(activity => activity.id === target.activityId)
      if (!activity) throw planningError(400, 'source_binding_target_missing', `Bound activity is absent: ${target.activityId}`)
      if (activity.progress.kind === 'completed') continue
      if (target.kind === 'remaining') {
        throw planningError(400, 'remaining_binding_unsupported', 'Owner projections do not yet declare remaining-duration scope')
      } else if (activity.progress.kind === 'planned') activity.durationSeconds = value
    } else {
      const supply = problem.supplies.find(supply => supply.id === target.supplyId)
      if (!supply) throw planningError(400, 'source_binding_target_missing', `Bound supply is absent: ${target.supplyId}`)
      supply.segments = supply.segments.map(segment => ({ ...segment, capacity: value }))
    }
  }
  return assertProblem(problem, basis.source.workspaceId)
}

const assertCommittedHistory = (previous: PlanningProblem, next: PlanningProblem): void => {
  if (next.asOf < previous.asOf) throw planningError(409, 'actual_history_reversed', 'A revised problem cannot move its asOf time backwards')
  for (const activity of previous.activities) {
    if (activity.progress.kind === 'planned') continue
    const after = next.activities.find(item => item.id === activity.id)
    if (!after || after.progress.kind === 'planned' || after.progress.actualStart !== activity.progress.actualStart || after.modeId !== activity.modeId || !same(after.demands, activity.demands) || !same(after.subject, activity.subject)) throw planningError(409, 'committed_history_changed', 'Actual starts, subjects and committed assignments cannot be rewritten by revision')
    if (activity.progress.kind === 'completed' && !same(after.progress, activity.progress)) throw planningError(409, 'completed_history_changed', 'Completed actual history cannot be rewritten by revision')
  }
}

export const createPlanningService = (config: { readonly store: StudyStore; readonly sources: PlanningSourcePort; readonly now?: () => Date }) => {
  const now = () => (config.now?.() ?? new Date()).toISOString()
  const qualifyBasis = async (basis: PlanningSourceBasis, access: AccessContext, activation: PlanningSourceActivation): Promise<void> => {
    let answer: unknown
    try { answer = await config.sources.qualify(basis, access, activation) }
    catch (error) {
      // Expected owner/Host availability failures hide retained evidence. Contract
      // parsing and unexpected programming defects remain observable to operators.
      const unavailableCodes = ['source_transport_unavailable', 'module_unavailable', 'module_not_ready', 'workspace_closing', 'workspace_not_found', 'simulation_run_not_found', 'simulation_run_not_loaded', 'query_read_scope_unavailable', 'query_policy_superseded']
      if (!isPlanningError(error) || !unavailableCodes.includes(error.code)) throw error
      throw planningError(403, 'planning_source_unavailable', 'The retained Study source is unavailable or no longer qualified for this shared audience', { sourceCode: error.code })
    }
    const result = planningSourceQualificationResultSchema.parse(answer)
    if (!result.allowed) throw planningError(403, 'planning_source_unavailable', 'The retained Study source is unavailable or no longer qualified for this shared audience', { sourceCode: result.code ?? 'source_not_qualified' })
  }
  const qualify = async (study: Study, access: AccessContext, activation: PlanningSourceActivation = 'load-if-needed'): Promise<void> => {
    if (access.workspaceId !== study.workspaceId) throw planningError(403, 'workspace_scope_mismatch', 'Access context belongs to another Workspace')
    const checked = new Set<string>()
    for (const revision of study.revisions) {
      if (revision.basis === undefined) continue
      const key = JSON.stringify({ source: revision.basis.source, profile: revision.basis.profile, qualification: revision.basis.qualification })
      if (checked.has(key)) continue
      checked.add(key)
      await qualifyBasis(revision.basis, access, activation)
    }
  }
  const read = async (workspaceId: WorkspaceId, studyId: string, access: AccessContext): Promise<Study> => {
    const study = await config.store.read(workspaceId, studyId)
    await qualify(study, access)
    return study
  }
  const create = async (workspaceId: WorkspaceId, input: CreateStudyInput, sourced?: { basis: PlanningSourceBasis; request: PlanningSourceRequest }): Promise<Study> => {
    const problem = assertProblem(input.problem, workspaceId)
    const sourceBindings = z.array(sourceBindingSchema).parse(input.sourceBindings ?? [])
    const assumptions = z.array(planningAssumptionSchema).parse(input.assumptions ?? [])
    if (sourced !== undefined) assertSource(workspaceId, problem, sourced.request, sourced.basis)
    else if (sourceBindings.length > 0) throw planningError(400, 'source_binding_without_basis', 'Capture an owner basis before declaring source bindings')
    assertBindings(problem, sourceBindings, sourced?.basis)
    const stamp = now()
    const revision = { id: 1, createdAt: stamp, problem, sourceBindings, assumptions, ...(sourced === undefined ? {} : { basis: sourced.basis, sourceRequest: { ...sourced.request, subjectIds: [...sourced.basis.qualification.subjectIds] }, sourceEpochAt: sourced.basis.simulationAt }) }
    return await config.store.create(workspaceId, studySchema.parse({ id: crypto.randomUUID(), workspaceId, title: input.title, revision: 1, currentProblemRevisionId: 1, revisions: [revision], candidates: [], createdAt: stamp, updatedAt: stamp }))
  }
  const capture = async (workspaceId: WorkspaceId, input: { studyId: string; expectedRevision: number; request: PlanningSourceRequest }, access: AccessContext) => {
    const study = await read(workspaceId, input.studyId, access)
    if (study.revision !== input.expectedRevision) throw planningError(409, 'study_revision_conflict', 'Read the current Study before capturing sources')
    const previous = currentProblemRevision(study)
    const request = planningSourceRequestSchema.parse(input.request)
    if (request.source.workspaceId !== workspaceId) throw planningError(400, 'workspace_scope_mismatch', 'Capture source belongs to another Workspace')
    if (previous.sourceRequest && !same(previous.sourceRequest, request)) throw planningError(409, 'source_rebind_unsupported', 'The first profile refreshes its original source selection; create another Study to rebind it')
    const basis = planningSourceBasisSchema.parse(await config.sources.capture(request, access))
    const problem = applySource(previous, request, basis)
    const changed = previous.basis === undefined || previous.basis.digest !== basis.digest || !same(previous.problem, problem)
    if (!changed) return { study, changed: false }
    const stamp = now()
    const next = await config.store.update(workspaceId, study.id, input.expectedRevision, current => {
      const id = current.currentProblemRevisionId + 1
      return { ...current, revision: current.revision + 1, currentProblemRevisionId: id, updatedAt: stamp, revisions: [...current.revisions, { id, createdAt: stamp, problem, basis, sourceRequest: { ...request, subjectIds: [...basis.qualification.subjectIds] }, sourceEpochAt: previous.sourceEpochAt ?? basis.simulationAt, sourceBindings: previous.sourceBindings, assumptions: previous.assumptions }] }
    })
    return { study: next, changed: true }
  }
  return {
    store: config.store,
    sources: config.sources,
    qualify,
    read,
    create: (workspaceId: WorkspaceId, input: CreateStudyInput) => create(workspaceId, input),
    createFromBasis: async (workspaceId: WorkspaceId, input: CreateSourcedStudyInput, access: AccessContext): Promise<Study> => {
      const basis = planningSourceBasisSchema.parse(input.basis)
      const request = planningSourceRequestSchema.parse(input.request)
      await qualifyBasis(basis, access, 'load-if-needed')
      return await create(workspaceId, input, { basis, request })
    },
    list: async (workspaceId: WorkspaceId, access: AccessContext) => {
      const studies = await config.store.list(workspaceId)
      const results: Array<{ study: Study; available: boolean }> = []
      for (const study of studies) {
        try { await qualify(study, access, 'loaded-only'); results.push({ study, available: true }) }
        catch (error) {
          if (!(error instanceof Error && 'code' in error && error.code === 'planning_source_unavailable')) throw error
          results.push({ study, available: false })
        }
      }
      return results
    },
    revise: async (workspaceId: WorkspaceId, studyId: string, input: ReviseStudyInput, access: AccessContext): Promise<Study> => {
      const study = await read(workspaceId, studyId, access)
      const previous = currentProblemRevision(study)
      const problem = assertProblem(input.problem, workspaceId)
      if (!sameSource(problem.axis.run, previous.problem.axis.run)) throw planningError(409, 'source_rebind_unsupported', 'Create a new Study to change its source Run')
      assertCommittedHistory(previous.problem, problem)
      const sourceBindings = z.array(sourceBindingSchema).parse(input.sourceBindings ?? previous.sourceBindings)
      const assumptions = z.array(planningAssumptionSchema).parse(input.assumptions ?? previous.assumptions)
      if (!previous.basis && sourceBindings.length > 0) throw planningError(400, 'source_binding_without_basis', 'Capture an owner basis before declaring source bindings')
      assertBindings(problem, sourceBindings, previous.basis)
      const stamp = now()
      return await config.store.update(workspaceId, studyId, input.expectedRevision, current => {
        const id = current.currentProblemRevisionId + 1
        return { ...current, revision: current.revision + 1, currentProblemRevisionId: id, updatedAt: stamp, revisions: [...current.revisions, { ...previous, id, createdAt: stamp, problem, sourceBindings, assumptions }] }
      })
    },
    capture,
    refresh: async (workspaceId: WorkspaceId, input: { studyId: string; expectedRevision: number }, access: AccessContext) => {
      const study = await read(workspaceId, input.studyId, access)
      const request = currentProblemRevision(study).sourceRequest
      if (!request) throw planningError(409, 'study_has_no_source', 'Capture a source basis before refreshing')
      return await capture(workspaceId, { ...input, request }, access)
    },
    solve: async (workspaceId: WorkspaceId, studyId: string, expectedRevision: number, access: AccessContext, maxPlacementChecks?: number) => {
      const study = await read(workspaceId, studyId, access)
      const revision = currentProblemRevision(study)
      // A caller may lower/raise the explicit work budget. This default bounds a
      // small interactive calculation without claiming a runtime or optimum.
      const result = scheduleProblem(revision.problem, { maxPlacementChecks: maxPlacementChecks ?? 100_000 })
      if (result.status === 'feasible') {
        const check = checkCandidate(revision.problem, result.placements)
        if (check.status !== 'satisfied') throw planningError(500, 'candidate_check_failed', 'Scheduling result failed its independent constraint check', { issues: check.issues })
      }
      const stamp = now()
      const candidate: Candidate = { id: crypto.randomUUID(), problemRevisionId: revision.id, createdAt: stamp, result }
      const next = await config.store.update(workspaceId, studyId, expectedRevision, current => ({ ...current, revision: current.revision + 1, updatedAt: stamp, candidates: [...current.candidates, candidate] }))
      return { study: next, candidate }
    },
    compare: async (workspaceId: WorkspaceId, studyId: string, candidateIds: ReadonlyArray<string>, access: AccessContext) => {
      const study = await read(workspaceId, studyId, access)
      const candidates = candidateIds.map(id => {
        const candidate = study.candidates.find(candidate => candidate.id === id)
        if (!candidate) throw planningError(404, 'candidate_not_found', 'Candidate not found in this Study')
        return candidate
      })
      const first = candidates[0]
      if (!first) throw planningError(400, 'comparison_empty', 'Select at least two candidates')
      const problem = study.revisions.find(revision => revision.id === first.problemRevisionId)?.problem
      if (!problem) throw planningError(500, 'candidate_problem_missing', 'Candidate problem revision is absent')
      const sameProblem = candidates.every(candidate => candidate.problemRevisionId === first.problemRevisionId)
      const revisionFor = (candidate: Candidate) => study.revisions.find(revision => revision.id === candidate.problemRevisionId)
      const firstRevision = revisionFor(first)
      const modelSignature = (revision: ProblemRevision) => {
        const { priorityOrder: _priorityOrder, ...mathematicalModel } = revision.problem
        return JSON.stringify({ mathematicalModel, sourceDigest: revision.basis?.digest ?? null })
      }
      const comparable = firstRevision !== undefined && candidates.every(candidate => {
        const revision = revisionFor(candidate)
        return revision !== undefined && modelSignature(revision) === modelSignature(firstRevision)
      })
      const pairs = []
      for (let index = 1; index < candidates.length; index++) {
        const candidate = candidates[index]
        if (!candidate) throw new Error('Comparison candidate missing')
        const a = first.result.metrics, b = candidate.result.metrics
        pairs.push({ left: first.id, right: candidate.id, ...(comparable && a && b ? { lexicographic: compareMetrics(problem, a, b), leftDominates: dominatesMetrics(problem, a, b), rightDominates: dominatesMetrics(problem, b, a) } : { warning: comparable ? 'Incomplete candidates have no complete objective metrics' : 'Different mathematical model or source evidence; raw metrics may be compared but dominance is not asserted' }) })
      }
      return { candidates, sameProblem, comparable, pairs }
    },
    baseline: async (workspaceId: WorkspaceId, studyId: string, candidateId: string, expectedRevision: number, access: AccessContext) => {
      const study = await read(workspaceId, studyId, access)
      if (!study.candidates.some(candidate => candidate.id === candidateId && candidate.result.status === 'feasible')) throw planningError(400, 'baseline_candidate_invalid', 'A baseline must identify a retained feasible candidate')
      return await config.store.update(workspaceId, studyId, expectedRevision, current => ({ ...current, revision: current.revision + 1, baselineCandidateId: candidateId, updatedAt: now() }))
    },
    delete: (workspaceId: WorkspaceId, studyId: string, expectedRevision: number) => config.store.delete(workspaceId, studyId, expectedRevision),
  }
}
export type PlanningService = ReturnType<typeof createPlanningService>
