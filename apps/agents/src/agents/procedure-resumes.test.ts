import { describe, expect, test } from 'bun:test'
import { workspaceResourceReferenceSchema, type WorkspaceId } from '@leitbild/contracts'
import { createExecutionStore } from '../core/executions/store.ts'
import { createRoomDirectory } from '../core/rooms/directory.ts'
import { SYSTEM_SENDER_ID } from '../core/types/constants.ts'
import type { AIAgent, RequestedTurn } from '../core/types/agent.ts'
import { createTeam } from './team.ts'
import { createProcedureResumes, createProcedureResumeReader, procedureDelegationsOf, type ProcedureResumeChange, type ProcedureResumeView } from './procedure-resumes.ts'

const workspaceId = '6f1c4b8e-3a2d-4c1b-9f0e-1a2b3c4d5e6f' as WorkspaceId
const resource = workspaceResourceReferenceSchema.parse({ workspaceId, moduleId: 'world', type: 'world.simulation-run', id: 'run-1' })
const ownerId = 'actor:ai:owner'
const baseView = (): ProcedureResumeView => ({ sequence: 10, run: { runId: 'procedure-run:e0', procedureId: 'E-0', status: 'active', currentStepId: 'first', driver: { kind: 'ai', actorId: ownerId } } })
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve() }
const setup = (withInput = true) => {
  const rooms = createRoomDirectory({}), team = createTeam(), store = createExecutionStore(':memory:')
  const room = rooms.createRoom({ name: 'Assistant', createdBy: SYSTEM_SENDER_ID })
  const requested: RequestedTurn[] = []
  let busy = false
  const subscribers = new Set<() => void>()
  const setBusy = (value: boolean): void => { busy = value; for (const listener of subscribers) listener() }
  const agent = { id: 'owner', name: 'Assistant', kind: 'ai', metadata: {}, getSkills: () => ['procedure-runner'],
    state: { get: () => busy ? 'generating' : 'idle', getContext: () => busy ? room.profile.id : undefined, subscribe: (fn: () => void) => { subscribers.add(fn); return () => subscribers.delete(fn) } }, whenIdle: async () => {}, hasQueuedTurn: () => false,
    requestTurn: (_room: string, turn: RequestedTurn) => { requested.push(turn); return { kind: 'accepted', queued: false } },
  } as unknown as AIAgent
  team.addAgent(agent); room.addMember(agent.id)
  let world = baseView()
  if (withInput) world.run.inputRequest = { requestId: 'command:question', stepId: 'first' }
  const pending: Array<{ resolve: (change: ProcedureResumeChange) => void; sequence: number }> = []
  const reads: Array<string | undefined> = []
  const resumes = createProcedureResumes({ rooms, team, executions: store, reader: {
    read: async (_resource, runId) => { reads.push(runId); return structuredClone(world) },
    wait: async (_resource, _run, _sequence, _agent, signal) => await new Promise((resolve, reject) => {
      const entry = { resolve, sequence: _sequence }; pending.push(entry)
      signal.addEventListener('abort', () => { const index = pending.indexOf(entry); if (index >= 0) pending.splice(index, 1); reject(signal.reason) }, { once: true })
    }),
  } })
  const turn = (id: string, withRequest = withInput, release = false) => {
    store.beginTurn({ id, roomId: room.profile.id, agentId: agent.id, startedAt: Date.now() })
    const calls = [
      { key: 'start', operationId: 'world.procedure.run.start', input: { procedureId: 'E-0', scope: { plantId: 'plant:one' } } },
      ...(withRequest ? [{ key: 'question', operationId: 'world.procedure.run.request-input', input: { runId: world.run.runId, stepId: 'first', issue: 'Field reading needed.' } }] : []),
      ...(release ? [{ key: 'release', operationId: 'world.procedure.run.drive', input: { runId: world.run.runId, action: 'release' } }] : []),
    ]
    store.recordAttempt(id, { id: `${id}-call`, tool: 'workspace_call', arguments: { calls }, startedAt: Date.now() })
    store.recordOutcome(id, `${id}-call`, { success: true, data: { results: calls.map(call => ({ ...call,
      target: { kind: 'resource', ref: resource }, success: true,
      data: { ok: true, commandId: `command:${call.key === 'question' ? 'question' : call.key}`, ...(call.key === 'start' ? { next: baseView() } : {}) },
    })) } })
    store.finishTurn(id, 'completed')
    resumes.answered({ executionTurnId: id, roomId: room.profile.id, messageId: `answer-${id}` })
  }
  const change = async (view: ProcedureResumeView, event: NonNullable<ProcedureResumeChange['events']>[number]) => {
    world = view
    const next = pending.shift()
    expect(next).toBeDefined()
    next!.resolve({ sequence: event.seq, events: [event] })
    await flush()
  }
  return { resumes, room, agent, requested, reads, pending, store, turn, change, setBusy, setWorld: (view: ProcedureResumeView) => { world = view } }
}

