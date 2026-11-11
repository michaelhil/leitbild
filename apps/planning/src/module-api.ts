import { z } from 'zod'
import {
  moduleActivitySchema, moduleCapabilityInvocationSchema, moduleIdSchema, moduleResourceDescriptorSchema,
  inspectionViewSchema, workspaceResourceReferenceSchema, isoTimestampSchema, planningSourceBasisSchema,
  newRequestId, workspaceIdSchema, workspaceModuleManifestSchema,
  type AccessContext, type ModuleCapabilityInvocation, type ModuleResourceDescriptor, type WorkspaceId,
} from '@leitbild/contracts'
import { createModuleCapabilityRegistry, type CapabilityRegistration } from '@leitbild/module-runtime'
import { planningProblemSchema, checkPlanningProblem, planningCandidateCheckSchema, planningIssueSchema, planningMetricsSchema } from './model.ts'
import { checkCandidate } from './checker.ts'
import { currentProblemRevision, planningAssumptionSchema, sourceBindingSchema, studySchema, candidateSchema, problemRevisionSchema, type Study } from './study-model.ts'
import { planningSourceRequestSchema } from '@leitbild/contracts'
import { isPlanningError, planningError } from './errors.ts'
import type { PlanningService } from './service.ts'

export const planningModuleManifest = workspaceModuleManifestSchema.parse({
  module: { id: 'planning', title: 'Planning', description: 'Research Studies, retained evidence, elapsed-time schedules, alternatives and source-qualified comparisons.' },
  endpoints: {
    workspace: '/internal/workspaces/{workspaceId}',
    definitions: '/internal/workspaces/{workspaceId}/definitions',
    resources: '/internal/workspaces/{workspaceId}/resources',
    capabilities: '/internal/workspaces/{workspaceId}/capabilities',
    invoke: '/internal/workspaces/{workspaceId}/capabilities/{capabilityId}/invoke',
    featuredDefinitions: '/internal/featured-definitions', activity: '/internal/activity',
  },
  ui: { workspace: '/workspaces/{workspaceId}/planning' },
})

export interface PlanningDemoDescriptor { readonly id: 'response' | 'component-work'; readonly title: string; readonly description: string }
export interface PlanningDemoPort {
  readonly list: () => ReadonlyArray<PlanningDemoDescriptor>
  readonly start: (workspaceId: WorkspaceId, input: { readonly case: 'response' | 'component-work' }, access: AccessContext) => Promise<Study>
}

