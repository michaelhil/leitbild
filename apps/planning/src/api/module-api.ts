// Planning's Module API behind Host: the manifest, Workspace lifecycle, the three Definitions, the plan
// Resources and the eight Planning operations (the ninth, the World facts query, is World's). Inputs are
// validated with the exact schemas; what is published is stripForPublication(exact).
import { z } from 'zod'
import {
  inspectionViewSchema, moduleActivitySchema, moduleCapabilityInvocationSchema, moduleIdSchema, moduleResourceDescriptorSchema,
  workspaceIdSchema, workspaceModuleManifestSchema,
  type ModuleCapabilityInvocation, type ModuleResourceDescriptor, type WorkspaceId,
} from '@leitbild/contracts'
import { createModuleCapabilityRegistry, type CapabilityRegistration } from '@leitbild/module-runtime'
import { isPlanningError, planningError } from '../errors.ts'
import { expectedFor } from '../plan/edits.ts'
import type { PlanStore, PlanSummary } from '../plan/store.ts'
import type { Edit } from '../plan/edit-schema.ts'
import { definitionDescriptors, planDefinitionType } from '../definitions/index.ts'
import {
  baselineInputSchema, createInputSchema, deleteInputSchema, editInputSchema, explainInputSchema, explainResultSchema,
  generateInputSchema, generateResultSchema, publishedInputSchema, readInputSchema, refreshInputSchema, writeResultSchema,
} from './contract.ts'
import { planReference, type PlanningOperations } from './operations.ts'
import type { PlanDefinitionsPort } from '../definitions/index.ts'

