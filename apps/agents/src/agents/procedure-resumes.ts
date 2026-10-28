/** Resume an explicitly delegated procedure after its human-input answer or hand back.
 * World owns procedure state and authority. Agents retains only the exact successful
 * invocation's Room and Resource while this runtime lives; no binding or second procedure store.
 */
import { z } from 'zod'
import { workspaceResourceReferenceSchema, type WorkspaceId, type WorkspaceResourceReference } from '@leitbild/contracts'
import type { ExecutionCall, ExecutionStore } from '../core/executions/store.ts'
import type { RoomDirectory } from '../core/rooms/directory.ts'
import type { AIAgent, Team } from '../core/types/agent.ts'
import { PROCEDURE_RUNNER_SKILL } from '../core/proposal-resume.ts'
import { asAIAgent } from './shared.ts'

const readOperation = 'world.procedure.run.step.read'
const waitOperation = 'world.simulation-run.wait'
const viewSchema = z.object({ sequence: z.number().int().nonnegative(), run: z.object({
  runId: z.string(), procedureId: z.string(), status: z.string(), currentStepId: z.string().optional(),
  driver: z.object({ kind: z.enum(['ai', 'person']), actorId: z.string() }).optional(),
  inputRequest: z.object({ requestId: z.string(), stepId: z.string() }).optional(),
}) })
export type ProcedureResumeView = z.infer<typeof viewSchema>
const waitSchema = z.object({ sequence: z.number(), events: z.array(z.object({
  type: z.string(), seq: z.number(), runId: z.string().optional(), changedBy: z.string().optional(),
  selectedBy: z.string().optional(), closedBy: z.string().optional(), status: z.string().optional(), driver: z.object({ kind: z.string(), actorId: z.string() }).optional(),
})).optional(), next: viewSchema.optional() })
export type ProcedureResumeChange = z.infer<typeof waitSchema>
interface Candidate {
  resource: WorkspaceResourceReference
  runId: string
  ownerId?: string
  sequence?: number
  requestId?: string
  stepId?: string
  released?: true
}
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** Successful receipts, not model prose, establish what this turn delegated and where. */
export const procedureDelegationsOf = (calls: ReadonlyArray<ExecutionCall>): ReadonlyArray<Candidate> => {
  const candidates = new Map<string, Candidate>()
  const readSequences = new Map<string, number>()
  for (const call of calls) {
    if (call.tool !== 'workspace_call' || call.result?.success !== true || !record(call.arguments) || !Array.isArray(call.arguments.calls)
      || !record(call.result.data) || !Array.isArray(call.result.data.results)) continue
    for (const entry of call.result.data.results) {
      if (!record(entry) || entry.success !== true || typeof entry.operationId !== 'string' || !record(entry.data)) continue
      const target = record(entry.target) && entry.target.kind === 'resource' ? workspaceResourceReferenceSchema.safeParse(entry.target.ref) : undefined
      if (!target?.success) continue
      const arg = call.arguments.calls.find(value => record(value) && value.key === entry.key)
      const input = record(arg) && record(arg.input) ? arg.input : {}
      const view = viewSchema.safeParse(entry.data.next ?? entry.data)
      const runId = view.success ? view.data.run.runId : typeof input.runId === 'string' ? input.runId : undefined
      if (!runId) continue
      const key = JSON.stringify([target.data, runId])
      const previous = candidates.get(key)
      const beforeSequence = previous?.sequence ?? readSequences.get(key)
      if (view.success) readSequences.set(key, view.data.sequence)
      // An accepted start/transition supplies a World-owned driver proof. A
      // successful implicit step read also proves the caller drives that Run.
      const command = entry.data.ok === true && typeof entry.data.commandId === 'string'
      const delegated = command && ['world.procedure.run.start', 'world.procedure.run.transition', 'world.procedure.run.drive', 'world.procedure.run.request-input'].includes(entry.operationId)
      if (!delegated && !previous) continue
      if (entry.operationId === 'world.procedure.run.drive' && input.action === 'release') { candidates.set(key, { resource: target.data, runId, released: true }); continue }
      const ownerProof = view.success && view.data.run.driver?.kind === 'ai'
        && (command || (entry.operationId === readOperation && input.runId === undefined)) ? view.data.run.driver.actorId : previous?.ownerId
      const { released: _released, requestId: _request, stepId: _step, ...activePrevious } = previous ?? {}
      const pending = view.success ? view.data.run.inputRequest : previous
      candidates.set(key, { ...activePrevious, resource: target.data, runId,
        ...(ownerProof === undefined ? {} : { ownerId: ownerProof }),
        ...(view.success ? { sequence: entry.operationId === 'world.procedure.run.request-input'
          && view.data.run.inputRequest?.requestId !== entry.data.commandId && beforeSequence !== undefined
            ? beforeSequence : view.data.sequence } : {}),
        ...(pending?.requestId === undefined ? {} : { requestId: pending.requestId, stepId: pending.stepId }),
        ...(entry.operationId === 'world.procedure.run.request-input' && command
          ? { requestId: entry.data.commandId as string, stepId: input.stepId as string } : {}),
      })
    }
  }
  return [...candidates.values()]
}

