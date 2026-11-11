// A real Host with the real Planning Module, and doubles for what lands in parallel lanes: World (lane W's
// facts query, with a journal of every call World receives), Agents (empty catalogues; its workspace tools
// run in-process against Host), and the solver and checker (lanes S and K).
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  moduleCapabilityInvocationSchema, moduleRegistrationSchema, planningFactsInputSchema, workspaceIdSchema,
  type ModuleCapabilityInvocation, type PlanningSubject, type WorkspaceRoomScope,
} from '@leitbild/contracts'
import { publishedInputSchema } from '../../../apps/planning/src/api/contract.ts'
import { createWorkspaceHost } from '../../../apps/leitbild/src/host.ts'
import { createModuleGateway } from '../../../apps/leitbild/src/module-gateway.ts'
import { createWorkspaceHostServer } from '../../../apps/leitbild/src/server.ts'
import { createWorkspaceStore } from '../../../apps/leitbild/src/store.ts'
import { createWorkspaceCapabilityTools } from '../../../apps/agents/src/tools/built-in/workspace-capability-tools.ts'
import { createPlanningServer } from '../../../apps/planning/src/server.ts'
import { createPlanningOperations } from '../../../apps/planning/src/api/operations.ts'
import { createPlanDefinitions } from '../../../apps/planning/src/definitions/index.ts'
import { createPlanStore } from '../../../apps/planning/src/plan/store.ts'
import { createPlanningHostClient } from '../../../apps/planning/src/host-client.ts'
import { planningFactsOutputSchema } from '@leitbild/contracts'
import { createCheckerDouble, createSolverDouble, createWorldDouble } from '../../../apps/planning/src/api/fixtures/doubles.ts'

/** Lane W's published descriptor, copied for the double; World's own replaces it at integration. */
export const planningFactsDescriptor = {
  id: 'world.simulation-run.planning-facts', moduleId: 'world',
  kind: 'query', scope: { kind: 'resource', resourceType: 'world.simulation-run' },
  title: 'Find equipment, crews and vehicles for a plan',
  description: 'Find the equipment, crews, vehicles and other items a simulation holds, with their current values, to use in a plan. Search by words or kind for a short list with live state, then ask for exact items, up to 32 read together, for all their values. Each value carries its unit, how it is known (design, configured, observed or the owner\'s estimate) and the simulation time it describes. Reading never pauses or changes the simulation. Simulations with roles are not read.',
  searchTerms: ['equipment', 'pump', 'crew', 'vehicle', 'truck', 'asset', 'find', 'availability', 'estimate', 'planning', 'state'],
  risk: 'read', idempotent: true,
  inputSchema: publishedInputSchema(planningFactsInputSchema), outputSchema: { type: 'object' },
} as const

const manifest = (id: string, title: string) => ({
  module: { id, title },
  endpoints: {
    workspace: '/internal/workspaces/{workspaceId}', definitions: '/internal/workspaces/{workspaceId}/definitions',
    resources: '/internal/workspaces/{workspaceId}/resources', capabilities: '/internal/workspaces/{workspaceId}/capabilities',
    invoke: '/internal/workspaces/{workspaceId}/capabilities/{capabilityId}/invoke',
    featuredDefinitions: '/internal/featured-definitions', activity: '/internal/activity',
  },
})

export interface WorldJournalEntry { readonly method: string; readonly path: string; readonly capabilityId?: string }

/** A Module double serving the lifecycle and catalogues; `invoke` answers its Capabilities. */
const serveModule = (config: {
  readonly id: string
  readonly title: string
  readonly resources: (workspaceId: string) => unknown[]
  readonly capabilities: unknown[]
  readonly invoke?: (capabilityId: string, invocation: ModuleCapabilityInvocation) => Promise<Response>
  readonly journal?: WorldJournalEntry[]
}) => Bun.serve({
  hostname: '127.0.0.1', port: 0,
  async fetch(request) {
    const url = new URL(request.url)
    config.journal?.push({ method: request.method, path: url.pathname })
    if (url.pathname === '/.well-known/workspace-module') return Response.json(manifest(config.id, config.title))
    if (url.pathname === '/internal/featured-definitions') return Response.json({ definitions: [], listed: [] })
    if (url.pathname === '/internal/activity') return Response.json({ workspaces: [] })
    const match = url.pathname.match(/^\/internal\/workspaces\/([^/]+)(?:\/(definitions|resources|capabilities)|\/capabilities\/([^/]+)\/invoke)?$/)
    if (!match) return new Response('Not found', { status: 404 })
    const [, workspaceId, collection, capabilityId] = match
    if (!collection && !capabilityId && request.method === 'PUT') return Response.json({ workspaceId, moduleId: config.id }, { status: 201 })
    if (!collection && !capabilityId && request.method === 'DELETE') return new Response(null, { status: 204 })
    if (collection === 'definitions') return Response.json({ definitions: [] })
    if (collection === 'resources') return Response.json({ resources: config.resources(workspaceId!) })
    if (collection === 'capabilities') return Response.json({ capabilities: config.capabilities })
    if (capabilityId !== undefined && config.invoke) {
      const invocation = moduleCapabilityInvocationSchema.parse(await request.json())
      config.journal?.splice(-1, 1, { method: request.method, path: url.pathname, capabilityId })
      return config.invoke(decodeURIComponent(capabilityId), invocation)
    }
    return new Response('Not found', { status: 404 })
  },
})

