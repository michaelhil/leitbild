import type { AgentsWorkspaceRuntime } from '../../main.ts'
import { BUNDLED_PACKS } from '../../packs/bundled.ts'
import { scanPacks } from '../../packs/scanner.ts'
import { SYSTEM_SENDER_ID } from '../types/constants.ts'
import { resolveWorkspaceDefaultModel } from '../workspaces/seed-workspace.ts'
import type { RoomDefinition, PromptDeckEntry } from './room-definition-catalog.ts'
import type { RoomDefinitionLibrary } from './room-definition-library.ts'

export interface StartedRoomDefinition {
  readonly definition: RoomDefinition
  readonly revisionId: string
  readonly room: { readonly id: string; readonly name: string }
  readonly human: { readonly id: string; readonly name: string }
  readonly agents: ReadonlyArray<{ readonly id: string; readonly name: string }>
}

const requireKnownPacks = async (
  system: AgentsWorkspaceRuntime,
  requested: ReadonlyArray<string>,
): Promise<ReadonlyArray<string>> => {
  const installed = await scanPacks(system.packsDir)
  const known = new Set([
    ...BUNDLED_PACKS.map(pack => pack.descriptor.id),
    ...installed.map(pack => pack.id),
  ])
  const missing = requested.filter(id => !known.has(id))
  if (missing.length > 0) throw new Error(`Required Packs are unavailable: ${missing.join(', ')}`)
  return [...BUNDLED_PACKS.filter(pack => pack.system).map(pack => pack.descriptor.id), ...requested]
}

const uniqueAgentName = (system: AgentsWorkspaceRuntime, requested: string): string => {
  let candidate = requested
  let suffix = 2
  while (system.team.getAgent(candidate)) candidate = `${requested} ${suffix++}`
  return candidate
}

const requireKnownTools = (system: AgentsWorkspaceRuntime, requested: ReadonlyArray<string>): void => {
  const missing = requested.filter(name => system.toolRegistry.get(name) === undefined)
  if (missing.length > 0) throw new Error(`Required tools are unavailable: ${missing.join(', ')}`)
}

export const startRoomDefinition = async (
  system: AgentsWorkspaceRuntime,
  library: RoomDefinitionLibrary,
  definitionId: string,
  revisionId: string,
): Promise<StartedRoomDefinition> => {
  const current = await library.get(definitionId)
  if (!current) throw new Error(`Unknown Room Definition "${definitionId}"`)
  if (current.id !== revisionId) throw new Error(`Room Definition Revision is not current: ${revisionId}`)
  const revision = await library.getRevision(revisionId)
  if (!revision || revision.definitionId !== definitionId) throw new Error(`Unknown Room Definition Revision "${revisionId}"`)
  const definition = revision.definition
  requireKnownTools(system, definition.requiredTools)
  const activePacks = await requireKnownPacks(system, definition.room.packs)
  const human = system.team.listByKind('human').find(agent => agent.name === 'You')
    ?? system.team.listByKind('human')[0]
  if (!human) throw new Error('This Workspace has no human agent')

  const room = system.rooms.createRoomSafe({
    name: definition.room.name,
    roomPrompt: definition.room.prompt,
    createdBy: SYSTEM_SENDER_ID,
    sourceDefinition: { id: definition.id, revisionId: revision.id },
  }).value
  const createdAgents: Array<{ id: string; name: string }> = []
  try {
    room.setActivePacks(activePacks)
    room.setDeliveryMode(definition.room.deliveryMode)
    await system.addAgentToRoom(human.id, room.profile.id, 'demo')
    const model = resolveWorkspaceDefaultModel(system)
    for (const agentDefinition of definition.room.agents) {
      const agent = await system.spawnAIAgent({
        name: uniqueAgentName(system, agentDefinition.name),
        model,
        persona: agentDefinition.persona,
        ...(agentDefinition.tools ? { tools: agentDefinition.tools } : {}),
        ...(agentDefinition.toolGrants ? { toolGrants: agentDefinition.toolGrants } : {}),
        ...(agentDefinition.temperature !== undefined ? { temperature: agentDefinition.temperature } : {}),
      })
      await system.addAgentToRoom(agent.id, room.profile.id, 'demo')
      createdAgents.push({ id: agent.id, name: agent.name })
    }
    // Joining a second AI intentionally auto-switches ordinary rooms to
    // manual. A Room Definition is authoritative, so restore its declared mode.
    room.setDeliveryMode(definition.room.deliveryMode)
    return {
      definition,
      revisionId: revision.id,
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
  library: RoomDefinitionLibrary,
  roomId: string,
  entryId: string,
): Promise<PromptDeckEntry> => {
  const room = system.rooms.getRoom(roomId)
  if (!room) throw new Error(`Room "${roomId}" not found`)
  const sourceDefinition = room.profile.sourceDefinition
  if (!sourceDefinition) throw new Error('Room was not created from a Room Definition')
  const revision = await library.getRevision(sourceDefinition.revisionId)
  if (!revision || revision.definitionId !== sourceDefinition.id) {
    throw new Error(`Room Definition Revision "${sourceDefinition.revisionId}" not found`)
  }
  const entry = revision.definition.deck.entries.find(candidate => candidate.id === entryId)
  if (!entry) throw new Error(`Unknown Prompt Deck entry "${entryId}"`)

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