export const planningModuleManifest = workspaceModuleManifestSchema.parse({
  module: { id: 'planning', title: 'Planning', description: 'Plans for maintenance and response work: jobs, crews, calendars and hard rules, schedules that keep them, and why each job starts when it does.' },
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

const moduleId = moduleIdSchema.parse('planning')
const planType = 'planning.plan'
/** Codes a caller may retry as they are. */
// solver_busy: Planning runs one Generate at a time across the service, and nothing is queued (lane S).
const retryable = new Set(['world_unavailable', 'planning_busy', 'solver_busy'])
const deletedSchema = z.object({ deleted: z.literal(true) }).strict()

export interface PlanningCallContext {
  readonly operations: PlanningOperations
  /** The caller's request; its abort (forwarded by Host) stops a running Generate. */
  readonly signal: AbortSignal
}

interface Operation<T> {
  readonly id: string
  readonly kind: 'command' | 'query'
  readonly scope: 'workspace' | 'plan' | 'definition'
  readonly risk: 'read' | 'write' | 'destructive'
  readonly title: string
  readonly description: string
  readonly searchTerms: readonly string[]
  readonly input: z.ZodType<T>
  readonly output: z.ZodType
  readonly invoke: (context: PlanningCallContext, invocation: ModuleCapabilityInvocation, input: T) => Promise<{ readonly result: unknown; readonly created?: unknown }>
}

const planIdOf = (invocation: ModuleCapabilityInvocation): string => {
  const resource = invocation.resource
  if (resource === undefined || resource.type !== planType || resource.moduleId !== 'planning') throw planningError(400, 'capability_scope_mismatch', 'Name the plan this operation works on')
  return resource.id
}

// Descriptions are planner words, 300–700 characters. They never name the old research vocabulary.
export const planningOperations: ReadonlyArray<Operation<any>> = [
  {
    id: 'planning.plan.create', kind: 'command', scope: 'definition', risk: 'write',
    title: 'Create a plan',
    description: 'Start a new plan from a template: a blank plan, the Train A work week or the Supply run. The new plan is not linked to a simulation yet; its first card says which World simulation to start and then link. Optional edits, in the same words as changing a plan, are applied as it is made: equipment, crews, shift calendars, jobs, links, rules and goals. Creating a plan never changes the World.',
    searchTerms: ['new', 'blank', 'empty', 'template', 'example', 'demo', 'start', 'outage', 'maintenance', 'work week'],
    input: createInputSchema, output: writeResultSchema,
    invoke: async ({ operations }, invocation, input: z.infer<typeof createInputSchema>) => {
      const definition = invocation.definition!
      const { result, created } = await operations.create(invocation.workspaceId, { id: definition.id, revisionId: definition.revisionId }, input, invocation.access)
      return { result, created }
    },
  },
  {
    id: 'planning.plan.edit', kind: 'command', scope: 'plan', risk: 'write',
    title: 'Change a plan',
    description: 'Change a plan with named edits: add, change or remove a job and its estimate, crew, equipment, link, shift calendar, purchase such as overtime, method choice, rule or goal order, or lock a job to a start time. A field you give replaces that field; null clears it. All edits apply together or not at all. With preview nothing is saved: you see what moves and which rule breaks. Removing or weakening a hard rule, a support, a precondition or a test minimum is a person\'s change: an Assistant is refused and asks a person to make it in the plan screen. Needs the plan\'s current revision.',
    searchTerms: ['job', 'activity', 'crew', 'shift', 'calendar', 'buy', 'scope', 'supported by', 'tag-out', 'link', 'FS', 'SS', 'FF', 'lag', 'protected', 'off limits', 'keep in service', 'at least one', 'available', 'finish on or before', 'data date', 'simulation run', 'schedule'],
    input: editInputSchema, output: writeResultSchema,
    invoke: async ({ operations, signal }, invocation, input: z.infer<typeof editInputSchema>) => ({ result: await operations.edit(invocation.workspaceId, planIdOf(invocation), input, invocation.expectedRevision, invocation.access, signal) }),
  },
  {
    id: 'planning.plan.generate', kind: 'command', scope: 'plan', risk: 'write',
    title: 'Generate schedule options',
    description: 'Work out schedules that keep every hard rule: links, shifts, crew and tool limits, outage limits, protection and locks. Ranks them by the plan\'s goals and says for each whether it is validated feasible, proven infeasible with its cause, or unresolved. What-ifs leave the plan as it is: fix a method, allow or forbid purchases, add one extra rule such as at most 48 h out, or solve a goal or a group\'s outage first. With keep they join the options there: the same what-if replaces itself, and of at most 8 options the new ones stay, then the plan\'s own, then earlier what-ifs; without keep none stay. While another plan generates it answers solver_busy. Needs the plan\'s current revision.',
    searchTerms: ['optimise', 'alternatives', 'what-if', 'replan', 'reschedule', 'level', 'levelling', 'fit', 'window', 'variants', 'compress', 'overtime'],
    input: generateInputSchema, output: generateResultSchema,
    invoke: async ({ operations, signal }, invocation, input: z.infer<typeof generateInputSchema>) => ({ result: await operations.generate(invocation.workspaceId, planIdOf(invocation), input, invocation.expectedRevision, invocation.access, signal) }),
  },
  {
    id: 'planning.plan.explain', kind: 'query', scope: 'plan', risk: 'read',
    title: 'Explain start, finish or refusal',
    description: 'Explain a schedule: why a job starts when it does, what holds up the finish, or why a plan was refused, with the solver\'s own reasons (a link, a crew or tool, a shift, an outage limit, the window) and each job\'s float. Also why the recommended option ranks first: the goal order, the goal that decided, the trade in hours and money, and the method caveats the ranking leaves out; and what differs from an option of the previous options, kept when the plan changed. Asks about the recommended option unless another is named. Reads only; nothing is saved.',
    searchTerms: ['why', 'late', 'critical path', 'longest path', 'driving', 'completion', 'limits', 'float', 'slack', 'held up', 'refused', 'impossible', 'why not earlier'],
    input: explainInputSchema, output: explainResultSchema,
    invoke: async ({ operations }, invocation, input: z.infer<typeof explainInputSchema>) => ({ result: await operations.explain(invocation.workspaceId, planIdOf(invocation), input) }),
  },
  {
    id: 'planning.plan.read', kind: 'query', scope: 'plan', risk: 'read',
    title: 'Read a plan',
    description: 'See where a plan stands: settings, goals, what needs attention, when World values were read, and the certified plan size. Or one section: jobs, links and methods, rules, calendars, crews, tools and purchases, equipment and World values, the options or the previous ones, an option\'s schedule, the change history, or what overtime buys. Each option keeps the status Generate gave it: a status with fresh false, and the recommended option when its own is not fresh, describe the plan before a later change, not the plan as it is now; generate again. Long sections come in pages. Reads only.',
    searchTerms: ['status', 'overview', 'attention', 'summary', 'rules', 'crews', 'schedule', 'history'],
    input: readInputSchema, output: inspectionViewSchema,
    invoke: async ({ operations }, invocation, input: z.infer<typeof readInputSchema>) => ({ result: await operations.read(invocation.workspaceId, planIdOf(invocation), input) }),
  },
  {
    id: 'planning.plan.baseline', kind: 'command', scope: 'plan', risk: 'write',
    title: 'Commit a baseline',
    description: 'Make one option the plan\'s baseline: the schedule you commit to and compare later changes with, frozen with the plan as it was. Only an option that is validated feasible on the plan as it stands now can become the baseline; one that is out of date is refused, so generate again first. Earlier baselines are kept with their names and notes, up to 8 per plan. The plan\'s inputs do not change. Needs the plan\'s current revision.',
    searchTerms: ['baseline', 'commit', 'freeze', 'approve', 'choose', 'target'],
    input: baselineInputSchema, output: writeResultSchema,
    invoke: async ({ operations }, invocation, input: z.infer<typeof baselineInputSchema>) => ({ result: await operations.baseline(invocation.workspaceId, planIdOf(invocation), input, invocation.expectedRevision, invocation.access) }),
  },
  {
    id: 'planning.sources.refresh', kind: 'command', scope: 'workspace', risk: 'write',
    title: 'Refresh World values',
    description: 'Read again, from the linked World simulation, every value this plan uses: equipment state, durations, arrival times and payloads, each with how it is known and the simulation time it describes. Shows which values changed, which options are now out of date, and preconditions that are not met at read time. Values you entered yourself are never changed, and reading never pauses or changes the simulation. Needs the plan\'s current revision.',
    searchTerms: ['refresh', 'update', 'latest', 'World', 'changed', 'reread', 'sync'],
    input: refreshInputSchema, output: writeResultSchema,
    invoke: async ({ operations, signal }, invocation, input: z.infer<typeof refreshInputSchema>) => ({ result: await operations.refresh(invocation.workspaceId, input.plan, invocation.expectedRevision, invocation.access, signal) }),
  },
  {
    id: 'planning.plan.delete', kind: 'command', scope: 'plan', risk: 'destructive',
    title: 'Delete a plan',
    description: 'Delete this plan with its options, baselines and change history. This cannot be undone. The World simulation the plan was linked to, and everything else in the Workspace, is not touched. Read the plan first and pass its current revision as the expected revision: the delete is refused if someone changed the plan since you read it, and an Assistant\'s delete without one is refused.',
    searchTerms: ['delete', 'remove', 'get rid of', 'discard', 'scrap', 'throw away'],
    input: deleteInputSchema, output: deletedSchema,
    invoke: async ({ operations }, invocation) => ({ result: await operations.delete(invocation.workspaceId, planIdOf(invocation), invocation.expectedRevision, invocation.access) }),
  },
]

const operationById = new Map(planningOperations.map(operation => [operation.id, operation]))

const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } })

/** The refusal of a malformed input: the failing field's sub-schema and the kind's field names for edits, else the input schema. */
const invalidInput = (operation: Operation<unknown>, input: unknown, error: z.ZodError) => {
  const issue = error.issues[0]!
  const path = issue.path.map(String)
  const editAt = path[0] === 'edits' && path[1] !== undefined ? Number(path[1]) : undefined
  const edit = editAt === undefined ? undefined : (input as { edits?: Array<Partial<Edit>> } | null)?.edits?.[editAt]
  const expected = editAt !== undefined
    ? { ...expectedFor(typeof edit?.edit === 'string' ? edit.edit : undefined, path[2]), edit: editAt }
    : publishedInputSchema(operation.input)
  return planningError(400, 'invalid_request', `${issue.message}${path.length === 0 ? '' : ` at ${path.join('.')}`}`, {
    issues: error.issues.slice(0, 4).map(entry => ({ path: entry.path.map(String), message: entry.message })),
    expected,
  })
}

const registrationFor = (operation: Operation<unknown>): CapabilityRegistration<PlanningCallContext, Response> => ({
  descriptor: {
    id: operation.id, moduleId, kind: operation.kind,
    scope: operation.scope === 'workspace' ? { kind: 'workspace' }
      : operation.scope === 'definition' ? { kind: 'definition', definitionType: planDefinitionType }
        : { kind: 'resource', resourceType: planType },
    title: operation.title, description: operation.description, searchTerms: [...operation.searchTerms],
    risk: operation.risk, idempotent: operation.kind === 'query',
    inputSchema: publishedInputSchema(operation.input),
    outputSchema: z.toJSONSchema(operation.output, { unrepresentable: 'any' }) as Record<string, unknown>,
  },
  invoke: async (context, invocation) => {
    const parsed = operation.input.safeParse(invocation.input)
    if (!parsed.success) throw invalidInput(operation, invocation.input, parsed.error)
    const { result, created } = await operation.invoke(context, invocation, parsed.data)
    return json({ result, ...(created === undefined ? {} : { createdResources: [created] }) }, created === undefined ? 200 : 201)
  },
})

const statusLabel = (plan: PlanSummary): string => {
  if (plan.optionCount === 0) return plan.linked ? 'No schedule yet' : 'Not linked yet'
  return plan.optionsOutOfDate ? 'Options out of date' : 'Options ready'
}

