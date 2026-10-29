// ============================================================================
// Proposal resumes — an approved proposal continues the procedure it held.
//
// The procedure runner ends its turn on a proposal (a hold); a person approves
// it in World's display window. World records the decision but cannot reach
// Agents, so Agents watches through the Workspace Host. When an answer posts
// whose turn proposed for a procedure (a propose carrying procedureStep, or a
// turn of a procedure-runner Agent that worked a procedure Run), each recorded
// proposal's status is read as its card reads it, every few seconds, until
// World closes it. Approved, the same Agent is asked for one turn in that Room
// (AIAgent.requestTurn) whose transient instruction names what was approved;
// the reply carries the cause and replies to the proposing answer. Rejected,
// expired, superseded or withdrawn ends the watch without a turn.
//
// At most one turn per proposal. No turn when a later turn of the Agent has
// already taken the procedure up since the approval (the person said
// "continue"), while it is answering in that Room the check waits for the
// answer. Watches follow World's proposal lifecycle, not a wall-time quota.
// They live in memory; a runtime that stops forgets them, and the person
// continues as before.
// ============================================================================

import type { ExecutionStore, ExecutionCall } from '../core/executions/store.ts'
import type { RoomDirectory } from '../core/rooms/directory.ts'
import type { Room } from '../core/types/room.ts'
import type { AIAgent, RequestedTurn, Team } from '../core/types/agent.ts'
import { workspaceResourceReferenceSchema, type WorkspaceResourceReference } from '@leitbild/contracts'
import { PROCEDURE_RUNNER_SKILL, PROPOSAL_RESUME_CAUSE } from '../core/proposal-resume.ts'
import { collectTurnOperations, type TurnOperation } from './operation-claims.ts'
import { actorWords, proposedOperationsOf, type ProposalCardReader, type ProposedOperation, type WorldProposal } from './proposal-cards.ts'
import { asAIAgent } from './shared.ts'

/** Operations of a procedure Run (World); a turn that calls one works a procedure. */
// Dated exception (P0, 2026-10-20): names a World operation id, against the platform rule that Agents discover Capabilities at runtime, until the swap (plan v3.1 §7), when World's procedure Run says which turns drive it.
const PROCEDURE_OPERATION_PREFIX = 'world.procedure.'

// An approval resumes the agent within a few seconds; the display window
// reads the same proposals as often. Reads stop once a proposal closes.
const POLL_MS = 3_000
// Turns read per page while looking for one that took the procedure up.
const TURNS_PAGE = 20

export interface ProposalResumeDeps {
  readonly rooms: Pick<RoomDirectory, 'getRoom'>
  readonly team: Pick<Team, 'getAgent'>
  readonly executions: Pick<ExecutionStore, 'getTurn' | 'listTurns' | 'listCalls' | 'getCall'>
  /** World's status of each proposal, read through the Host as the proposing agent. */
  readonly readStatus: ProposalCardReader['read']
  readonly pollMs?: number
  readonly now?: () => number
  /** Runs `run` once after `ms`; returns its cancel. */
  readonly setTimer?: (run: () => void, ms: number) => () => void
}

interface Watched {
  readonly operation: ProposedOperation & { readonly outcome: { readonly kind: 'recorded'; readonly proposalId: string } }
  /** When a read last found it pending was sent: the approval came after. */
  pendingSeenAt: number
}

interface Approved {
  readonly operation: Watched['operation']
  readonly proposal: WorldProposal
  readonly pendingSeenAt: number
}

interface Watch {
  readonly turnId: string
  readonly roomId: string
  readonly agentId: string
  readonly answerId: string
  readonly startedAt: number
  readonly scopeRevision: number
  readonly abort: AbortController
  readonly procedureRuns: ReadonlyMap<string, ReadonlySet<string>>
  readonly watched: Map<string, Watched>
  approved: Approved[]
}

/** What was approved, as World words the control: "TRIP RX-TRIP", "RESET Manual safety injection". */
const actionWords = (approved: Approved): string =>
  approved.operation.reset === true ? approved.proposal.word : `${approved.proposal.word} ${approved.operation.target}`

