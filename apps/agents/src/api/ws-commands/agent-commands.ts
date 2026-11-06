import type { WSInbound } from '../../core/types/ws-protocol.ts'
import { asAIAgent } from '../../agents/shared.ts'
import { requireAgent, sendError, type CommandContext } from './types.ts'

export const handleAgentCommand = async (msg: WSInbound, ctx: CommandContext): Promise<boolean> => {
  const { ws, system, wsManager } = ctx

  switch (msg.type) {
    case 'create_agent': {
      const missingSkills = (msg.config.skills ?? []).filter(name => system.skillStore.get(name) === undefined)
      if (missingSkills.length > 0) {
        sendError(wsManager, ws, `Unknown Skills: ${missingSkills.join(', ')}`)
        return true
      }
      // subscribeAgentState happens automatically inside the wrapped
      // system.spawnAIAgent — see wireAgentTracking in bootstrap.ts.
      const agent = await system.spawnAIAgent(msg.config)
      const ai = asAIAgent(agent)
      ctx.wsManager.broadcastToWorkspace(ctx.session.workspaceId, { type: 'agent_joined', agent: { id: agent.id, name: agent.name, kind: agent.kind, ...(ai ? { model: ai.getModel() } : {}) } })
      return true
    }
    case 'remove_agent': {
      const agent = system.team.getAgent(msg.name)
      if (agent) {
        // unsubscribeAgentState happens automatically inside the wrapped
        // system.removeAgent — see wireAgentTracking in bootstrap.ts.
        system.removeAgent(agent.id)
        ctx.wsManager.broadcastToWorkspace(ctx.session.workspaceId, { type: 'agent_removed', agentName: msg.name })
      }
      return true
    }
    case 'update_agent': {
      const agent = requireAgent(wsManager, ws, system, msg.name)
      if (!agent) return true
      const { type: _type, name: _name, ...changes } = msg
      try { await system.agentConfiguration.update(agent.id, changes, { kind: 'human', displayName: 'Browser viewer' }) }
      catch (error) { sendError(wsManager, ws, error instanceof Error ? error.message : String(error)) }
      return true
    }
    case 'cancel_generation': {
      const agent = requireAgent(wsManager, ws, system, msg.name)
      if (!agent) return true
      const aiAgent = asAIAgent(agent)
      if (!aiAgent) { sendError(wsManager, ws, `"${msg.name}" is not an AI agent`); return true }
      aiAgent.cancelGeneration()
      return true
    }
    default:
      return false
  }
}
