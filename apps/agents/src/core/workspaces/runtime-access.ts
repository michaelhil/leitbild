import type { AgentsWorkspaceRuntime } from '../../workspace-runtime.ts'
import { asAIAgent } from '../../agents/shared.ts'
import { createRoomAccessView, createTeamAccessView, openRoomVisible } from '../rooms/access-view.ts'

const denied = (): never => { throw Object.assign(new Error('Room or Agent is unavailable in this view'), { code: 'conversation_access_denied' }) }

/** Public routes receive caller-specific domain ports, not the internal owner
 * runtime. A verified private view sees one exact Room; an ordinary caller
 * never sees private metadata, even through a global Agent memory endpoint.
 */
export const createRuntimeAccessView = (runtime: AgentsWorkspaceRuntime, privateRoomId?: string): AgentsWorkspaceRuntime => {
  const privateProfiles = () => runtime.rooms.listAllRooms().filter(profile => !openRoomVisible(profile))
  const privateRoom = (id: string) => { const room = runtime.rooms.getRoom(id); return room !== undefined && !openRoomVisible(room.profile) }
  const privateAgent = (id: string) => {
    const agent = runtime.team.getAgent(id), owner = agent === undefined ? undefined : asAIAgent(agent)?.getConfig().ownerRoomId
    if (owner === undefined) return false
    const room = runtime.rooms.getRoom(owner)
    return room === undefined || !openRoomVisible(room.profile)
  }
  const rooms = createRoomAccessView(runtime.rooms, profile => privateRoomId === undefined ? openRoomVisible(profile) : profile.id === privateRoomId)
  const originalTeam = createTeamAccessView(runtime.team, id => {
    if (privateRoomId === undefined) return !privateAgent(id)
    const agent = runtime.team.getAgent(id)
    return agent?.kind === 'human' || runtime.rooms.getRoom(privateRoomId)?.profile.perspective?.admission.actualAgentId === id
  })
  const requireRoom = (id: string) => rooms.getRoom(id) ?? denied()
  const requireAgent = (id: string) => originalTeam.getAgent(id) ?? denied()
  const gateRoom = <Args extends unknown[], Result>(operation: (id: string, ...args: Args) => Result) => (id: string, ...args: Args): Result => {
    requireRoom(id)
    return operation(id, ...args)
  }
  const gateAgent = <Args extends unknown[], Result>(operation: (id: string, ...args: Args) => Result) => (id: string, ...args: Args): Result => {
    requireAgent(id)
    return operation(id, ...args)
  }
  const agentView = (agent: NonNullable<ReturnType<typeof originalTeam.getAgent>>) => {
    if (privateRoomId === undefined && privateProfiles().length === 0) return agent
    const ai = asAIAgent(agent)
    if (ai === undefined) return agent
    return { ...ai,
      getHistory: gateRoom(id => ai.getHistory?.(id) ?? []),
      getIncoming: () => ai.getIncoming?.().filter(message => rooms.getRoom(message.roomId) !== undefined) ?? [],
      getContextPreview: gateRoom(ai.getContextPreview),
      getMemoryStats: () => {
        const stats = ai.getMemoryStats?.()
        return { rooms: stats?.rooms.filter(room => rooms.getRoom(room.roomId) !== undefined) ?? [],
          incomingCount: ai.getIncoming?.().filter(message => rooms.getRoom(message.roomId) !== undefined).length ?? 0,
          knownAgents: stats?.knownAgents.filter(id => originalTeam.getAgent(id) !== undefined) ?? [] }
      },
      deleteHistoryMessage: gateRoom((id, messageId: string) => ai.deleteHistoryMessage?.(id, messageId) ?? false),
      clearHistory: (id?: string) => {
        if (id !== undefined) { requireRoom(id); ai.clearHistory?.(id); return }
        for (const room of rooms.getRoomsForAgent(ai.id)) ai.clearHistory?.(room.profile.id)
      },
    }
  }
  const team = { ...originalTeam,
    getAgent: (id: string) => { const agent = originalTeam.getAgent(id); return agent === undefined ? undefined : agentView(agent) },
    listAgents: () => originalTeam.listAgents().map(agentView),
    listByKind: (kind: 'ai' | 'human') => originalTeam.listByKind(kind).map(agentView),
    listByTag: (tag: string) => originalTeam.listByTag(tag).map(agentView),
  }
  const comparisons = runtime.comparisons
  const comparisonGate = <Args extends unknown[], Result>(operation: () => (id: string, ...args: Args) => Result) => gateRoom((id: string, ...args: Args): Result => {
    if (privateRoom(id)) throw Object.assign(new Error('Perspective comparisons and delegation are not admitted in this pilot'), { code: 'perspective_comparison_unavailable' })
    return operation()(id, ...args)
  })
  return { ...runtime, rooms, team,
    routeMessage: (target, params) => {
      for (const targetId of target.rooms) {
        const actual = runtime.rooms.getRoom(targetId)
        if (actual !== undefined && rooms.getRoom(actual.profile.id) === undefined) denied()
        if (privateRoomId !== undefined && actual?.profile.id !== privateRoomId) denied()
      }
      if (privateRoomId !== undefined && runtime.team.getAgent(params.senderId)?.kind !== 'human') denied()
      return runtime.routeMessage(target, params)
    },
    agentConfiguration: {
      read: id => { requireAgent(id); return runtime.agentConfiguration.read(id) },
      update: (id, raw, actor, revision) => { requireAgent(id); return runtime.agentConfiguration.update(id, raw, actor, revision) },
    },
    readPromptEvidence: gateRoom(runtime.readPromptEvidence), readProposalCards: gateRoom(runtime.readProposalCards),
    requestDisplay: gateRoom(runtime.requestDisplay),
    displayRequestOffered: privateRoomId === undefined ? gateRoom(runtime.displayRequestOffered) : async () => false,
    removeAgent: gateAgent(runtime.removeAgent), removeRoom: gateRoom(runtime.removeRoom),
    setRoomPacks: gateRoom(runtime.setRoomPacks), activateAgentInRoom: (id, roomId) => { requireAgent(id); requireRoom(roomId); return runtime.activateAgentInRoom(id, roomId) },
    addAgentToRoom: async (id, roomId, invitedBy) => { requireAgent(id); requireRoom(roomId); await runtime.addAgentToRoom(id, roomId, invitedBy) },
    removeAgentFromRoom: (id, roomId, removedBy, options) => { requireAgent(id); requireRoom(roomId); runtime.removeAgentFromRoom(id, roomId, removedBy, options) },
    resetState: async () => {
      if (privateProfiles().length > 0) throw Object.assign(new Error('Private compartments require explicit owner disposal; ordinary Workspace reset is unavailable'), { code: 'perspective_owner_disposal_required' })
      return runtime.resetState()
    },
    evalBuffer: { ...runtime.evalBuffer,
      listRecent: input => runtime.evalBuffer.listRecent(input).filter(record => record.roomId !== undefined && rooms.getRoom(record.roomId) !== undefined && originalTeam.getAgent(record.agentId) !== undefined),
      getByTraceId: id => { const record = runtime.evalBuffer.getByTraceId(id); return record?.roomId !== undefined && rooms.getRoom(record.roomId) !== undefined && originalTeam.getAgent(record.agentId) !== undefined ? record : null },
    },
    comparisons: { ...comparisons, list: comparisonGate(() => comparisons.list), start: comparisonGate(() => comparisons.start),
      cancel: comparisonGate(() => comparisons.cancel), remove: comparisonGate(() => comparisons.remove), detail: comparisonGate(() => comparisons.detail),
      model: comparisonGate(() => comparisons.model), call: comparisonGate(() => comparisons.call) },
  }
}