const approverOf = (approved: ReadonlyArray<Approved>): string => {
  const actors = [...new Set(approved.map(entry => entry.proposal.closed?.actorId).filter((actor): actor is string => actor !== undefined))]
  return actors.length === 0 ? 'a person' : [...new Set(actors.map(actorWords))].join(' and ')
}

/** Who approved, opening a sentence: a kind of actor capitalised ("An operator"); a person's name as it is. */
const approverOpening = (approved: ReadonlyArray<Approved>): string =>
  approverOf(approved).replace(/^(a|an|the) /, first => `${first.charAt(0).toUpperCase()}${first.slice(1)}`)

/** The reply's cause: who approved what. */
const proposalResumeCause = (approved: ReadonlyArray<Approved>): RequestedTurn['cause'] =>
  ({ kind: PROPOSAL_RESUME_CAUSE, name: `${approverOf(approved)} approved ${approved.map(actionWords).join(', ')}` })

/** The transient instruction of the resumed turn. How to continue stays in the procedure-runner Skill. */
const proposalResumeInstruction = (approved: ReadonlyArray<Approved>, answerId: string): string => {
  const items = approved.map(entry => {
    const step = entry.operation.procedureStep === undefined ? '' : ` for ${entry.operation.procedureStep}`
    return `${actionWords(entry)} on Plant ${entry.operation.plantId}${step}`
  })
  return `[Proposal approved] ${approverOpening(approved)} approved your ${items.length === 1 ? 'proposal' : 'proposals'} `
    + `${items.join('; ')} (your answer, messageId "${answerId}") in the display window, and World executed it. `
    // This turn starts seconds after the decision, before the plant has
    // responded (probe 2026-10-13: power still 5 % and subcriticality red
    // 10 plant seconds after a trip, so the runner held at E-0 step 1).
    // Dated exception (P0, 2026-10-20): names a World operation id, against the platform rule that Agents discover Capabilities at runtime, until the swap (plan v3.1 §7), when the World proposal vignette carries how to wait.
    + 'The plant may not show its effect yet: where a reading you judge by has not responded, wait in plant seconds '
    + '(world.simulation-run.wait with procedureRunId) before you judge a step or hold on it. '
    + 'Continue the procedure as you would on "continue": read where it stands, say what changed that you did not do, and carry on.'
}

const callsOf = (executions: ProposalResumeDeps['executions'], roomId: string, turnId: string): ReadonlyArray<ExecutionCall> =>
  executions.listCalls(roomId, turnId).flatMap(summary => {
    const call = executions.getCall(roomId, turnId, summary.id)
    return call === undefined ? [] : [call]
  })

const operationsOf = (calls: ReadonlyArray<ExecutionCall>): ReadonlyArray<TurnOperation> => {
  const operations: TurnOperation[] = []
  for (const call of calls) if (call.result !== undefined) collectTurnOperations(operations, call.tool, call.arguments, call.result)
  return operations
}

const worksProcedure = (operations: ReadonlyArray<TurnOperation>): boolean =>
  operations.some(operation => operation.operationId.startsWith(PROCEDURE_OPERATION_PREFIX))

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const ownerKey = (resource: WorkspaceResourceReference, plantId: string): string =>
  JSON.stringify([resource.workspaceId, resource.moduleId, resource.type, resource.id, plantId])

/** Actual matched results retain the Resource and World-owned Run identity;
 * a successful read is useful for identity, never proof of progression. */
