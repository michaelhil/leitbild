// Test harness: the real Planning Module API over a temporary store, with the parallel lanes' doubles.
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newRequestId, workspaceIdSchema, type PlanningSubject, type WorkspaceId } from '@leitbild/contracts'
import { bundledPlanDefinitions, createPlanDefinitions } from '../../definitions/index.ts'
import { createPlanStore } from '../../plan/store.ts'
import { createPlanningModuleApi } from '../module-api.ts'
import { createPlanningOperations, type SolverPort } from '../operations.ts'
import { createSolverDouble, createWorldDouble } from './doubles.ts'

export interface Call {
  readonly resource?: string
  readonly definition?: string
  readonly input?: unknown
  readonly expectedRevision?: number
  readonly idempotencyKey?: string
  readonly actor?: 'human' | 'ai'
}
export interface Answer { readonly status: number; readonly body: any; readonly bytes: number }

export const createHarness = async (options: {
  readonly solver?: SolverPort
  readonly subjects?: () => readonly PlanningSubject[]
  readonly worldAnswerAfterMs?: number
  readonly refreshDeadlineMs?: number
} = {}) => {
  const root = await mkdtemp(join(tmpdir(), 'planning-api-'))
  const workspaceId: WorkspaceId = workspaceIdSchema.parse(crypto.randomUUID())
  const store = createPlanStore(root)
  const journal: Array<{ readonly capabilityId: string; readonly run: string; readonly input: unknown }> = []
  const definitions = createPlanDefinitions()
  const operations = createPlanningOperations({
    store, definitions,
    world: createWorldDouble(options.subjects ?? (() => []), journal, options.worldAnswerAfterMs === undefined ? {} : { answerAfterMs: options.worldAnswerAfterMs }),
    ...(options.refreshDeadlineMs === undefined ? {} : { refreshDeadlineMs: options.refreshDeadlineMs }),
    solver: options.solver ?? createSolverDouble(),
  })
  const handle = createPlanningModuleApi({ operations, definitions, store })
  const request = async (path: string, init?: RequestInit): Promise<Answer> => {
    const response = (await handle(new Request(`http://planning${path}`, init), new URL(`http://planning${path}`)))!
    const text = await response.text()
    return { status: response.status, body: text.length === 0 ? null : JSON.parse(text), bytes: new TextEncoder().encode(text).byteLength }
  }
  await request(`/internal/workspaces/${workspaceId}`, { method: 'PUT', body: JSON.stringify({ workspaceId }) })
  const definitionRef = (id: string) => {
    const found = bundledPlanDefinitions.find(entry => entry.id === id)!
    return { workspaceId, moduleId: 'planning', type: 'planning.plan-definition', id, revisionId: found.revisionId }
  }
  const call = (capabilityId: string, given: Call = {}): Promise<Answer> => request(`/internal/workspaces/${workspaceId}/capabilities/${capabilityId}/invoke`, {
    method: 'POST',
    body: JSON.stringify({
      workspaceId, capabilityId, input: given.input ?? {},
      ...(given.resource === undefined ? {} : { resource: { workspaceId, moduleId: 'planning', type: 'planning.plan', id: given.resource } }),
      ...(given.definition === undefined ? {} : { definition: definitionRef(given.definition) }),
      ...(given.expectedRevision === undefined ? {} : { expectedRevision: given.expectedRevision }),
      ...(given.idempotencyKey === undefined ? {} : { idempotencyKey: given.idempotencyKey }),
      access: { workspaceId, requestId: newRequestId(), actor: given.actor === 'ai' ? { kind: 'ai', id: 'assistant', displayName: 'Assistant' } : { kind: 'human', displayName: 'Planner' } },
    }),
  })
  /** Creates a plan from a bundled Definition and returns its id and revision. */
  const create = async (definition: string, input: unknown = {}) => {
    const answer = await call('planning.plan.create', { definition, input })
    if (answer.status !== 201) throw new Error(`create failed: ${JSON.stringify(answer.body)}`)
    return { id: answer.body.result.plan.id as string, revision: answer.body.result.plan.revision as number, answer }
  }
  return {
    workspaceId, store, journal, request, call, create, operations,
    close: () => rm(root, { recursive: true, force: true }),
  }
}
export type Harness = Awaited<ReturnType<typeof createHarness>>
