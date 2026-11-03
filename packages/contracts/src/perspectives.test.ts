import { expect, test } from 'bun:test'
import { accessContextSchema } from './access.ts'
import { workspaceCapabilityInvocationRequestSchema } from './resources.ts'
import { agentsPerspectiveRoomAdmissionSchema, perspectiveAdmissionSchema, perspectiveRuntimeBindingSchema, perspectivePrepareInputSchema, perspectivePilotPolicySchema } from './perspectives.ts'

test('pilot deployment policy is strict, immutable and selects one existing Workspace explicitly', () => {
  const ids = [crypto.randomUUID()]
  const parsed = perspectivePilotPolicySchema.parse({ enabled: true, workspaceIds: ids })
  ids[0] = crypto.randomUUID()
  expect(parsed.workspaceIds).not.toEqual(ids)
  expect(Object.isFrozen(parsed)).toBe(true)
  expect(Object.isFrozen(parsed.workspaceIds)).toBe(true)
  expect(perspectivePilotPolicySchema.safeParse({ enabled: true, workspaceIds: [] }).success).toBe(false)
  expect(perspectivePilotPolicySchema.safeParse({ enabled: true, workspaceIds: [crypto.randomUUID(), crypto.randomUUID()] }).success).toBe(false)
  expect(perspectivePilotPolicySchema.safeParse({ enabled: true, workspaceIds: ['*'] }).success).toBe(false)
  expect(perspectivePilotPolicySchema.safeParse({ enabled: true, workspaceIds: ids, roleIds: ['controller'] }).success).toBe(false)
  expect(perspectivePilotPolicySchema.parse({ enabled: false, workspaceIds: ids }).enabled).toBe(false)
})

const workspaceId = '0e87af46-37b1-4ffa-a654-eb2a28de09a3'
const generation = '90c45f17-2b5b-4c21-b76d-d65b4b65c803'
const perspective = { workspaceId, moduleId: 'world', type: 'world.perspective', id: 'perspective-one' }
const binding = { perspective, admissionGeneration: generation, room: { workspaceId, moduleId: 'agents', type: 'agents.room', id: 'room-one' }, actualAgentId: 'agent:actual', runtimeGeneration: '1cbfa203-7f6a-4e50-96a8-d19fc00aa7cc', templateId: 'template:one', templateRevision: 'template-revision:one' }
const admission = { resource: perspective, status: 'pending', revision: 0, admissionGeneration: generation, runIncarnation: '8fd29354-0a8c-43e2-bd32-0b683f2ad07b', roleSetDigest: 'a'.repeat(64), createdAt: '2026-11-02T12:00:00.000Z', updatedAt: '2026-11-02T12:00:00.000Z' }

test('Perspective admissions keep pending non-callable and bind one exact same-Workspace runtime relationship', () => {
  expect(perspectiveAdmissionSchema.safeParse(admission).success).toBe(true)
  expect(perspectiveAdmissionSchema.safeParse({ ...admission, binding }).success).toBe(false)
  expect(perspectiveAdmissionSchema.safeParse({ ...admission, status: 'active' }).success).toBe(false)
  expect(perspectiveAdmissionSchema.safeParse({ ...admission, status: 'active', binding }).success).toBe(true)
  expect(perspectiveAdmissionSchema.safeParse({ ...admission, status: 'active', binding: { ...binding, admissionGeneration: crypto.randomUUID() } }).success).toBe(false)
  expect(perspectiveRuntimeBindingSchema.safeParse({ ...binding, room: { ...binding.room, workspaceId: crypto.randomUUID() } }).success).toBe(false)
  expect(perspectiveAdmissionSchema.safeParse({ ...admission, runId: 'hidden-canonical-run' }).success).toBe(false)
  expect(agentsPerspectiveRoomAdmissionSchema.safeParse({ ...binding, status: 'prepared', revision: 0, createdAt: admission.createdAt, updatedAt: admission.updatedAt }).success).toBe(true)
  expect(perspectivePrepareInputSchema.safeParse({ roleIds: ['blue', 'blue'], requestId: generation }).success).toBe(false)
})

test('Perspective origin is a narrow internal context, never a public caller-supplied authority field', () => {
  const perspectiveOrigin = { kind: 'execution', roomId: 'room-one', actualAgentId: binding.actualAgentId, runtimeGeneration: binding.runtimeGeneration, turnId: 'turn:one', perspectiveId: perspective.id, admissionGeneration: generation }
  const access = { workspaceId, requestId: crypto.randomUUID(), actor: { kind: 'ai', id: binding.actualAgentId }, perspectiveOrigin }
  expect(accessContextSchema.safeParse(access).success).toBe(true)
  expect(accessContextSchema.safeParse({ ...access, perspectiveOrigin: { ...perspectiveOrigin, roleIds: ['controller'] } }).success).toBe(false)
  expect(workspaceCapabilityInvocationRequestSchema.safeParse({ resource: perspective, input: {}, perspectiveOrigin }).success).toBe(false)
  expect(workspaceCapabilityInvocationRequestSchema.safeParse({ resource: perspective, input: {}, access }).success).toBe(false)
  expect(accessContextSchema.safeParse({ ...access, perspectiveOrigin: { kind: 'owner', moduleId: 'other' } }).success).toBe(false)
})
