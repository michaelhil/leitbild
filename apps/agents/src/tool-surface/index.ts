import type { Tool, ToolDefinition, ToolRegistry } from '../core/types/tool.ts'
import { owningPackFor } from '../core/types/tool-pack.ts'
import { toolsToDefinitions } from '../llm/tool-capability.ts'
import { effectiveActivePackSet } from '../packs/activation.ts'
import { isPerspectiveScope } from '../core/rooms/perspective-scope.ts'

export interface RoomActivation {
  readonly getActivePacks: () => ReadonlyArray<string>
  readonly profile?: { readonly scope: import('@leitbild/contracts').WorkspaceRoomScope }
}
export type GetRoomActivation = (roomId: string) => RoomActivation | undefined

// Exact native tools retain their schemas and use one execution path.
// Visibility never creates additional execution authority.
export const createToolSurface = (deps: {
  readonly registry: ToolRegistry
  readonly requestedTools: ReadonlyArray<string>
  readonly getRoomActivation?: GetRoomActivation
}) => {
  const buildCandidates = (roomId: string | undefined): ReadonlySet<string> => {
    const room = roomId === undefined ? undefined : deps.getRoomActivation?.(roomId)
    if (roomId !== undefined && deps.getRoomActivation !== undefined && room === undefined) return new Set()
    const active = room ? effectiveActivePackSet(room) : undefined
    return new Set(deps.requestedTools.filter(name => {
      const entry = deps.registry.getEntry(name)
      if (!entry) return false
      if (room?.profile !== undefined && isPerspectiveScope(room.profile.scope) && entry.tool.compartmentAccess === undefined) return false
      const pack = owningPackFor(entry)
      return pack === undefined || active === undefined || active.has(pack)
    }))
  }
  return {
    buildCandidates,
    project: (roomId: string | undefined): ReadonlyArray<ToolDefinition> => {
      const tools: Tool[] = []
      for (const name of buildCandidates(roomId)) {
        const tool = deps.registry.get(name)
        if (tool) tools.push(tool) // Removed contributions intentionally disappear.
      }
      return toolsToDefinitions(tools)
    },
  }
}

export { inferProviderFromModelRef } from './model-provider.ts'