describe('delegated procedure continuation', () => {
  test('a human answer consumes the pending input and asks the same agent in the same room once', async () => {
    const s = setup()
    s.turn('one'); await flush()
    expect(s.pending).toHaveLength(1)
    expect(s.requested).toHaveLength(0)
    expect(s.resumes.watching()).toEqual(['procedure-run:e0'])
    const answered = baseView(); answered.run.currentStepId = 'second'; answered.sequence = 11
    await s.change(answered, { type: 'procedure.branch.selected', seq: 11, runId: answered.run.runId, selectedBy: 'actor:operator' })
    expect(s.requested).toHaveLength(1)
    expect(s.requested[0]).toMatchObject({ inReplyTo: ['answer-one'], cause: { kind: 'resource-event', name: 'procedure input answered' }, requireView: false })
    expect(s.requested[0]!.instruction).toContain('procedure-run:e0')
    expect(s.requested[0]!.instruction).toContain('run-1')
    expect(s.resumes.watching()).toEqual([])
    s.resumes.dispose(); s.store.close()
  })

  test('Take over and manual work never wake the AI; explicit Hand back does', async () => {
    const s = setup(false)
    s.turn('one'); await flush()
    const human = baseView(); human.run.driver = { kind: 'person', actorId: 'actor:operator' }
    await s.change(human, { type: 'procedure.run.driver.changed', seq: 11, runId: human.run.runId, changedBy: 'actor:operator', driver: human.run.driver })
    expect(s.requested).toHaveLength(0)
    await s.change(human, { type: 'procedure.branch.selected', seq: 12, runId: human.run.runId, selectedBy: 'actor:operator' })
    expect(s.requested).toHaveLength(0)
    const released = baseView(); delete released.run.driver
    await s.change(released, { type: 'procedure.run.driver.changed', seq: 13, runId: released.run.runId, changedBy: 'actor:operator' })
    expect(s.requested).toHaveLength(1)
    expect(s.requested[0]!.instruction).toContain('claim this driverless run')
    s.resumes.dispose(); s.store.close()
  })

  test('Take over while waiting for a busy agent wins, and a later Hand back still resumes once', async () => {
    const s = setup(); s.turn('one'); await flush(); s.setBusy(true)
    const answered = baseView(); answered.run.currentStepId = 'second'
    await s.change(answered, { type: 'procedure.branch.selected', seq: 11, runId: answered.run.runId, selectedBy: 'actor:operator' })
    expect(s.requested).toHaveLength(0)
    const human = baseView(); human.run.driver = { kind: 'person', actorId: 'actor:operator' }
    s.setWorld(human); s.setBusy(false); await flush()
    expect(s.requested).toHaveLength(0)
    expect(s.pending).toHaveLength(1)
    const released = baseView(); delete released.run.driver
    await s.change(released, { type: 'procedure.run.driver.changed', seq: 13, runId: released.run.runId, changedBy: 'actor:operator' })
    expect(s.requested).toHaveLength(1)
    s.resumes.dispose(); s.store.close()
  })

  test('rapid takeover and release retain the intermediate event cursor and resume only on release', async () => {
    const s = setup(false); s.turn('one'); await flush()
    // World already reached the released state when the first event returns.
    const released = baseView(); delete released.run.driver; released.sequence = 12
    await s.change(released, { type: 'procedure.run.driver.changed', seq: 11, runId: released.run.runId,
      changedBy: 'actor:operator', driver: { kind: 'person', actorId: 'actor:operator' } })
    expect(s.requested).toHaveLength(0)
    expect(s.pending[0]!.sequence).toBe(11)
    await s.change(released, { type: 'procedure.run.driver.changed', seq: 12, runId: released.run.runId, changedBy: 'actor:operator' })
    expect(s.requested).toHaveLength(1)
    s.resumes.dispose(); s.store.close()
  })

  test('another AI, close and Room scope changes terminate the watch without a turn', async () => {
    for (const kind of ['other-driver', 'closed', 'scope'] as const) {
      const s = setup(); s.turn(kind); await flush()
      const next = baseView()
      if (kind === 'other-driver') next.run.driver = { kind: 'ai', actorId: 'actor:ai:other' }
      if (kind === 'closed') next.run.status = 'completed'
      if (kind === 'scope') s.room.setScope({ kind: 'resource', resource: workspaceResourceReferenceSchema.parse({ ...resource, id: 'run-other' }) }, s.room.profile.scopeRevision)
      await s.change(next, { type: 'procedure.run.driver.changed', seq: 11, runId: next.run.runId })
      expect(s.requested).toHaveLength(0)
      expect(s.resumes.watching()).toEqual([])
      s.resumes.dispose(); s.store.close()
    }
  })

  test('new accepted work supersedes an old watch; explicit AI release and disposal cancel long polls', async () => {
    const s = setup(); s.turn('one'); await flush()
    s.turn('two'); await flush()
    expect(s.resumes.watching()).toEqual(['procedure-run:e0'])
    expect(s.pending).toHaveLength(1)
    s.turn('released', false, true); await flush()
    expect(s.resumes.watching()).toEqual([])
    expect(s.pending).toHaveLength(0)
    expect(s.requested).toHaveLength(0)
    s.turn('three'); await flush(); s.resumes.dispose(); await flush()
    expect(s.pending).toHaveLength(0)
    expect(s.resumes.watching()).toEqual([])
    s.store.close()
  })

  test('plain reads and failed commands do not delegate a procedure', () => {
    const s = setup();
    expect(procedureDelegationsOf([{ id: 'read', tool: 'workspace_call', arguments: { calls: [{ key: 'r', input: {} }] },
      result: { success: true, data: { results: [{ key: 'r', operationId: 'world.procedure.run.step.read', target: { kind: 'resource', ref: resource }, success: true, data: baseView() }] } },
    } as any])).toEqual([])
    s.resumes.dispose(); s.store.close()
  })

  test('reader uses the exact receipt Resource and AI actor, and long-polls events without advancing time', async () => {
    const sent: Array<{ url: string; body: any }> = []
    const reader = createProcedureResumeReader({ workspaceId, hostBaseUrl: 'http://host.test', fetchImpl: (async (url, init) => {
      sent.push({ url: String(url), body: JSON.parse(String(init?.body)) })
      return Response.json({ result: sent.length === 1 ? baseView() : { sequence: 11, events: [] } })
    }) as typeof fetch })
    const s = setup(), signal = new AbortController().signal
    await reader.read(resource, 'procedure-run:e0', s.agent, signal)
    await reader.wait(resource, 'procedure-run:e0', 10, s.agent, signal)
    expect(sent[0]!.body).toMatchObject({ resource, input: { runId: 'procedure-run:e0' }, actor: { kind: 'ai', id: 'owner' } })
    expect(sent[1]!.body.input.afterSequence).toBe(10)
    expect(sent[1]!.body.input.simulationSeconds).toBeUndefined()
    expect(sent[1]!.body.input.events.some((event: any) => event.type === 'procedure.run.driver.changed')).toBe(true)
    s.resumes.dispose(); s.store.close()
  })
})