const moduleId = moduleIdSchema.parse('planning')
const emptySchema = z.object({}).strict()
const revisionSchema = z.number().int().positive()
const createSchema = z.object({ title: z.string().trim().min(1).max(256), problem: planningProblemSchema, sourceBindings: z.array(sourceBindingSchema).optional(), assumptions: z.array(planningAssumptionSchema).optional() }).strict()
const reviseSchema = createSchema.omit({ title: true }).extend({ expectedRevision: revisionSchema }).strict()
const captureSchema = z.object({ studyId: z.uuid(), expectedRevision: revisionSchema, request: planningSourceRequestSchema }).strict()
const refreshSchema = z.object({ studyId: z.uuid(), expectedRevision: revisionSchema }).strict()
const readSchema = z.object({ section: z.enum(['overview', 'problem', 'candidates', 'evidence', 'all']).default('overview'), candidateId: z.uuid().optional() }).strict()
const solveSchema = z.object({ expectedRevision: revisionSchema, maxPlacementChecks: z.number().int().positive().max(10_000_000).optional() }).strict()
const compareSchema = z.object({ candidateIds: z.array(z.uuid()).min(2).max(32) }).strict()
const baselineSchema = z.object({ candidateId: z.uuid(), expectedRevision: revisionSchema }).strict()
// Delete takes no input, so Host's delete card can offer it. Its optional
// precondition is the envelope revision, as for every other Module.
const deleteSchema = z.object({}).strict()
const demoSchema = z.object({ case: z.enum(['response', 'component-work']) }).strict()
const summarySchema = z.object({ id: z.uuid(), title: z.string(), revision: revisionSchema, currentProblemRevisionId: revisionSchema, baselineCandidateId: z.uuid().optional(), createdAt: isoTimestampSchema, updatedAt: isoTimestampSchema }).strict()
const candidateSummarySchema = z.object({ id: z.uuid(), problemRevisionId: revisionSchema, createdAt: isoTimestampSchema, stale: z.boolean(), status: candidateSchema.shape.result.shape.status, metrics: planningMetricsSchema.nullable(), issueCount: z.number().int().nonnegative() }).strict()
const createdSchema = z.object({ study: studySchema, resource: workspaceResourceReferenceSchema }).strict()
const capturedSchema = z.object({ study: studySchema, changed: z.boolean() }).strict()
const readResultSchema = z.union([
  studySchema,
  z.object({ study: summarySchema, candidate: candidateSchema, stale: z.boolean() }).strict(),
  z.object({ study: summarySchema, problemRevision: problemRevisionSchema }).strict(),
  z.object({ study: summarySchema, basis: planningSourceBasisSchema.optional(), sourceEpochAt: isoTimestampSchema.optional(), assumptions: z.array(planningAssumptionSchema), sourceBindings: z.array(sourceBindingSchema) }).strict(),
  z.object({ study: summarySchema, candidates: z.array(candidateSummarySchema) }).strict(),
  summarySchema.extend({ activityCount: z.number().int().nonnegative(), supplyCount: z.number().int().nonnegative(), sourceCaptured: z.boolean(), candidates: z.array(candidateSummarySchema) }).strict(),
])
const problemCheckSchema = z.union([
  z.object({ status: z.literal('valid'), problem: planningProblemSchema, issues: z.array(planningIssueSchema).max(0) }).strict(),
  z.object({ status: z.enum(['invalid', 'unsupported']), issues: z.array(planningIssueSchema) }).strict(),
])
const comparisonSchema = z.object({ candidates: z.array(candidateSchema), sameProblem: z.boolean(), comparable: z.boolean(), pairs: z.array(z.union([
  z.object({ left: z.uuid(), right: z.uuid(), lexicographic: z.union([z.literal(-1), z.literal(0), z.literal(1)]), leftDominates: z.boolean(), rightDominates: z.boolean() }).strict(),
  z.object({ left: z.uuid(), right: z.uuid(), warning: z.string() }).strict(),
])) }).strict()
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } })
const resourceFor = (workspaceId: WorkspaceId, studyId: string) => ({ workspaceId, moduleId: 'planning' as const, type: 'planning.study' as const, id: studyId })
const summary = (study: Study) => ({ id: study.id, title: study.title, revision: study.revision, currentProblemRevisionId: study.currentProblemRevisionId, baselineCandidateId: study.baselineCandidateId, createdAt: study.createdAt, updatedAt: study.updatedAt })
const candidateSummary = (study: Study) => study.candidates.map(candidate => ({
  id: candidate.id, problemRevisionId: candidate.problemRevisionId, createdAt: candidate.createdAt, stale: candidate.problemRevisionId !== study.currentProblemRevisionId,
  status: candidate.result.status, metrics: candidate.result.metrics, issueCount: candidate.result.issues.length,
}))
const studyIdFor = (invocation: ModuleCapabilityInvocation): string => {
  const resource = invocation.resource
  if (!resource || resource.type !== 'planning.study' || resource.moduleId !== 'planning') throw planningError(400, 'study_target_required', 'Select an exact Planning Study Resource')
  return z.uuid().parse(resource.id)
}
const catalogAccess = (workspaceId: WorkspaceId): AccessContext => ({ workspaceId, requestId: newRequestId(), actor: { kind: 'anonymous' }, client: { id: 'planning-catalog', kind: 'service' } })

