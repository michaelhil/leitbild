import {
  perspectiveAdmissionSchema, worldPerspectiveReferenceSchema, workspaceResourceReferenceSchema,
  type PerspectiveAdmission, type WorldPerspectiveReference,
  type PresentationRecipient, type PresentationReceipt,
} from '@leitbild/contracts'
import { presentationOutputs } from '../core/guides/wire.ts'
import { invokeWorld } from './workspace-capability-client.ts'

/** One human World screen's captured roles. No model argument or mutable global selects these. */
export const createPerspectiveOwnerClient = (config: { workspaceId: string; runId: string; roleIds: ReadonlyArray<string> }) => {
  const roleIds = [...config.roleIds]
  const options = (resource: WorldPerspectiveReference) => ({ workspaceId: config.workspaceId, resource: worldPerspectiveReferenceSchema.parse(resource) })
  const presentation = async (resource: WorldPerspectiveReference, kind: string, input: Record<string, unknown>): Promise<unknown> =>
    await invokeWorld(`world.perspective.presentation.${kind}`, { ...input, roleIds }, options(resource))
  return {
    prepare: async (requestId: string): Promise<PerspectiveAdmission> => perspectiveAdmissionSchema.parse(await invokeWorld('world.perspective.prepare', { requestId, roleIds }, { workspaceId: config.workspaceId, resource: workspaceResourceReferenceSchema.parse({ workspaceId: config.workspaceId, moduleId: 'world', type: 'world.simulation-run', id: config.runId }) })),
    read: async (resource: WorldPerspectiveReference): Promise<PerspectiveAdmission> => perspectiveAdmissionSchema.parse(await invokeWorld('world.perspective.read', { roleIds }, options(resource))),
    revoke: async (resource: WorldPerspectiveReference, expectedRevision: number, reason: string): Promise<PerspectiveAdmission> => perspectiveAdmissionSchema.parse(await invokeWorld('world.perspective.revoke', { expectedRevision, reason, roleIds }, options(resource))),
    register: async (resource: WorldPerspectiveReference) => presentationOutputs.register.parse(await presentation(resource, 'register', { clientId: crypto.randomUUID(), documentId: crypto.randomUUID() })),
    poll: async (resource: WorldPerspectiveReference, recipient: PresentationRecipient) => presentationOutputs.poll.parse(await presentation(resource, 'poll', { recipient })),
    receipt: async (resource: WorldPerspectiveReference, recipient: PresentationRecipient, receipt: PresentationReceipt) => await presentation(resource, 'receipt', { recipient, receipt }),
    unregister: async (resource: WorldPerspectiveReference, recipient: PresentationRecipient) => await presentation(resource, 'unregister', { recipient }),
  }
}
export type PerspectiveOwnerClient = ReturnType<typeof createPerspectiveOwnerClient>
