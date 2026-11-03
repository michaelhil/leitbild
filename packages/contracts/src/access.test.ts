import { expect, test } from 'bun:test'
import { accessContextSchema } from './access.ts'
import { workspaceCapabilityInvocationRequestSchema } from './resources.ts'

test('retired runtime-origin claims are rejected at both invocation boundaries', () => {
  const access = {
    workspaceId: '11111111-1111-4111-8111-111111111111',
    requestId: '22222222-2222-4222-8222-222222222222',
    actor: { kind: 'ai', id: 'actual-agent' },
  }
  expect(accessContextSchema.safeParse(access).success).toBe(true)
  const perspectiveOrigin = { kind: 'owner', moduleId: 'host' }
  expect(accessContextSchema.safeParse({ ...access, perspectiveOrigin }).success).toBe(false)
  expect(workspaceCapabilityInvocationRequestSchema.safeParse({ input: {}, actor: access.actor }).success).toBe(true)
  expect(workspaceCapabilityInvocationRequestSchema.safeParse({ input: {}, actor: access.actor, perspectiveOrigin }).success).toBe(false)
})
