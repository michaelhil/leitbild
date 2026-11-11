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
    create: (definition: ModuleDefinitionDescriptor, edits?: readonly Edit[], grid?: '30min' | '30s') => invoke('planning.plan.create', {
      definition: { ...definition.ref, revisionId: definition.currentRevisionId },
      input: { ...(edits === undefined ? {} : { edits }), ...(grid === undefined ? {} : { grid }) },
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

/** The words that ask for a named person's agreement, as the Module asks them. */
export const authorityWords = 'Name the person who agreed and their reason. Ask them; never fill this in yourself.'

/** What lifts a refusal: the Module's request for a named person's agreement, or null when nothing can. */
export const refusalAuthority = (error: PlanningRequestError): string | null => {
  const authority = error.details?.authority
  if (authority !== null && typeof authority === 'object' && (authority as { needed?: unknown }).needed === true) {
    const ask = (authority as { ask?: unknown }).ask
    return typeof ask === 'string' ? ask : authorityWords
  }
  return error.code === 'needs_authority' || error.code === 'below_minimum' ? authorityWords : null
}

/** The nearest allowed time a refusal names, if any. */
export const refusalNearest = (error: PlanningRequestError): string | null =>
  typeof error.details?.nearestAllowed === 'string' ? error.details.nearestAllowed : null

/** Where a refusal's details name plan keys, the screen says their names. */
export type KeyNames = (key: string) => string

const keysIn = (details: Readonly<Record<string, unknown>> | null, field: string): readonly string[] => {
  const value = details?.[field]
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []
}
const listOf = (keys: readonly string[], name: KeyNames): string =>
  keys.length <= 1 ? keys.map(name).join('') : `${keys.slice(0, -1).map(name).join(', ')} and ${name(keys[keys.length - 1]!)}`

/**
 * A refusal in planner words for the screen, generated from its code and details. The Module's own
 * message is written for the Assistant and may name keys, so the screen uses it only for refusals whose
 * words carry no keys (the certified size, a damaged plan).
 */
export const refusalText = (error: unknown, name: KeyNames = () => 'an item in this plan'): string => {
  if (isRequestError(error)) {
    const about = keysIn(error.details, 'about')
    // The Module states the broken rule in planner words, and what lifts it, as structured fields.
    const rule = typeof error.details?.rule === 'string' ? error.details.rule.replace(/\.?\s*$/, '.') : null
    if (rule !== null) return refusalAuthority(error) === null ? rule : `${rule} ${refusalAuthority(error)}`
    switch (error.code) {
      case 'plan_revision_conflict': return 'Someone else changed this plan a moment ago. It has been read again; check it and try once more.'
      case 'planning_busy': return 'Planning is busy with other plans. Try again in a moment.'
      case 'world_unavailable': return 'World did not answer in time; nothing was saved. Try again in a moment.'
      case 'generate_running': return 'Generate is already working on this plan. Wait for it to finish; its options then appear here.'
      case 'baseline_limit': return 'This plan already keeps as many baselines as a plan may keep, so no more can be saved.'
      case 'plan_too_large': return 'This change would make the plan larger than a plan may hold. Nothing was saved; remove what the plan does not need.'
      case 'world_read_limit': return 'This plan names more World items than can be read together (at most 32). Remove the items the plan does not need; nothing was read.'
      case 'below_minimum': return `${about.length === 0 ? 'A test' : listOf(about.slice(0, 1), name)} would run shorter than its declared minimum. ${authorityWords}`
      case 'needs_authority': {
        const weakens = keysIn(error.details, 'weakens')
        return `This weakens a hard rule's coverage${weakens.length > 0 ? ` (${listOf(weakens, name)})` : about.length > 0 ? ` (${listOf(about, name)})` : ''}. ${authorityWords}`
      }
      case 'protected_equipment': {
        const [job, item, rule] = about
        return job !== undefined && item !== undefined && rule !== undefined
          ? `${name(job)} would touch ${name(item)}, which “${name(rule)}” protects. No job may touch it.`
          : 'This change would touch protected equipment. No job may touch it.'
      }
      case 'option_stale': return 'This option no longer matches the plan. Generate again.'
      case 'option_not_feasible': return 'Only a validated feasible option on the current plan can become the baseline.'
      case 'unknown_reference': return 'Something this change names is no longer in the plan. Read the plan again and retry.'
      case 'invalid_request': {
        const issues = Array.isArray(error.details?.issues) ? (error.details.issues as Array<{ message?: unknown }>).flatMap(issue => typeof issue.message === 'string' ? [issue.message] : []) : []
        return issues.length > 0 ? `This change is not valid: ${issues.join('; ')}.` : 'This change is not valid for this plan.'
      }
      case 'plan_not_found': return 'This plan is no longer in this Workspace.'
      default: return error.message
    }
  }
  if (error instanceof DOMException && error.name === 'AbortError') return 'Cancelled.'
  return error instanceof Error ? error.message : 'Something went wrong.'
}
