import { describe, expect, test } from 'bun:test'
import { workspaceSurfacePlaceMessageSchema, workspaceSurfaceSchema, WORKSPACE_SURFACE_MAX_LENGTH } from './surfaces.ts'

const workspaceId = '1e828b43-37fc-4437-aa70-302d7f442ceb'
const surface = {
  moduleId: 'world',
  subject: { workspaceId, moduleId: 'world', type: 'world.simulation-run', id: 'run-1' },
  surface: 'display:halden-unit-1',
  title: 'Halden Unit 1',
}

describe('workspace surface', () => {
  test('accepts a Module-owned surface on its own Resource', () => {
    expect(workspaceSurfaceSchema.parse(surface).surface).toBe('display:halden-unit-1')
  })

  test('rejects a subject owned by another Module', () => {
    expect(workspaceSurfaceSchema.safeParse({ ...surface, moduleId: 'agents' }).success).toBe(false)
  })

  test('rejects a string that is not <kind>:<subject>', () => {
    for (const value of ['display', 'display:', ':unit', 'Display:unit', 'display:two words', `display:${'x'.repeat(WORKSPACE_SURFACE_MAX_LENGTH)}`]) {
      expect(workspaceSurfaceSchema.safeParse({ ...surface, surface: value }).success).toBe(false)
    }
  })

  test('rejects fields it does not define', () => {
    expect(workspaceSurfaceSchema.safeParse({ ...surface, screen: 'B' }).success).toBe(false)
  })
})

describe('surface placement message', () => {
  test('carries one validated surface', () => {
    const message = workspaceSurfacePlaceMessageSchema.parse({ type: 'leitbild:surface-place', surface })
    expect(message.surface.title).toBe('Halden Unit 1')
  })

  test('rejects another message type', () => {
    expect(workspaceSurfacePlaceMessageSchema.safeParse({ type: 'leitbild:view-open', surface }).success).toBe(false)
  })
})
