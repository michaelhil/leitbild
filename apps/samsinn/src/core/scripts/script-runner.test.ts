import { describe, expect, test } from 'bun:test'
import { createAIAgent } from '../../agents/ai-agent.ts'
import { createTeam } from '../../agents/team.ts'
import type { System } from '../../main.ts'
import { createHouse } from '../house.ts'
import { createRoomOperations } from '../room-operations.ts'
import type { TriggerScheduler } from '../triggers/scheduler.ts'
import type { Agent, AIAgentConfig, RouteMessage } from '../types/agent.ts'
import type { ChatRequest, ChatResponse, LLMProvider } from '../types/llm.ts'
import type { Message } from '../types/messaging.ts'
import type { Script } from '../types/script.ts'
import { createScriptRunner } from './script-runner.ts'

const llm: LLMProvider = {
  chat: async (_req: ChatRequest): Promise<ChatResponse> => ({
    content: '',
    generationMs: 0,
    tokensUsed: { prompt: 0, completion: 0 },
  }),
  models: async (): Promise<string[]> => ['test-model'],
}

const script: Script = {
  id: 'script-1',
  name: 'demo',
  title: 'Demo Script',
  cast: [
    { name: 'Alex', model: 'test-model', persona: 'You are Alex.', starts: true },
    { name: 'Sam', model: 'test-model', persona: 'You are Sam.' },
  ],
  steps: [
    { index: 0, title: 'Opening', roles: { Alex: 'start', Sam: 'respond' } },
  ],
  source: '',
}

const triggerScheduler: TriggerScheduler = {
  invalidate: (): void => {},
  stop: (): void => {},
  tickNow: async (): Promise<ReadonlyArray<{ readonly agentId: string; readonly triggerId: string }>> => [],
}

describe('script runner teardown', () => {
  test('stopping a script removes temporary cast without deleting an otherwise empty room', async () => {
    const house = createHouse()
    const team = createTeam()
    const room = house.createRoom({ name: 'Script Room', createdBy: 'test' })
    const routeMessage: RouteMessage = (target, params) => {
      const posted: Message[] = []
      for (const roomId of target.rooms ?? []) {
        const targetRoom = house.getRoom(roomId)
        if (targetRoom) posted.push(targetRoom.post(params))
      }
      return posted
    }
    const roomOps = createRoomOperations({
      team,
      house,
      routeMessage,
      onMembershipChanged: () => {},
      triggerScheduler,
    })
    const removeAgent = (id: string): boolean => {
      const agent = team.getAgent(id)
      if (!agent) return false
      for (const profile of house.listAllRooms()) {
        const existingRoom = house.getRoom(profile.id)
        if (existingRoom?.hasMember(id)) roomOps.removeAgentFromRoom(id, profile.id)
      }
      return team.removeAgent(id)
    }
    const system = {
      house,
      team,
      llmService: { bound: () => llm },
      spawnAIAgent: async (config: AIAgentConfig): Promise<Agent> => {
        const agent = createAIAgent(config, llm, () => {})
        team.addAgent(agent)
        return agent
      },
      addAgentToRoom: roomOps.addAgentToRoom,
      removeAgentFromRoom: roomOps.removeAgentFromRoom,
      removeAgent,
      activateAgentInRoom: () => ({ ok: true, queued: false }),
    } as unknown as System
    const runner = createScriptRunner({ getSystem: () => system })

    await expect(runner.startWith(room.profile.id, script)).resolves.toEqual({ ok: true })
    expect(room.getParticipantIds()).toHaveLength(2)

    await expect(runner.stop(room.profile.id)).resolves.toEqual({ ok: true })

    expect(house.getRoom(room.profile.id)).toBe(room)
    expect(room.getParticipantIds()).toEqual([])
    expect(team.listAgents()).toEqual([])
  })

  test('pause lets the current cast post finish but blocks the next activation until resume', async () => {
    const house = createHouse()
    const team = createTeam()
    const room = house.createRoom({ name: 'Pause Room', createdBy: 'test' })
    const activations: string[] = []
    const routeMessage: RouteMessage = (target, params) => {
      const posted: Message[] = []
      for (const roomId of target.rooms ?? []) {
        const targetRoom = house.getRoom(roomId)
        if (targetRoom) posted.push(targetRoom.post(params))
      }
      return posted
    }
    const roomOps = createRoomOperations({
      team,
      house,
      routeMessage,
      onMembershipChanged: () => {},
      triggerScheduler,
    })
    const system = {
      house,
      team,
      llmService: { bound: () => llm },
      spawnAIAgent: async (config: AIAgentConfig): Promise<Agent> => {
        const agent = createAIAgent(config, llm, () => {})
        team.addAgent(agent)
        return agent
      },
      addAgentToRoom: roomOps.addAgentToRoom,
      removeAgentFromRoom: roomOps.removeAgentFromRoom,
      removeAgent: () => true,
      activateAgentInRoom: (agentId: string) => {
        activations.push(team.getAgent(agentId)?.name ?? agentId)
        return { ok: true, queued: false }
      },
    } as unknown as System
    const runner = createScriptRunner({ getSystem: () => system })

    await runner.startWith(room.profile.id, script)
    expect(activations).toEqual(['Alex'])

    room.setPaused(true)
    const message = room.post({
      senderId: team.getAgent('Alex')!.id,
      senderName: 'Alex',
      content: 'The current response is complete.',
      type: 'chat',
    })
    runner.onRoomMessage(room.profile.id, message)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(activations).toEqual(['Alex'])

    room.setPaused(false)
    await runner.resume(room.profile.id)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(activations).toEqual(['Alex', 'Sam'])
  })
})
