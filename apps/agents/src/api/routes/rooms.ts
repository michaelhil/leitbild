import { json, errorResponse, parseBody } from './helpers.ts'
import { SYSTEM_SENDER_ID } from '../../core/types/constants.ts'
import { SETTABLE_DELIVERY_MODES } from '../../core/types/messaging.ts'
import type { SettableDeliveryMode } from '../../core/types/messaging.ts'
import { validateSummaryConfig } from '../../core/types/summary.ts'
import type { RouteEntry } from './types.ts'
import { asAIAgent } from '../../agents/shared.ts'
import { exportRoomConversation } from '../../core/rooms/room-export.ts'

export const roomRoutes: RouteEntry[] = [
  {
    method: 'GET',
    pattern: /^\/rooms$/,
    handler: (_req, _match, { system }) => json(system.rooms.listAllRooms()),
  },
  {
    method: 'POST',
    pattern: /^\/rooms$/,
    handler: async (req, _match, { system }) => {
      const body = await parseBody(req)
      if (!body.name || typeof body.name !== 'string') return errorResponse('name is required')
      try {
        const result = system.rooms.createRoomSafe({
          name: body.name,
          roomPrompt: body.roomPrompt as string | undefined,
          createdBy: (body.createdBy as string) ?? SYSTEM_SENDER_ID,
        })
        return json(result, 201)
      } catch (err) {
        return errorResponse(err instanceof Error ? err.message : 'Failed to create room')
      }
    },
  },
  {
    method: 'GET',
    pattern: /^\/rooms\/([^/]+)$/,
    handler: (req, match, { system }) => {
      const name = decodeURIComponent(match[1]!)
      const room = system.rooms.getRoom(name)
      if (!room) return errorResponse(`Room "${name}" not found`, 404)
      const limit = parseInt(new URL(req.url).searchParams.get('limit') ?? '50', 10)
      return json({ profile: room.profile, messages: room.getRecent(limit) })
    },
  },
  {
    method: 'GET',
    pattern: /^\/rooms\/([^/]+)\/export$/,
    handler: (_req, match, { system }) => {
      const name = decodeURIComponent(match[1]!)
      const room = system.rooms.getRoom(name)
      if (!room) return errorResponse(`Room "${name}" not found`, 404)
      return json(exportRoomConversation(room))
    },
  },
  {
    method: 'DELETE',
    pattern: /^\/rooms\/([^/]+)\/messages\/([^/]+)$/,
    handler: (_req, match, { system }) => {
      const name = decodeURIComponent(match[1]!)
      const messageId = decodeURIComponent(match[2]!)
      const room = system.rooms.getRoom(name)
      if (!room) return errorResponse(`Room "${name}" not found`, 404)
      const deleted = room.deleteMessage(messageId)
      if (!deleted) return errorResponse(`Message "${messageId}" not found`, 404)
      return json({ deleted: true, messageId })
    },
  },
  {
    method: 'DELETE',
    pattern: /^\/rooms\/([^/]+)\/messages$/,
    handler: (_req, match, { system }) => {
      const name = decodeURIComponent(match[1]!)
      const room = system.rooms.getRoom(name)
      if (!room) return errorResponse(`Room "${name}" not found`, 404)
      const count = room.getMessageCount()
      room.clearMessages()
      // Also wipe per-agent memory of this room so AI participants don't
      // retain phantom history of cleared messages.
      for (const agentId of room.getParticipantIds()) {
        const agent = system.team.getAgent(agentId)
        const ai = agent ? asAIAgent(agent) : undefined
        ai?.clearHistory?.(room.profile.id)
      }
      return json({ cleared: true, count })
    },
  },
  {
    method: 'DELETE',
    pattern: /^\/rooms\/([^/]+)$/,
    handler: (_req, match, { system }) => {
      const name = decodeURIComponent(match[1]!)
      const room = system.rooms.getRoom(name)
      if (!room) return errorResponse(`Room "${name}" not found`, 404)
      system.removeRoom(room.profile.id)
      return json({ removed: true })
    },
  },
  {
    method: 'PUT',
    pattern: /^\/rooms\/([^/]+)\/prompt$/,
    handler: async (req, match, { system }) => {
      const name = decodeURIComponent(match[1]!)
      const room = system.rooms.getRoom(name)
      if (!room) return errorResponse(`Room "${name}" not found`, 404)
      const body = await parseBody(req)
      if (typeof body.roomPrompt !== 'string') return errorResponse('roomPrompt is required')
      room.setRoomPrompt(body.roomPrompt)
      return json({ roomPrompt: room.profile.roomPrompt })
    },
  },
  {
    // List the exact Packs activated in this Room.
    method: 'GET',
    pattern: /^\/rooms\/([^/]+)\/packs$/,
    handler: async (_req, match, { system }) => {
      const name = decodeURIComponent(match[1]!)
      const room = system.rooms.getRoom(name)
      if (!room) return errorResponse(`Room "${name}" not found`, 404)
      return json({ activePacks: room.getActivePacks() })
    },
  },
  {
    // Replace activation list. Validates each entry against the known-pack
    // set (bundled + filesystem-installed). The request is atomic: any
    // unknown Pack id aborts the whole replacement.
    method: 'PUT',
    pattern: /^\/rooms\/([^/]+)\/packs$/,
    handler: async (req, match, { system, broadcastToWorkspace, workspaceId }) => {
      const name = decodeURIComponent(match[1]!)
      const room = system.rooms.getRoom(name)
      if (!room) return errorResponse(`Room "${name}" not found`, 404)
      const body = await parseBody(req) as { activePacks?: unknown } | null
      if (!Array.isArray(body?.activePacks)
        || !body.activePacks.every(value => typeof value === 'string' && value.length > 0)) {
        return errorResponse('activePacks must be an array of Pack ids', 400)
      }
      const requested = [...new Set(body.activePacks as ReadonlyArray<string>)]

      const knownSet = new Set(system.packCatalog.list().map(pack => pack.id))

      const unknown = requested.filter(ns => !knownSet.has(ns))
      if (unknown.length > 0) return errorResponse(`unknown Pack ids: ${unknown.join(', ')}`, 400)

      room.setActivePacks(requested)
      const activePacks = room.getActivePacks()
      broadcastToWorkspace(workspaceId, { type: 'pack_activation_changed', roomId: room.profile.id, activePacks })
      return json({ activePacks })
    },
  },
  {
    method: 'GET',
    pattern: /^\/rooms\/([^/]+)\/members$/,
    handler: (_req, match, { system }) => {
      const name = decodeURIComponent(match[1]!)
      const room = system.rooms.getRoom(name)
      if (!room) return errorResponse(`Room "${name}" not found`, 404)
      const members = room.getParticipantIds().map(id => {
        const agent = system.team.getAgent(id)
        return agent ? { id: agent.id, name: agent.name, kind: agent.kind } : { id }
      })
      return json(members)
    },
  },
  {
    method: 'POST',
    pattern: /^\/rooms\/([^/]+)\/members$/,
    handler: async (req, match, { system }) => {
      const name = decodeURIComponent(match[1]!)
      const room = system.rooms.getRoom(name)
      if (!room) return errorResponse(`Room "${name}" not found`, 404)
      const body = await parseBody(req)
      const agentName = body.agentName as string | undefined
      if (!agentName) return errorResponse('agentName is required')
      const agent = system.team.getAgent(agentName)
      if (!agent) return errorResponse(`Agent "${agentName}" not found`, 404)
      await system.addAgentToRoom(agent.id, room.profile.id)
      return json({ added: true, agentName: agent.name, roomName: room.profile.name })
    },
  },
  {
    method: 'DELETE',
    pattern: /^\/rooms\/([^/]+)\/members\/([^/]+)$/,
    handler: (_req, match, { system }) => {
      const rName = decodeURIComponent(match[1]!)
      const aName = decodeURIComponent(match[2]!)
      const room = system.rooms.getRoom(rName)
      if (!room) return errorResponse(`Room "${rName}" not found`, 404)
      const agent = system.team.getAgent(aName)
      if (!agent) return errorResponse(`Agent "${aName}" not found`, 404)
      system.removeAgentFromRoom(agent.id, room.profile.id)
      return json({ removed: true, agentName: agent.name, roomName: room.profile.name })
    },
  },
  {
    method: 'PUT',
    pattern: /^\/rooms\/([^/]+)\/delivery-mode$/,
    handler: async (req, match, { system }) => {
      const name = decodeURIComponent(match[1]!)
      const room = system.rooms.getRoom(name)
      if (!room) return errorResponse(`Room "${name}" not found`, 404)
      const body = await parseBody(req)
      const rawMode = body.mode as string
      if (!SETTABLE_DELIVERY_MODES.includes(rawMode as SettableDeliveryMode)) {
        return errorResponse(`Invalid mode "${rawMode}". Valid: ${SETTABLE_DELIVERY_MODES.join(', ')}`, 400)
      }
      room.setDeliveryMode(rawMode as SettableDeliveryMode)
      return json({ mode: room.deliveryMode })
    },
  },
  {
    method: 'PUT',
    pattern: /^\/rooms\/([^/]+)\/pause$/,
    handler: async (req, match, { system, workspaceId, broadcastToWorkspace }) => {
      const name = decodeURIComponent(match[1]!)
      const room = system.rooms.getRoom(name)
      if (!room) return errorResponse(`Room "${name}" not found`, 404)
      const body = await parseBody(req)
      if (typeof body.paused !== 'boolean') return errorResponse('paused must be a boolean')
      room.setPaused(body.paused)
      if (!body.paused) {
        const script = system.scriptRunner.getRun(room.profile.id)
        if (script) void system.scriptRunner.resume(room.profile.id)
      }
      const evt = { type: 'delivery_mode_changed' as const, roomName: room.profile.name, mode: room.deliveryMode, paused: room.paused }
      broadcastToWorkspace(workspaceId, evt)
      return json({ paused: room.paused })
    },
  },
  {
    method: 'PUT',
    pattern: /^\/rooms\/([^/]+)\/mute$/,
    handler: async (req, match, { system, workspaceId, broadcastToWorkspace }) => {
      const name = decodeURIComponent(match[1]!)
      const room = system.rooms.getRoom(name)
      if (!room) return errorResponse(`Room "${name}" not found`, 404)
      const body = await parseBody(req)
      if (typeof body.agentName !== 'string') return errorResponse('agentName is required')
      if (typeof body.muted !== 'boolean') return errorResponse('muted must be a boolean')
      const agent = system.team.getAgent(body.agentName)
      if (!agent) return errorResponse(`Agent "${body.agentName}" not found`, 404)
      room.setMuted(agent.id, body.muted)
      const evt = { type: 'mute_changed' as const, roomName: room.profile.name, agentName: agent.name, muted: body.muted }
      broadcastToWorkspace(workspaceId, evt)
      return json({ muted: room.isMuted(agent.id) })
    },
  },
  {
    method: 'POST',
    pattern: /^\/rooms\/([^/]+)\/agents\/([^/]+)\/activate$/,
    handler: (_req, match, { system }) => {
      const roomName = decodeURIComponent(match[1]!)
      const agentName = decodeURIComponent(match[2]!)
      const room = system.rooms.getRoom(roomName)
      if (!room) return errorResponse(`Room "${roomName}" not found`, 404)
      const agent = system.team.getAgent(agentName)
      if (!agent) return errorResponse(`Agent "${agentName}" not found`, 404)
      const result = system.activateAgentInRoom(agent.id, room.profile.id)
      return json(result, result.ok ? 200 : 400)
    },
  },
  {
    method: 'GET',
    pattern: /^\/rooms\/([^/]+)\/summary-config$/,
    handler: (_req, match, { system }) => {
      const name = decodeURIComponent(match[1]!)
      const room = system.rooms.getRoom(name)
      if (!room) return errorResponse(`Room "${name}" not found`, 404)
      return json(room.summaryConfig)
    },
  },
  {
    method: 'PUT',
    pattern: /^\/rooms\/([^/]+)\/summary-config$/,
    handler: async (req, match, { system }) => {
      const name = decodeURIComponent(match[1]!)
      const room = system.rooms.getRoom(name)
      if (!room) return errorResponse(`Room "${name}" not found`, 404)
      const body = await parseBody(req)
      // Validate at the trust boundary. The previous version did
      // `body as unknown as SummaryConfig` which TS-accepted any shape
      // and pushed failure to runtime in unpredictable places (an
      // invalid schedule.kind could silently break the scheduler).
      const result = validateSummaryConfig(body)
      if (result.ok === false) return errorResponse(result.error, 400)
      room.setSummaryConfig(result.value)
      return json(room.summaryConfig)
    },
  },
  {
    method: 'GET',
    pattern: /^\/rooms\/([^/]+)\/summary$/,
    handler: (_req, match, { system }) => {
      const name = decodeURIComponent(match[1]!)
      const room = system.rooms.getRoom(name)
      if (!room) return errorResponse(`Room "${name}" not found`, 404)
      const compression = room.getCurrentCompressionMessage()
      return json({
        summary: room.getLatestSummary() ?? null,
        compression: compression ? { id: compression.id, content: compression.content, timestamp: compression.timestamp } : null,
      })
    },
  },
  {
    method: 'POST',
    pattern: /^\/rooms\/([^/]+)\/summary\/regenerate$/,
    handler: async (req, match, { system }) => {
      const name = decodeURIComponent(match[1]!)
      const room = system.rooms.getRoom(name)
      if (!room) return errorResponse(`Room "${name}" not found`, 404)
      const body = await parseBody(req)
      const target = body.target as 'summary' | 'compression' | 'both'
      if (target !== 'summary' && target !== 'compression' && target !== 'both') {
        return errorResponse('target must be "summary", "compression", or "both"', 400)
      }
      // Fire and forget — the WS events carry progress + completion.
      void system.summaryScheduler.triggerNow(room.profile.id, target)
      return json({ triggered: target })
    },
  },
]