export const createPlanningModuleApi = (config: {
  readonly operations: PlanningOperations
  readonly definitions: PlanDefinitionsPort
  readonly store: Pick<PlanStore, 'hasWorkspace' | 'provision' | 'removeWorkspace'>
}) => {
  const registry = createModuleCapabilityRegistry<PlanningCallContext, Response>(moduleId, planningOperations.map(registrationFor))
  const planCapabilities = registry.idsForResourceType(planType)
  const definitionCapabilities = registry.idsForDefinitionType(planDefinitionType)

  const resourcesFor = async (workspaceId: WorkspaceId): Promise<ModuleResourceDescriptor[]> => {
    const { plans, damaged } = await config.operations.list(workspaceId)
    const observedAt = new Date().toISOString()
    return [
      ...plans.map(plan => moduleResourceDescriptorSchema.parse({
        ref: planReference(workspaceId, plan.id), title: plan.title,
        ...(plan.purpose === undefined ? {} : { description: plan.purpose }),
        uiPath: `/workspaces/${workspaceId}/planning?plan=${plan.id}`,
        capabilityIds: planCapabilities, inspectionCapabilityId: 'planning.plan.read', deleteCapabilityId: 'planning.plan.delete',
        summary: [
          { key: 'status', label: 'Status', kind: 'status', value: statusLabel(plan) },
          { key: 'option-count', label: 'Options', kind: 'count', value: plan.optionCount },
          { key: 'updated-at', label: 'Updated', kind: 'timestamp', value: plan.updatedAt },
        ],
        observedAt,
      })),
      ...damaged.map(({ id }) => moduleResourceDescriptorSchema.parse({
        ref: planReference(workspaceId, id), title: 'Damaged plan',
        // No delete card: after a rollback a newer plan reads as damaged, and deleting it would lose it.
        description: 'This plan file could not be read; do not delete it, report it.',
        capabilityIds: [],
        summary: [{ key: 'status', label: 'Status', kind: 'status', value: 'Damaged' }],
        observedAt,
      })),
    ]
  }

  return async (request: Request, url: URL): Promise<Response | null> => {
    try {
      if (url.pathname === '/.well-known/workspace-module' && request.method === 'GET') return json(planningModuleManifest)
      // Featured Definitions stay empty: Host launches plan Definitions only through their primary Capability.
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
          return json({ workspaceId, moduleId: 'planning' }, await config.store.provision(workspaceId) ? 201 : 200)
        }
        if (request.method === 'DELETE') { await config.store.removeWorkspace(workspaceId); return new Response(null, { status: 204 }) }
      }
      if (!await config.store.hasWorkspace(workspaceId)) throw planningError(404, 'workspace_not_found', 'Planning is not provisioned in this Workspace')
      if (collection === 'definitions' && request.method === 'GET') return json({ definitions: definitionDescriptors(workspaceId, config.definitions, definitionCapabilities) })
      if (collection === 'capabilities' && request.method === 'GET') return json({ capabilities: registry.descriptors })
      if (collection === 'resources' && request.method === 'GET') return json({ resources: await resourcesFor(workspaceId) })
      if (capabilityId && request.method === 'POST') {
        const invocation = moduleCapabilityInvocationSchema.parse(await request.json())
        if (invocation.workspaceId !== workspaceId || invocation.capabilityId !== capabilityId) throw planningError(409, 'capability_scope_mismatch', 'Invocation route and body disagree')
        const operation = operationById.get(capabilityId)
        if (operation === undefined) throw planningError(404, 'capability_not_found', 'Planning Capability not found')
        if (operation.scope === 'workspace' && (invocation.resource !== undefined || invocation.definition !== undefined)) throw planningError(400, 'capability_scope_mismatch', 'Workspace operations take no Resource or Definition target')
        if (operation.scope === 'plan') planIdOf(invocation)
        if (operation.scope === 'definition' && (invocation.definition === undefined || invocation.definition.type !== planDefinitionType || invocation.definition.moduleId !== 'planning')) {
          throw planningError(400, 'capability_scope_mismatch', 'Name the plan Definition to start from')
        }
        if (invocation.idempotencyKey !== undefined) throw planningError(400, 'idempotency_not_supported', 'Planning commands take no retry key; read the plan after an uncertain result')
        const response = await registry.invoke(capabilityId, { operations: config.operations, signal: request.signal }, invocation)
        if (!response) throw planningError(404, 'capability_not_found', 'Planning Capability not found')
        return response
      }
      return null
    } catch (error) {
      if (isPlanningError(error)) return json({ error: { code: error.code, message: error.message, retryable: retryable.has(error.code), ...(error.details === undefined ? {} : { details: error.details }) } }, error.status)
      if (error instanceof z.ZodError) return json({ error: { code: 'invalid_request', message: 'The request does not match its declared schema', retryable: false, details: { issues: error.issues.slice(0, 4).map(entry => ({ path: entry.path.map(String), message: entry.message })) } } }, 400)
      if (error instanceof SyntaxError) return json({ error: { code: 'invalid_json', message: 'Request must contain valid JSON', retryable: false } }, 400)
      throw error
    }
  }
}
