// The screen's only way to Planning and World: Host's Capability invoke route and Host's catalogues.
// Every answer is validated; a refusal keeps its code, status and details.
import { z } from 'zod'
import {
  inspectionViewSchema, planningFactsOutputSchema, platformErrorSchema, workspaceDefinitionCatalogSchema, workspaceResourceCatalogSchema,
  workspaceResourceReferenceSchema,
  type InspectionView, type ModuleDefinitionDescriptor, type PlanningFactsInput, type PlanningFactsOutput, type WorkspaceResourceReference,
} from '@leitbild/contracts'
import {
  explainResultSchema, generateResultSchema, writeResultSchema,
  type baselineInputSchema, type editInputSchema, type explainInputSchema, type generateInputSchema, type readInputSchema,
} from '../api/contract.ts'
import type { Edit } from '../plan/edit-schema.ts'

export type WriteResult = z.infer<typeof writeResultSchema>
export type GenerateResult = z.infer<typeof generateResultSchema>
export type ExplainResult = z.infer<typeof explainResultSchema>
export type EditInput = z.input<typeof editInputSchema>
export type GenerateInput = z.input<typeof generateInputSchema>
export type ExplainInput = z.input<typeof explainInputSchema>
export type ReadInput = z.input<typeof readInputSchema>
export type BaselineInput = z.input<typeof baselineInputSchema>

export const PLAN = 'planning.plan'
export const RUN = 'world.simulation-run'

export interface PlanningRequestError extends Error {
  readonly status: number
  readonly code: string | null
  readonly details: Readonly<Record<string, unknown>> | null
}

export const isRequestError = (error: unknown): error is PlanningRequestError =>
  error instanceof Error && 'status' in error && 'code' in error

const invocationSchema = <T extends z.ZodType>(result: T) => z.object({
  result,
  createdResources: z.array(workspaceResourceReferenceSchema).optional(),
}).strict()

type Transport = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export const createPlanningClient = (workspaceId: string, transport: Transport = (input, init) => fetch(input, init)) => {
  const base = `/api/workspaces/${encodeURIComponent(workspaceId)}`
  const request = async (path: string, init?: RequestInit): Promise<unknown> => {
    const response = await transport(path, init)
    const body: unknown = await response.json()
    if (!response.ok) {
      const refusal = platformErrorSchema.safeParse(body)
      throw Object.assign(new Error(refusal.success ? refusal.data.error.message : `The request failed (${response.status}).`), {
        status: response.status,
        code: refusal.success ? refusal.data.error.code : null,
        details: refusal.success ? refusal.data.error.details ?? null : null,
      }) satisfies PlanningRequestError
    }
    return body
  }
  const planRef = (id: string): WorkspaceResourceReference => workspaceResourceReferenceSchema.parse({ workspaceId, moduleId: 'planning', type: PLAN, id })
  const invoke = async <T extends z.ZodType>(capability: string, envelope: Record<string, unknown>, result: T, signal?: AbortSignal) =>
    invocationSchema(result).parse(await request(`${base}/capabilities/${encodeURIComponent(capability)}/invoke`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...envelope, actor: { kind: 'human' } }),
      ...(signal === undefined ? {} : { signal }),
    }))

  return {
    workspaceId,
    planRef,
    /** Plans and simulation Runs in this Workspace, from Host's resource catalogue. */
    catalog: async () => workspaceResourceCatalogSchema.parse(await request(`${base}/resources`)),
    /** Planning's Definitions (New plan and the two demonstrations), from Host's catalogue. */
    definitions: async () => workspaceDefinitionCatalogSchema.parse(await request(`${base}/definitions?moduleId=planning`)),
    create: (definition: ModuleDefinitionDescriptor, edits?: readonly Edit[]) => invoke('planning.plan.create', {
      definition: { ...definition.ref, revisionId: definition.currentRevisionId },
      input: edits === undefined ? {} : { edits },
    }, writeResultSchema),
    read: async (id: string, input: ReadInput): Promise<InspectionView> =>
      (await invoke('planning.plan.read', { resource: planRef(id), input }, inspectionViewSchema)).result,
    edit: async (id: string, expectedRevision: number, input: EditInput): Promise<WriteResult> =>
      (await invoke('planning.plan.edit', { resource: planRef(id), expectedRevision, input }, writeResultSchema)).result,
    generate: async (id: string, expectedRevision: number, input: GenerateInput, signal?: AbortSignal): Promise<GenerateResult> =>
      (await invoke('planning.plan.generate', { resource: planRef(id), expectedRevision, input }, generateResultSchema, signal)).result,
    explain: async (id: string, input: ExplainInput): Promise<ExplainResult> =>
      (await invoke('planning.plan.explain', { resource: planRef(id), input }, explainResultSchema)).result,
    baseline: async (id: string, expectedRevision: number, input: BaselineInput): Promise<WriteResult> =>
      (await invoke('planning.plan.baseline', { resource: planRef(id), expectedRevision, input }, writeResultSchema)).result,
    /** Copies the linked Run's current values into the plan. Workspace scope: the plan travels in the input. */
    refresh: async (id: string, expectedRevision: number): Promise<WriteResult> =>
      (await invoke('planning.sources.refresh', { expectedRevision, input: { plan: id } }, writeResultSchema)).result,
    /** World's read-only facts query on one Run. */
    facts: async (runId: string, input: PlanningFactsInput): Promise<PlanningFactsOutput> =>
      (await invoke('world.simulation-run.planning-facts', { resource: workspaceResourceReferenceSchema.parse({ workspaceId, moduleId: 'world', type: RUN, id: runId }), input }, planningFactsOutputSchema)).result,
  }
}
export type PlanningClient = ReturnType<typeof createPlanningClient>

/** A refusal in words for the screen; the Module's message is already in planner words. */
export const refusalText = (error: unknown): string => {
  if (isRequestError(error)) {
    if (error.code === 'plan_revision_conflict') return 'Someone else changed this plan a moment ago. It has been read again; check it and try once more.'
    if (error.code === 'planning_busy') return 'Planning is busy with other plans. Try again in a moment.'
    if (error.code === 'world_unavailable') return 'World did not answer. Try again in a moment.'
    return error.message
  }
  if (error instanceof DOMException && error.name === 'AbortError') return 'Cancelled.'
  return error instanceof Error ? error.message : 'Something went wrong.'
}