const procedureResults = (calls: ReadonlyArray<ExecutionCall>) => calls.flatMap(call => {
  if (call.tool !== 'workspace_call' || call.result?.success !== true || !record(call.arguments) || !Array.isArray(call.arguments.calls)
    || !record(call.result.data) || !Array.isArray(call.result.data.results)) return []
  const args = call.arguments.calls
  return call.result.data.results.flatMap(entry => {
    if (!record(entry) || entry.success !== true || typeof entry.operationId !== 'string' || !entry.operationId.startsWith(PROCEDURE_OPERATION_PREFIX)
      || !record(entry.data)) return []
    const arg = args.find(value => record(value) && value.key === entry.key && value.operationId === entry.operationId)
    const resource = record(entry.target) && entry.target.kind === 'resource' ? workspaceResourceReferenceSchema.safeParse(entry.target.ref) : undefined
    if (!record(arg) || !record(arg.input) || !resource?.success) return []
    const view = record(entry.data.next) ? entry.data.next : entry.data
    const run = record(view.run) ? view.run : undefined
    const inputScope = record(arg.input.scope) ? arg.input.scope : undefined
    const pinned = record(entry.data.pinned) ? entry.data.pinned : undefined
    return [{ operationId: entry.operationId, input: arg.input, data: entry.data, resource: resource.data,
      at: call.completedAt,
      plantId: typeof run?.plantId === 'string' ? run.plantId : typeof inputScope?.plantId === 'string' ? inputScope.plantId : undefined,
      runId: typeof arg.input.runId === 'string' ? arg.input.runId : typeof run?.runId === 'string' ? run.runId : typeof pinned?.runId === 'string' ? pinned.runId : undefined }]
  })
})

const procedureRunsOf = (calls: ReadonlyArray<ExecutionCall>): ReadonlyMap<string, ReadonlySet<string>> => {
  const runs = new Map<string, Set<string>>()
  for (const result of procedureResults(calls)) {
    if (result.plantId === undefined || result.runId === undefined) continue
    const key = ownerKey(result.resource, result.plantId), ids = runs.get(key) ?? new Set<string>()
    ids.add(result.runId); runs.set(key, ids)
  }
  return runs
}

const progressionOperations: ReadonlySet<string> = new Set([
  'world.procedure.run.start', 'world.procedure.run.transition', 'world.procedure.run.drive',
  'world.procedure.run.request-input', 'world.procedure.run.close', 'world.procedure.run.reset',
])

const committedProgression = (results: ReturnType<typeof procedureResults>, watch: Watch, approved: Approved): boolean => {
  return results.some(result => {
    if (!progressionOperations.has(result.operationId) || result.data.ok !== true || typeof result.data.commandId !== 'string' || result.data.commandId.length === 0
      || result.at === undefined || result.at <= approved.pendingSeenAt) return false
    const plantId = result.plantId ?? results.find(read => read.runId === result.runId && ownerKey(read.resource, '') === ownerKey(result.resource, ''))?.plantId
    if (plantId === undefined) return false
    const owner = ownerKey(result.resource, plantId)
    if (ownerKey(approved.operation.outcome.resource, approved.operation.plantId) !== owner) return false
    const knownRuns = watch.procedureRuns.get(owner)
    return knownRuns === undefined || (result.runId !== undefined && knownRuns.has(result.runId))
  })
}