export const createPlanningStack = async (options: { readonly subjects: () => readonly PlanningSubject[] }) => {
  const cleanup: Array<() => Promise<void> | void> = []
  const planningHome = await mkdtemp(join(tmpdir(), 'planning-stack-'))
  cleanup.push(() => rm(planningHome, { recursive: true, force: true }))
  const runId = 'run-supply-1'
  const worldJournal: WorldJournalEntry[] = []
  const facts = createWorldDouble(options.subjects)
  const runResource = (workspaceId: string) => ({
    ref: { workspaceId, moduleId: 'world', type: 'world.simulation-run', id: runId }, title: 'Supply run',
    links: [], capabilityIds: [planningFactsDescriptor.id], summary: [], observedAt: new Date().toISOString(),
  })
  const words = (text: string) => text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)
  const world = serveModule({
    id: 'world', title: 'World', journal: worldJournal, resources: workspaceId => [runResource(workspaceId)], capabilities: [planningFactsDescriptor],
    invoke: async (capabilityId, invocation) => {
      if (capabilityId !== planningFactsDescriptor.id) return Response.json({ error: { code: 'capability_not_found', message: 'not here' } }, { status: 404 })
      const input = planningFactsInputSchema.parse(invocation.input)
      try {
        if (input.subjects === undefined) {
          // Search as lane W does: every asked word begins a word of the name; at most two observed state facts.
          const asked = words(input.text ?? '')
          const items = options.subjects().filter(subject => (input.kind === undefined || subject.kind === input.kind) && asked.every(word => words(subject.label).some(part => part.startsWith(word))))
            .slice(0, input.limit ?? 10).map(subject => ({ ...subject, facts: subject.facts.filter(fact => fact.basis === 'observed' && fact.quantity === 'state').slice(0, 2) }))
          return Response.json({ result: planningFactsOutputSchema.parse({ run: invocation.resource, observedAt: new Date().toISOString(), items }) })
        }
        return Response.json({ result: await facts.read(invocation.access, invocation.resource!, input) })
      } catch (error) {
        const refusal = error as { status?: number; code?: string; message: string; details?: unknown }
        return Response.json({ error: { code: refusal.code ?? 'internal', message: refusal.message, details: refusal.details } }, { status: refusal.status ?? 500 })
      }
    },
  })
  cleanup.push(() => world.stop(true))
  const agents = serveModule({ id: 'agents', title: 'Agents', resources: () => [], capabilities: [] })
  cleanup.push(() => agents.stop(true))

  let hostUrl = ''
  const store = createPlanStore(planningHome)
  const definitions = createPlanDefinitions()
  // Planning reads World through Host as in index.ts; Host's address is known once it listens.
  const operations = createPlanningOperations({
    store, definitions, solver: createSolverDouble(), checker: createCheckerDouble(),
    world: { read: async (access, run, input) => planningFactsOutputSchema.parse(await createPlanningHostClient({ hostUrl }).call(access, 'world.simulation-run.planning-facts', { resource: run, input })) },
  })
  const planning = createPlanningServer({ operations, definitions, store, port: 0, uiDistPath: planningHome })
  cleanup.push(() => planning.stop(true))

  const workspaceStore = createWorkspaceStore(':memory:')
  cleanup.push(() => workspaceStore.close())
  const registration = (moduleId: string, port: number | undefined) => moduleRegistrationSchema.parse({ moduleId, internalBaseUrl: `http://127.0.0.1:${port}`, manifestPath: '/.well-known/workspace-module' })
  const workspaceHost = createWorkspaceHost({ store: workspaceStore, modules: createModuleGateway({ registrations: [registration('world', world.port), registration('agents', agents.port), registration('planning', planning.port)] }) })
  const hostServer = createWorkspaceHostServer({ host: workspaceHost, bindHost: '127.0.0.1', port: 0 })
  cleanup.push(() => hostServer.stop(true))
  hostUrl = `http://127.0.0.1:${hostServer.port}`

  const created = await fetch(`${hostUrl}/api/workspaces`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Planning cycle' }) })
  const workspaceId = workspaceIdSchema.parse(((await created.json()) as { workspace: { id: string } }).workspace.id)
  const scopes = new Map<string, WorkspaceRoomScope>()
  const tools = createWorkspaceCapabilityTools({ workspaceId, hostBaseUrl: hostUrl, getRoomScope: roomId => scopes.get(roomId) })
  const tool = (name: string) => tools.find(entry => entry.name === name)!
  /** A Room with Workspace scope, as a new conversation would be. */
  const room = (roomId: string) => {
    scopes.set(roomId, { kind: 'workspace' })
    const context = { callerId: `assistant-${roomId}`, callerName: 'Assistant', roomId }
    return {
      explore: (params: Record<string, unknown>) => tool('workspace_explore').execute(params, context),
      call: (params: Record<string, unknown>) => tool('workspace_call').execute(params, context),
    }
  }
  return {
    hostUrl, workspaceId, runId, worldJournal, store, room,
    close: async () => { for (const step of cleanup.reverse()) await step() },
  }
}