export interface ProcedureResumeReader {
  read: (resource: WorkspaceResourceReference, runId: string | undefined, agent: AIAgent, signal: AbortSignal) => Promise<ProcedureResumeView>
  wait: (resource: WorkspaceResourceReference, runId: string, sequence: number, agent: AIAgent, signal: AbortSignal) => Promise<ProcedureResumeChange>
}
export const createProcedureResumeReader = (deps: { workspaceId: WorkspaceId; hostBaseUrl: string; fetchImpl?: typeof fetch }): ProcedureResumeReader => {
  const invoke = async (operation: string, resource: WorkspaceResourceReference, input: unknown, agent: AIAgent, signal: AbortSignal): Promise<unknown> => {
    const response = await (deps.fetchImpl ?? fetch)(`${new URL(deps.hostBaseUrl).origin}/api/workspaces/${encodeURIComponent(deps.workspaceId)}/capabilities/${encodeURIComponent(operation)}/invoke`, {
      method: 'POST', signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]), headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resource, input, actor: { kind: 'ai', id: agent.id, displayName: agent.name } }),
    })
    const body = await response.json() as { result?: unknown; error?: { message?: string } }
    if (!response.ok) throw new Error(body.error?.message ?? `Procedure continuation read refused: HTTP ${response.status}`)
    return body.result
  }
  return {
    read: async (resource, runId, agent, signal) => viewSchema.parse(await invoke(readOperation, resource, runId === undefined ? {} : { runId }, agent, signal)),
    wait: async (resource, runId, sequence, agent, signal) => waitSchema.parse(await invoke(waitOperation, resource, {
      afterSequence: sequence, procedureRunId: runId, events: [
        { type: 'procedure.branch.selected', procedureRunId: runId },
        { type: 'procedure.run.driver.changed', procedureRunId: runId },
        { type: 'procedure.run.closed', procedureRunId: runId },
        { type: 'procedure.run.reset' },
      ],
    }, agent, signal)),
  }
}
/** Wait for actual queued work to drain, cancelled with this watch; no procedure lifetime timeout. */
const idleForResume = async (ai: AIAgent, signal: AbortSignal): Promise<void> => await new Promise((resolve, reject) => {
  let unsubscribe = (): void => {}
  const cleanup = (): void => { unsubscribe(); signal.removeEventListener('abort', aborted) }
  const aborted = (): void => { cleanup(); reject(signal.reason) }
  const check = (): void => { if (ai.state.get() === 'idle' && !ai.hasQueuedTurn()) { cleanup(); resolve() } }
  unsubscribe = ai.state.subscribe(check)
  signal.addEventListener('abort', aborted, { once: true })
  if (signal.aborted) aborted(); else check()
})

