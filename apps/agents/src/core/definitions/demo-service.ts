import type { AgentsWorkspaceRuntime } from '../../main.ts'
import { SYSTEM_SENDER_ID } from '../types/constants.ts'
import { resolveWorkspaceDefaultModel } from '../workspaces/seed-workspace.ts'
import { getDemo, type DemoDefinition, type PromptDeckEntry } from './demo-catalog.ts'

export interface AppliedDemo {
  readonly demo: DemoDefinition
  readonly room: { readonly id: string; readonly name: string }
  readonly human: { readonly id: string; readonly name: string }
  readonly agents: ReadonlyArray<{ readonly id: string; readonly name: string }>
}

const requireKnownPacks = async (
  system: AgentsWorkspaceRuntime,
  requested: ReadonlyArray<string>,
): Promise<ReadonlyArray<string>> => {
  const listTool = system.toolRegistry.get('list_packs')
  if (!listTool) throw new Error('Pack discovery is unavailable')
  const listed = await listTool.execute({}, { callerId: 'demo-service', callerName: 'demo-service' })
  if (!listed.success || !Array.isArray(listed.data)) throw new Error('Pack discovery failed')
  const packs = listed.data as Array<{ id: string; system: boolean }>
  const known = new Set(packs.map(pack => pack.id))
  const missing = requested.filter(id => !known.has(id))
  if (missing.length > 0) throw new Error(`Required Packs are unavailable: ${missing.join(', ')}`)
  return [...packs.filter(pack => pack.system).map(pack => pack.id), ...requested]
}

const uniqueAgentName = (system: AgentsWorkspaceRuntime, requested: string): string => {
  let candidate = requested
  let suffix = 2
  while (system.team.getAgent(candidate)) candidate = `${requested} ${suffix++}`
  return candidate
}

export const applyDemo = async (
  system: AgentsWorkspaceRuntime,
  demoId: string,
): Promise<AppliedDemo> => {
  const demo = getDemo(demoId)
  if (!demo) throw new Error(`Unknown demo "${demoId}"`)
  const activePacks = await requireKnownPacks(system, demo.room.packs)
  const human = system.team.listByKind('human').find(agent => agent.name === 'You')
    ?? system.team.listByKind('human')[0]
  if (!human) throw new Error('This Workspace has no human agent')

  const room = system.rooms.createRoomSafe({
    name: demo.room.name,
    roomPrompt: demo.room.prompt,
    createdBy: SYSTEM_SENDER_ID,
  }).value
  const createdAgents: Array<{ id: string; name: string }> = []
  try {
    room.setActivePacks(activePacks)
    room.setDeliveryMode(demo.room.deliveryMode)
    await system.addAgentToRoom(human.id, room.profile.id, 'demo')
    const model = resolveWorkspaceDefaultModel(system)
    for (const definition of demo.room.agents) {
      const agent = await system.spawnAIAgent({
        name: uniqueAgentName(system, definition.name),
        model,
        persona: definition.persona,
        ...(definition.tools ? { tools: definition.tools } : {}),
        ...(definition.temperature !== undefined ? { temperature: definition.temperature } : {}),
      })
      await system.addAgentToRoom(agent.id, room.profile.id, 'demo')
      createdAgents.push({ id: agent.id, name: agent.name })
    }
    // Joining a second AI intentionally auto-switches ordinary rooms to
    // manual. A Room Definition is authoritative, so restore its declared mode.
    room.setDeliveryMode(demo.room.deliveryMode)
    return {
      demo,
      room: { id: room.profile.id, name: room.profile.name },
      human: { id: human.id, name: human.name },
      agents: createdAgents,
    }
  } catch (error) {
    for (const agent of createdAgents) system.removeAgent(agent.id)
    system.removeRoom(room.profile.id)
    throw error
  }
}

export const runPromptDeckEntry = async (
  system: AgentsWorkspaceRuntime,
  demoId: string,
  roomId: string,
  entryId: string,
): Promise<PromptDeckEntry> => {
  const demo = getDemo(demoId)
  if (!demo) throw new Error(`Unknown demo "${demoId}"`)
  const entry = demo.deck.entries.find(candidate => candidate.id === entryId)
  if (!entry) throw new Error(`Unknown Prompt Deck entry "${entryId}"`)
  const room = system.rooms.getRoom(roomId)
  if (!room) throw new Error(`Room "${roomId}" not found`)

  if (entry.action.kind === 'start-script') {
    const result = await system.scriptRunner.start(room.profile.id, entry.action.scriptName)
    if (!result.ok) throw new Error(result.reason ?? 'Failed to start script')
    return entry
  }

  const human = room.getParticipantIds()
    .map(id => system.team.getAgent(id))
    .find(agent => agent?.kind === 'human')
  if (!human) throw new Error('This room has no human agent')
  room.setPaused(false)
  room.post({
    senderId: human.id,
    senderName: human.name,
    content: entry.action.content,
    type: 'chat',
  })
  if (entry.action.pauseAfterMs !== undefined) {
    setTimeout(() => system.rooms.getRoom(room.profile.id)?.setPaused(true), entry.action.pauseAfterMs)
  }
  return entry
}
