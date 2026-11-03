import { z } from 'zod'
import {
  agentsPerspectiveRoomPrepareInputSchema, agentsPerspectiveRoomBindInputSchema, agentsPerspectiveRoomRevokeInputSchema,
  agentsPerspectiveRoomAdmissionSchema, perspectiveViewLeaseSchema, type ModuleCapabilityInvocation,
} from '@leitbild/contracts'
import type { CapabilityRegistration } from '@leitbild/module-runtime'
import type { AgentsWorkspaceRuntime } from '../workspace-runtime.ts'

const empty = z.object({}).strict()
const viewOpen = z.object({ expectedRevision: z.number().int().nonnegative(), documentId: z.string().uuid() }).strict()
const viewClose = z.object({ token: z.string().uuid(), documentId: z.string().uuid() }).strict()
const refuse = (): never => { throw Object.assign(new Error('This admission operation requires its narrow internal owner port'), { code: 'perspective_owner_required' }) }
const requireOwner = (invocation: ModuleCapabilityInvocation, modules: ReadonlyArray<'host' | 'world' | 'agents'>) => {
  const origin = invocation.access.perspectiveOrigin
  if (origin?.kind !== 'owner' || !modules.includes(origin.moduleId)
    || invocation.access.actor.kind !== 'system' || invocation.access.actor.id !== origin.moduleId) refuse()
}

export const perspectiveRoomCapabilities = <Context extends { readonly runtime: AgentsWorkspaceRuntime }>(): ReadonlyArray<CapabilityRegistration<Context, Response>> => {
  const specs = [
    { name: 'prepare', input: agentsPerspectiveRoomPrepareInputSchema, workspace: true, query: false, owners: ['host'] },
    { name: 'read', input: empty, workspace: false, query: true, owners: ['host', 'world', 'agents'] },
    { name: 'bind', input: agentsPerspectiveRoomBindInputSchema, workspace: false, query: false, owners: ['host'] },
    { name: 'revoke', input: agentsPerspectiveRoomRevokeInputSchema, workspace: false, query: false, owners: ['host', 'world'] },
    { name: 'view-open', input: viewOpen, workspace: false, query: false, owners: ['host'] },
    { name: 'view-close', input: viewClose, workspace: false, query: false, owners: ['host'] },
  ] as const
  return specs.map(spec => ({
    descriptor: {
      id: `agents.perspective-room.${spec.name}`, moduleId: 'agents', kind: spec.query ? 'query' : 'command',
      scope: spec.workspace ? { kind: 'workspace' } : { kind: 'resource', resourceType: 'agents.room' },
      title: `Perspective Room ${spec.name}`,
      description: 'Narrow internal admission owner port. Public actor attribution, Room IDs and presentation offers do not grant access. Admission requires the explicit operator policy for this exact dedicated Workspace.',
      risk: spec.query ? 'read' : 'write', idempotent: spec.name === 'read' || spec.name === 'prepare' || spec.name === 'view-close',
      inputSchema: z.toJSONSchema(spec.input),
      outputSchema: spec.name === 'view-open' ? z.toJSONSchema(perspectiveViewLeaseSchema) : spec.name === 'view-close' ? { type: 'object' } : z.toJSONSchema(agentsPerspectiveRoomAdmissionSchema),
    },
    invoke: async ({ runtime }, invocation) => {
      requireOwner(invocation, spec.owners)
      if (runtime.perspectiveRooms === undefined) return Response.json({ error: { code: 'perspective_pilot_disabled', message: 'Perspective runtime assembly is unavailable' } }, { status: 403 })
      try {
        let result: unknown
        switch (spec.name) {
          case 'prepare': result = await runtime.perspectiveRooms.prepare(spec.input.parse(invocation.input)); break
          case 'read': empty.parse(invocation.input); result = runtime.perspectiveRooms.read(invocation.resource!.id); break
          case 'bind': { const input = agentsPerspectiveRoomBindInputSchema.parse(invocation.input); result = await runtime.perspectiveRooms.bind(invocation.resource!.id, input.expectedRevision); break }
          case 'revoke': { const input = agentsPerspectiveRoomRevokeInputSchema.parse(invocation.input); result = await runtime.perspectiveRooms.revoke(invocation.resource!.id, input.expectedRevision, input.reason); break }
          case 'view-open': { const input = viewOpen.parse(invocation.input); result = await runtime.perspectiveRooms.viewOpen(invocation.resource!.id, input.expectedRevision, input.documentId); break }
          case 'view-close': { const input = viewClose.parse(invocation.input); runtime.perspectiveRooms.viewClose(input.token, input.documentId); result = { closed: true }; break }
        }
        return Response.json({ result })
      } catch (error) {
        const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : undefined
        if (code?.startsWith('perspective_')) return Response.json({ error: { code, message: error instanceof Error ? error.message : code,
          ...(error && typeof error === 'object' && 'details' in error ? { details: error.details } : {}) } }, { status: code.includes('outcome_unknown') || code === 'perspective_authority_unavailable' ? 503 : code.includes('conflict') ? 409 : 403 })
        throw error
      }
    },
  }))
}