interface Watch extends Candidate {
  key: string
  readonly roomId: string
  readonly scopeRevision: number
  readonly agentId: string
  readonly answerId: string
  readonly abort: AbortController
}
export const createProcedureResumes = (deps: {
  rooms: Pick<RoomDirectory, 'getRoom'>
  team: Pick<Team, 'getAgent'>
  executions: Pick<ExecutionStore, 'getTurn' | 'listCalls' | 'getCall'>
  reader: ProcedureResumeReader
}) => {
  const watches = new Map<string, Watch>()
  let disposed = false
  const end = (watch: Watch): void => { if (watches.get(watch.key) === watch) watches.delete(watch.key); watch.abort.abort() }
  const eligible = (watch: Watch): AIAgent | undefined => {
    const room = deps.rooms.getRoom(watch.roomId), agent = deps.team.getAgent(watch.agentId)
    const ai = agent && asAIAgent(agent)
    return !disposed && watches.get(watch.key) === watch && room && room.profile.scopeRevision === watch.scopeRevision
      && room.hasMember(watch.agentId) && !room.isMuted(watch.agentId) && room.deliveryMode !== 'manual'
      && ai?.requestTurn && ai.getSkills().includes(PROCEDURE_RUNNER_SKILL) ? ai : undefined
  }
  const follow = async (watch: Watch): Promise<void> => {
    let requestId = watch.requestId, cursor = watch.sequence
    try {
      let ai = eligible(watch)
      if (!ai) return
      // Without a receipt's driver proof, World's implicit selector proves
      // this caller drives the exact Run; ambiguity is a visible stop.
      if (!watch.ownerId) {
        const owned = await deps.reader.read(watch.resource, undefined, ai, watch.abort.signal)
        if (owned.run.runId !== watch.runId || owned.run.driver?.kind !== 'ai') return
        watch.ownerId = owned.run.driver.actorId
      }
      let changed: ProcedureResumeChange | undefined
      let ready: 'answered' | 'released' | undefined
      for (;;) {
        ai = eligible(watch)
        if (!ai) return
        const view: ProcedureResumeView = changed?.next ?? await deps.reader.read(watch.resource, watch.runId, ai, watch.abort.signal)
        if (view.run.runId !== watch.runId) {
          // World follows a transferred Run's declared branch to the exact
          // destination this caller now drives. Never derive it from a name.
          const humanAnswer = requestId !== undefined && changed?.events?.some(event => event.runId === watch.runId && (
            (event.type === 'procedure.branch.selected' && event.selectedBy !== watch.ownerId)
            || (event.type === 'procedure.run.closed' && event.status === 'transferred' && event.closedBy !== watch.ownerId))) === true
          if (!humanAnswer || view.run.status !== 'active' || view.run.driver?.actorId !== watch.ownerId) return
          const key = JSON.stringify([watch.roomId, watch.agentId, watch.resource, view.run.runId])
          if (watches.has(key)) return // A newer accepted turn already owns continuation there.
          watches.delete(watch.key)
          watch.key = key
          watch.runId = view.run.runId
          watches.set(key, watch)
          cursor = view.sequence
          requestId = view.run.inputRequest?.requestId
          ready = 'answered'
        }
        if (!eligible(watch) || view.run.runId !== watch.runId || view.run.status !== 'active') return
        const driver: ProcedureResumeView['run']['driver'] = view.run.driver
        if (driver?.kind === 'ai' && driver.actorId !== watch.ownerId) return
        const answered = requestId !== undefined && view.run.inputRequest?.requestId !== requestId
          && changed?.events?.some(event => event.type === 'procedure.branch.selected' && event.runId === watch.runId && event.selectedBy !== watch.ownerId) === true
        const released = driver === undefined && changed?.events?.some(event => event.type === 'procedure.run.driver.changed'
          && event.runId === watch.runId && event.driver === undefined && event.changedBy !== watch.ownerId) === true
        if (driver?.kind === 'person') ready = undefined
        else if (released) ready = 'released'
        else if (answered && driver?.actorId === watch.ownerId) ready = 'answered'
        const room = deps.rooms.getRoom(watch.roomId)
        if (ready !== undefined && room && !room.paused) {
          await idleForResume(ai, watch.abort.signal)
          if (!eligible(watch)) return
          // Re-read after waiting for a current generation: a person's Take
          // over or another turn's accepted procedure work wins.
          const current = await deps.reader.read(watch.resource, watch.runId, ai, watch.abort.signal)
          if (!eligible(watch) || current.run.status !== 'active'
            || (current.run.driver?.kind === 'ai' && current.run.driver.actorId !== watch.ownerId)) return
          if (current.run.driver?.kind === 'person' || current.run.inputRequest !== undefined) { ready = undefined; changed = undefined; continue }
          if (deps.rooms.getRoom(watch.roomId)?.paused) { changed = undefined; continue }
          const result = ai.requestTurn!(watch.roomId, {
            instruction: `Continue delegated procedure ${current.run.procedureId}, exact runId ${watch.runId}, on Resource ${JSON.stringify(watch.resource)}. A person ${ready === 'released' ? 'handed it back: claim this driverless run' : 'answered the step you held for'}. Read current truth, then continue with every step in chat. A later human Take over or refusal is final.`,
            inReplyTo: [watch.answerId], cause: { kind: 'resource-event', name: ready === 'released' ? 'procedure handed back' : 'procedure input answered' }, requireView: false,
          })
          if (result.kind === 'refused') console.warn(`[procedure-resume] ${result.message}`)
          return
        }
        requestId = view.run.inputRequest?.requestId ?? requestId
        cursor ??= view.sequence
        changed = await deps.reader.wait(watch.resource, watch.runId, cursor, ai, watch.abort.signal)
        // A result may stop at one event while later events already exist.
        // Consume only returned events, so a rapid takeover/release is retained.
        cursor = changed.events?.length ? Math.max(...changed.events.map(event => event.seq)) : changed.sequence
      }
    } catch (error) {
      if (!watch.abort.signal.aborted) console.warn(`[procedure-resume] Stopped watching ${watch.runId}: ${error instanceof Error ? error.message : String(error)}`)
    } finally { end(watch) }
  }
  return {
    answered: (input: { executionTurnId: string; roomId: string; messageId: string }): void => {
      if (disposed) return
      const turn = deps.executions.getTurn(input.roomId, input.executionTurnId), room = deps.rooms.getRoom(input.roomId)
      if (!turn || !room) return
      const validatedFailure = turn.status === 'failed' && room.getRetainedMessages().some(message => message.id === input.messageId
        && message.senderId === turn.agentId && message.generationTraceId === turn.id && message.type === 'error'
        && String(message.errorCode) === 'response_validation_failed')
      if (turn.status !== 'completed' && !validatedFailure) return
      const calls = deps.executions.listCalls(input.roomId, input.executionTurnId).flatMap(call => {
        const full = deps.executions.getCall(input.roomId, input.executionTurnId, call.id)
        return full === undefined ? [] : [full]
      })
      for (const candidate of procedureDelegationsOf(calls)) {
        const key = JSON.stringify([input.roomId, turn.agentId, candidate.resource, candidate.runId])
        const previous = watches.get(key)
        if (previous?.answerId === input.messageId) continue
        if (previous) end(previous)
        if (candidate.released) continue
        const watch: Watch = { ...candidate, key, roomId: input.roomId, scopeRevision: room.profile.scopeRevision,
          agentId: turn.agentId, answerId: input.messageId, abort: new AbortController() }
        watches.set(key, watch)
        void follow(watch)
      }
    },
    watching: (): ReadonlyArray<string> => [...watches.values()].map(watch => watch.runId),
    dispose: (): void => { disposed = true; for (const watch of [...watches.values()]) end(watch) },
  }
}
export type ProcedureResumes = ReturnType<typeof createProcedureResumes>
