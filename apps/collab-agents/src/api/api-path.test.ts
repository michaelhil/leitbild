import { describe, expect, test } from 'bun:test'
import { workspaceIdSchema } from '@leitbild/contracts'
import { resolveApplicationApiPath } from './api-path.ts'

const workspaceId = workspaceIdSchema.parse('9d2bd146-dc4a-4cbf-9754-f966884c5ca9')

describe('canonical application API paths', () => {
  test('resolves a Workspace path to an internal application path', () => {
    expect(resolveApplicationApiPath(`/api/workspaces/${workspaceId}/collab/rooms`)).toEqual({
      kind: 'workspace',
      workspaceId,
      moduleId: 'collab',
      internalPath: '/rooms',
    })
  })

  test('resolves the Workspace realtime endpoint', () => {
    expect(resolveApplicationApiPath(`/api/workspaces/${workspaceId}/agents/ws`)).toEqual({
      kind: 'workspace',
      workspaceId,
      moduleId: 'agents',
      internalPath: '/ws',
    })
  })

  test('rejects unscoped application routes instead of aliasing them', () => {
    expect(resolveApplicationApiPath('/api/rooms')).toEqual({
      kind: 'invalid-api',
      code: 'route_not_found',
      message: 'Use a Workspace-scoped API route',
    })
  })

  test('rejects malformed Workspace ids', () => {
    expect(resolveApplicationApiPath('/api/workspaces/not-a-uuid/collab/rooms')).toEqual({
      kind: 'invalid-api',
      code: 'invalid_workspace_id',
      message: 'Invalid Workspace id',
    })
  })

  test('leaves non-API paths alone', () => {
    expect(resolveApplicationApiPath('/')).toEqual({ kind: 'not-api' })
  })
})