export const createProposalResumes = (deps: ProposalResumeDeps) => {
  const pollMs = deps.pollMs ?? POLL_MS
  const now = deps.now ?? Date.now
  const setTimer = deps.setTimer ?? ((run, ms) => {
    const timer = setTimeout(run, ms)
    timer.unref?.()
    return () => clearTimeout(timer)
  })
  const watches = new Map<string, Watch>()
  // A turn links each message it posts; its proposals are watched once.
  const watchedTurns = new Set<string>()
  let cancelTimer: (() => void) | undefined
  let running: Promise<void> | undefined
  let disposed = false

  const end = (watch: Watch, why?: string): undefined => {
    watches.delete(watch.turnId)
    watch.abort.abort()
    if (why !== undefined) console.warn(`[proposal-resume] No resume for turn ${watch.turnId} in room ${watch.roomId}: ${why}`)
    return undefined
  }

  const eligible = (watch: Watch): { room: Room; ai: AIAgent } | undefined => {
    if (disposed || watches.get(watch.turnId) !== watch || watch.abort.signal.aborted) return undefined
    const room = deps.rooms.getRoom(watch.roomId)
    if (room === undefined) return end(watch, 'the room no longer exists')
    if (room.profile.scopeRevision !== watch.scopeRevision) return end(watch, 'the Room Scope changed')
    const agent = deps.team.getAgent(watch.agentId), ai = agent === undefined ? undefined : asAIAgent(agent)
    if (ai?.requestTurn === undefined || !ai.getSkills().includes(PROCEDURE_RUNNER_SKILL)) return end(watch, 'its agent can no longer continue procedures')
    if (!room.hasMember(ai.id) || room.isMuted(ai.id)) return end(watch, `${ai.name} is no longer an unmuted member of the room`)
    if (room.deliveryMode === 'manual') return end(watch, 'the room delivers manually')
    return { room, ai }
  }

  // Actual later outcomes for each approval, not the time a turn began.
  // Other owners' progress and read-only advice do not consume its resume.
  const tookUpSince = (watch: Watch): ReadonlySet<string> => {
    const taken = new Set<string>()
    let before: { readonly startedAt: number; readonly id: string } | undefined
    for (;;) {
      const page = deps.executions.listTurns(watch.roomId, { limit: TURNS_PAGE, ...(before === undefined ? {} : { before }) })
      for (const turn of page) {
        if (turn.startedAt < watch.startedAt) return taken
        if (turn.agentId !== watch.agentId || turn.id === watch.turnId) continue
        const results = procedureResults(callsOf(deps.executions, watch.roomId, turn.id))
        for (const approved of watch.approved) if (committedProgression(results, watch, approved)) taken.add(approved.operation.outcome.proposalId)
        if (taken.size === watch.approved.length) return taken
      }
      if (page.length < TURNS_PAGE) return taken
      before = page.at(-1)!
    }
  }

  const resume = (watch: Watch, room: Room, ai: AIAgent): void => {
    // A paused Room runs no Agent, and an answer in progress may be the one
    // that takes the procedure up: ask again on a later read.
    if (room.paused) return
    if (ai.state.get() === 'generating' && ai.state.getContext() === room.profile.id) return
    const taken = tookUpSince(watch)
    watch.approved = watch.approved.filter(approved => !taken.has(approved.operation.outcome.proposalId))
    if (watch.approved.length === 0) return
    if (!eligible(watch)) return // Scope or membership may change while inspecting execution records.
    const result = ai.requestTurn!(room.profile.id, {
      instruction: proposalResumeInstruction(watch.approved, watch.answerId),
      inReplyTo: [watch.answerId],
      cause: proposalResumeCause(watch.approved),
      requireView: false,
    })
    // Another requested turn waits in the Room: ask again on a later read.
    if (result.kind === 'refused' && result.reason === 'pending') return
    if (result.kind === 'refused') console.warn(`[proposal-resume] ${ai.name} was not resumed in room ${watch.roomId}: ${result.message}`)
    watch.approved = []
  }

  const read = async (watch: Watch, ai: AIAgent): Promise<void> => {
    if (!eligible(watch)) return
    const sentAt = now()
    const cards = await deps.readStatus([...watch.watched.values()].map(entry => entry.operation), { id: ai.id, name: ai.name }, watch.abort.signal)
    if (!eligible(watch)) return // Late status evidence cannot outlive its Room authority.
    for (const card of cards) {
      if (card.outcome.kind === 'refused') continue
      const entry = watch.watched.get(card.outcome.proposalId)
      if (entry === undefined) continue
      if (card.outcome.kind === 'unreadable') {
        watch.watched.delete(card.outcome.proposalId)
        console.warn(`[proposal-resume] Stopped watching proposal ${card.outcome.proposalId}: ${card.outcome.reason}`)
        continue
      }
      const proposal = card.outcome.proposal
      if (proposal.status === 'pending') {
        entry.pendingSeenAt = sentAt
        continue
      }
      watch.watched.delete(card.outcome.proposalId)
      if (proposal.status === 'approved') watch.approved.push({ operation: entry.operation, proposal, pendingSeenAt: entry.pendingSeenAt })
    }
  }

  const step = async (watch: Watch): Promise<void> => {
    const active = eligible(watch)
    if (!active) return
    const { room, ai } = active
    if (watch.watched.size > 0) {
      try {
        await read(watch, ai)
      } catch (error) {
        // The Host did not answer; read again next time.
        if (!watch.abort.signal.aborted) console.warn(`[proposal-resume] Could not read proposals of turn ${watch.turnId}:`, error)
      }
      if (!eligible(watch)) return
    }
    if (watch.approved.length > 0) resume(watch, room, ai)
    if (watch.watched.size === 0 && watch.approved.length === 0) end(watch)
  }

  const tick = (): Promise<void> => {
    running ??= (async () => {
      for (const watch of [...watches.values()]) {
        if (disposed) return
        try {
          await step(watch)
        } catch (error) {
          end(watch, `unexpected error: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    })().finally(() => { running = undefined })
    return running
  }

  const schedule = (): void => {
    if (disposed || cancelTimer !== undefined || watches.size === 0) return
    cancelTimer = setTimer(() => {
      cancelTimer = undefined
      void tick().then(schedule)
    }, pollMs)
  }

  return {
    /**
     * An answer of `executionTurnId` was posted. Watches the turn's recorded
     * proposals made for a procedure. Never throws: the answer is delivered.
     */
    answered: (input: { readonly executionTurnId: string; readonly roomId: string; readonly messageId: string }): void => {
      if (disposed || watchedTurns.has(input.executionTurnId)) return
      try {
        const turn = deps.executions.getTurn(input.roomId, input.executionTurnId)
        if (!turn) return
        // A final answer rejected for contradicting evidence does not undo
        // its committed proposals. Only that exact posted error may continue
        // watching; interruptions and provider failures remain excluded.
        const room = deps.rooms.getRoom(input.roomId)
        const validatedFailure = turn.status === 'failed' && room?.getRetainedMessages().some(message => message.id === input.messageId
          && message.senderId === turn.agentId && message.generationTraceId === turn.id && message.type === 'error'
          && String(message.errorCode) === 'response_validation_failed') === true
        if (!room || (turn.status !== 'completed' && !validatedFailure)) return
        const calls = callsOf(deps.executions, turn.roomId, turn.id)
        const recorded = proposedOperationsOf(calls)
          .filter((operation): operation is Watched['operation'] => operation.outcome.kind === 'recorded')
        if (recorded.length === 0) return
        const agent = deps.team.getAgent(turn.agentId)
        const runner = agent !== undefined && asAIAgent(agent)?.getSkills().includes(PROCEDURE_RUNNER_SKILL) === true
          && worksProcedure(operationsOf(calls))
        const forProcedure = recorded.filter(operation => operation.procedureStep !== undefined || runner)
        if (forProcedure.length === 0) return
        const startedAt = now()
        watchedTurns.add(turn.id)
        watches.set(turn.id, {
          turnId: turn.id,
          roomId: turn.roomId,
          agentId: turn.agentId,
          answerId: input.messageId,
          startedAt: turn.startedAt, scopeRevision: room.profile.scopeRevision, abort: new AbortController(), procedureRuns: procedureRunsOf(calls),
          watched: new Map(forProcedure.map(operation => [operation.outcome.proposalId, { operation, pendingSeenAt: turn.finishedAt ?? startedAt }])),
          approved: [],
        })
        schedule()
      } catch (error) {
        console.error(`[proposal-resume] Could not watch the proposals of turn ${input.executionTurnId}:`, error)
      }
    },
    /** Reads every watch once; the timer calls it, tests may too. */
    tick,
    /** The turns whose proposals are watched now. */
    watching: (): ReadonlyArray<string> => [...watches.keys()],
    dispose: (): void => {
      disposed = true
      cancelTimer?.()
      cancelTimer = undefined
      for (const watch of [...watches.values()]) end(watch)
    },
  }
}
export type ProposalResumes = ReturnType<typeof createProposalResumes>