export const createPlanningModuleApi = (config: { readonly service: PlanningService; readonly demos?: PlanningDemoPort }) => {
  const registrations: Array<CapabilityRegistration<PlanningService, Response>> = []
  const add = <T>(input: { id: string; kind: 'command' | 'query'; scope: 'workspace' | 'study'; title: string; description: string; schema: z.ZodType<T>; output: z.ZodType; destructive?: boolean; publishesStudy?: boolean; invoke: (service: PlanningService, invocation: ModuleCapabilityInvocation, input: T) => Promise<unknown> }) => {
    registrations.push({
      descriptor: {
        id: input.id, moduleId, kind: input.kind,
        scope: input.scope === 'workspace' ? { kind: 'workspace' } : { kind: 'resource', resourceType: 'planning.study' },
        title: input.title, description: input.description, risk: input.destructive ? 'destructive' : input.kind === 'query' ? 'read' : 'write', idempotent: input.kind === 'query',
        inputSchema: z.toJSONSchema(input.schema), outputSchema: z.toJSONSchema(input.output),
      },
      invoke: async (service, invocation) => {
        const raw = await input.invoke(service, invocation, input.schema.parse(invocation.input))
        const parsed = input.output.safeParse(raw)
        if (!parsed.success) throw planningError(500, 'invalid_planning_result', 'Planning returned a result that does not match its published output schema')
        const result = parsed.data
        const resource = input.publishesStudy ? z.object({ resource: workspaceResourceReferenceSchema }).passthrough().parse(result).resource : undefined
        return json({ result, ...(resource === undefined ? {} : { createdResources: [resource] }) })
      },
    })
  }
  add({ id: 'planning.study.create', output: createdSchema, kind: 'command', scope: 'workspace', title: 'Create Planning Study', description: 'Create an authored research problem on one exact World Run axis. Does not capture live owner values or mutate World. Save chosen methods/resources and explicit assumptions.', schema: createSchema, publishesStudy: true,
    invoke: async (service, invocation, input) => {
      const study = await service.create(invocation.workspaceId, input)
      return { study, resource: resourceFor(study.workspaceId, study.id) }
    } })
  add({ id: 'planning.sources.capture', output: capturedSchema, kind: 'command', scope: 'workspace', title: 'Capture Planning Sources', description: 'Capture shared research input from one open role-free World Run into a Study revision. Workspace scope is required; nested source ids never broaden a Study Room scope. No World writes.', schema: captureSchema,
    invoke: (service, invocation, input) => service.capture(invocation.workspaceId, input, invocation.access) })
  add({ id: 'planning.sources.refresh', output: capturedSchema, kind: 'command', scope: 'workspace', title: 'Refresh Planning Sources', description: 'Refresh exactly the retained source selection, apply explicit fact bindings, and conservatively stale older candidates if consumed input changes. Retains original simulation epoch and actual history. No World writes.', schema: refreshSchema,
    invoke: (service, invocation, input) => service.refresh(invocation.workspaceId, input, invocation.access) })
  add({ id: 'planning.study.read', output: readResultSchema, kind: 'query', scope: 'study', title: 'Inspect Planning Study', description: 'Read qualified retained Study inputs or results. Default overview is bounded; request problem, evidence, candidates or one candidate. Stale candidates describe prior revisions, not current predictions. Does not refresh live source values.', schema: readSchema,
    invoke: async (service, invocation, input) => {
      const study = await service.read(invocation.workspaceId, studyIdFor(invocation), invocation.access)
      const current = currentProblemRevision(study)
      if (input.candidateId) {
        const candidate = study.candidates.find(candidate => candidate.id === input.candidateId)
        if (!candidate) throw planningError(404, 'candidate_not_found', 'Candidate not found')
        return { study: summary(study), candidate, stale: candidate.problemRevisionId !== current.id }
      }
      if (input.section === 'all') return study
      if (input.section === 'problem') return { study: summary(study), problemRevision: current }
      if (input.section === 'evidence') return { study: summary(study), basis: current.basis, sourceEpochAt: current.sourceEpochAt, assumptions: current.assumptions, sourceBindings: current.sourceBindings }
      if (input.section === 'candidates') return { study: summary(study), candidates: candidateSummary(study) }
      return { ...summary(study), activityCount: current.problem.activities.length, supplyCount: current.problem.supplies.length, sourceCaptured: current.basis !== undefined, candidates: candidateSummary(study).slice(-10) }
    } })
  add({ id: 'planning.study.revise', output: studySchema, kind: 'command', scope: 'study', title: 'Revise Planning Problem', description: 'Save a new immutable authored problem revision. Exact chosen modes/resources, elapsed seconds and FS precedence only. Actual starts and committed assignments are preserved; remaining estimates may change. No source refresh or World writes.', schema: reviseSchema,
    invoke: (service, invocation, input) => service.revise(invocation.workspaceId, studyIdFor(invocation), input, invocation.access) })
  add({ id: 'planning.study.inspect', output: inspectionViewSchema, kind: 'query', scope: 'study', title: 'Inspect Planning Study Sections', description: 'Present the canonical Host inspector for this qualified Study: problem, retained evidence and candidate summaries. Does not capture new source values.', schema: emptySchema,
    invoke: async (service, invocation) => {
      const study = await service.read(invocation.workspaceId, studyIdFor(invocation), invocation.access)
      const revision = currentProblemRevision(study)
      const data = (value: unknown) => z.json().parse(JSON.parse(JSON.stringify(value)))
      return inspectionViewSchema.parse({ target: { kind: 'resource', resource: resourceFor(study.workspaceId, study.id) }, title: study.title, observedAt: new Date().toISOString(), sections: [
        { id: 'problem', title: 'Current problem', data: data({ studyRevision: study.revision, problemRevisionId: revision.id, problem: revision.problem }) },
        { id: 'evidence', title: 'Evidence and assumptions', data: data({ basis: revision.basis, sourceEpochAt: revision.sourceEpochAt, assumptions: revision.assumptions, sourceBindings: revision.sourceBindings }) },
        { id: 'candidates', title: 'Retained candidates', data: data({ baselineCandidateId: study.baselineCandidateId, candidates: candidateSummary(study) }) },
      ] })
    } })
  add({ id: 'planning.problem.check', output: problemCheckSchema, kind: 'query', scope: 'study', title: 'Check Planning Problem', description: 'Check the current retained problem for the declared elapsed-FS profile and internal consistency. Does not save or start a calculation.', schema: emptySchema,
    invoke: async (service, invocation) => checkPlanningProblem(currentProblemRevision(await service.read(invocation.workspaceId, studyIdFor(invocation), invocation.access)).problem) })
  add({ id: 'planning.study.solve', output: z.object({ study: studySchema, candidate: candidateSchema }).strict(), kind: 'command', scope: 'study', title: 'Calculate Schedule', description: 'Place a supplied candidate with fixed methods/actual resources and a deterministic priority order. Save one attempt/result. Feasible is independently checked; a failed or budget-limited heuristic is unknown, not proved infeasible or optimal. No World writes.', schema: solveSchema,
    invoke: (service, invocation, input) => service.solve(invocation.workspaceId, studyIdFor(invocation), input.expectedRevision, invocation.access, input.maxPlacementChecks) })
  add({ id: 'planning.candidate.check', output: z.object({ check: planningCandidateCheckSchema, stale: z.boolean() }).strict(), kind: 'query', scope: 'study', title: 'Check Candidate', description: 'Independently check one retained candidate against its exact problem revision. This establishes modeled timing/capacity constraints, not physical success or live prerequisites.', schema: z.object({ candidateId: z.uuid() }).strict(),
    invoke: async (service, invocation, input) => {
      const study = await service.read(invocation.workspaceId, studyIdFor(invocation), invocation.access)
      const candidate = study.candidates.find(candidate => candidate.id === input.candidateId)
      const revision = study.revisions.find(revision => revision.id === candidate?.problemRevisionId)
      if (!candidate || !revision) throw planningError(404, 'candidate_not_found', 'Candidate not found')
      return { check: checkCandidate(revision.problem, candidate.result.placements), stale: revision.id !== study.currentProblemRevisionId }
    } })
  add({ id: 'planning.study.compare', output: comparisonSchema, kind: 'query', scope: 'study', title: 'Compare Planning Candidates', description: 'Compare supplied candidate objective vectors and retained assumptions. Dominance/lexicographic comparison requires the same mathematical model and source digest; only priority order may differ. Other cross-revision raw differences remain qualified.', schema: compareSchema,
    invoke: (service, invocation, input) => service.compare(invocation.workspaceId, studyIdFor(invocation), input.candidateIds, invocation.access) })
  add({ id: 'planning.study.baseline.set', output: studySchema, kind: 'command', scope: 'study', title: 'Retain Planning Baseline', description: 'Name a saved feasible candidate as baseline. Does not overwrite the candidate or update World.', schema: baselineSchema,
    invoke: (service, invocation, input) => service.baseline(invocation.workspaceId, studyIdFor(invocation), input.candidateId, input.expectedRevision, invocation.access) })
  add({ id: 'planning.study.delete', output: z.object({ deleted: z.literal(true) }).strict(), kind: 'command', scope: 'study', title: 'Delete Planning Study', description: 'Delete this Study, its retained evidence, revisions and candidates. Source World Runs are retained. Pass the envelope expectedRevision to refuse the delete if the Study changed since you read it.', schema: deleteSchema, destructive: true,
    invoke: async (service, invocation) => { await service.delete(invocation.workspaceId, studyIdFor(invocation), invocation.expectedRevision); return { deleted: true } } })
  if (config.demos) {
    const demos = config.demos
    add({ id: 'planning.demos.read', output: z.object({ demos: z.array(z.object({ id: z.enum(['response', 'component-work']), title: z.string(), description: z.string() }).strict()) }).strict(), kind: 'query', scope: 'workspace', title: 'List Planning Demonstrations', description: 'Describe the two implemented planning research use cases and their real owner source models.', schema: emptySchema, invoke: async () => ({ demos: demos.list() }) })
    add({ id: 'planning.demo.start', output: createdSchema, kind: 'command', scope: 'workspace', title: 'Start Planning Demonstration', description: 'Create a real World Simulation Run from its published Scenario Definition, capture its qualified owner facts, and create a Planning Study with explicitly authored assumptions. Writes World and Planning; no timed executor.', schema: demoSchema, publishesStudy: true,
      invoke: async (_service, invocation, input) => { const study = await demos.start(invocation.workspaceId, input, invocation.access); return { study, resource: resourceFor(study.workspaceId, study.id) } } })
  }
  const registry = createModuleCapabilityRegistry(moduleId, registrations)
  const descriptorFor = (study: Study, available: boolean): ModuleResourceDescriptor => moduleResourceDescriptorSchema.parse({
    ref: resourceFor(study.workspaceId, study.id), title: available ? study.title : 'Unavailable planning Study',
    description: available ? 'Retained research inputs, candidate schedules and comparisons.' : 'Source qualification is unavailable; retained evidence is not published.',
    links: available && currentProblemRevision(study).basis ? [{ rel: 'source', ref: currentProblemRevision(study).basis!.source }] : [],
    uiPath: `/workspaces/${study.workspaceId}/planning?study=${study.id}`,
    capabilityIds: registry.idsForResourceType('planning.study'), inspectionCapabilityId: 'planning.study.inspect', deleteCapabilityId: 'planning.study.delete',
    summary: available ? [
      { key: 'status', label: 'Status', kind: 'status', value: 'Research Study' },
      { key: 'candidate-count', label: 'Candidates', kind: 'count', value: study.candidates.length },
      { key: 'updated-at', label: 'Updated', kind: 'timestamp', value: study.updatedAt },
    ] : [{ key: 'status', label: 'Status', kind: 'status', value: 'Source unavailable' }],
    observedAt: new Date().toISOString(),
  })
  return async (request: Request, url: URL): Promise<Response | null> => {
    try {
      if (url.pathname === '/.well-known/workspace-module' && request.method === 'GET') return json(planningModuleManifest)
      if (url.pathname === '/internal/featured-definitions' && request.method === 'GET') return json({ definitions: [], listed: [] })
      if (url.pathname === '/internal/activity' && request.method === 'GET') return json(moduleActivitySchema.parse({ workspaces: [] }))
      const match = url.pathname.match(/^\/internal\/workspaces\/([^/]+)(?:\/(definitions|resources|capabilities)|\/capabilities\/([^/]+)\/invoke)?$/)
      if (!match) return null
      const workspaceId = workspaceIdSchema.parse(decodeURIComponent(match[1] ?? ''))
      const collection = match[2], capabilityId = match[3] === undefined ? undefined : decodeURIComponent(match[3])
      if (!collection && !capabilityId) {
        if (request.method === 'PUT') {
          const input = z.object({ workspaceId: workspaceIdSchema }).strict().parse(await request.json())
          if (input.workspaceId !== workspaceId) throw planningError(409, 'workspace_scope_mismatch', 'Lifecycle body belongs to another Workspace')
          return json({ workspaceId, moduleId: 'planning' }, await config.service.store.provision(workspaceId) ? 201 : 200)
        }
        if (request.method === 'DELETE') { await config.service.store.removeWorkspace(workspaceId); return new Response(null, { status: 204 }) }
      }
      if (!await config.service.store.hasWorkspace(workspaceId)) throw planningError(404, 'workspace_not_found', 'Planning is not provisioned in this Workspace')
      if (collection === 'definitions' && request.method === 'GET') return json({ definitions: [] })
      if (collection === 'capabilities' && request.method === 'GET') return json({ capabilities: registry.descriptors })
      if (collection === 'resources' && request.method === 'GET') return json({ resources: (await config.service.list(workspaceId, catalogAccess(workspaceId))).map(({ study, available }) => descriptorFor(study, available)) })
      if (capabilityId && request.method === 'POST') {
        const invocation = moduleCapabilityInvocationSchema.parse(await request.json())
        if (invocation.workspaceId !== workspaceId || invocation.capabilityId !== capabilityId) throw planningError(409, 'capability_scope_mismatch', 'Invocation route and body disagree')
        const descriptor = registry.descriptors.find(descriptor => descriptor.id === capabilityId)
        if (!descriptor) throw planningError(404, 'capability_not_found', 'Planning Capability not found')
        if (descriptor.scope.kind === 'workspace' && (invocation.resource !== undefined || invocation.definition !== undefined)) throw planningError(400, 'capability_scope_mismatch', 'Workspace operations do not accept a Resource or Definition target')
        if (descriptor.scope.kind === 'resource') studyIdFor(invocation)
        if (invocation.idempotencyKey !== undefined) throw planningError(400, 'idempotency_not_supported', 'Planning commands do not accept keyed retries; inspect the Study after an uncertain result')
        const response = await registry.invoke(capabilityId, config.service, invocation)
        if (!response) throw planningError(404, 'capability_not_found', 'Planning Capability not found')
        return response
      }
      return null
    } catch (error) {
      if (isPlanningError(error)) return json({ error: { code: error.code, message: error.message, retryable: false, ...(error.details === undefined ? {} : { details: error.details }) } }, error.status)
      if (error instanceof z.ZodError) return json({ error: { code: 'invalid_request', message: 'Planning input does not match its declared schema', retryable: false, details: { issues: error.issues } } }, 400)
      if (error instanceof SyntaxError) return json({ error: { code: 'invalid_json', message: 'Request must contain valid JSON', retryable: false } }, 400)
      throw error
    }
  }
}
