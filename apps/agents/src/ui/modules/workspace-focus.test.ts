import { describe, expect, test } from 'bun:test'
import { parseWorkspaceResourceFocusMessage } from './workspace-focus.ts'

describe('Workspace focus browser boundary', () => {
  test('accepts the strict Host message shape', () => {
    expect(parseWorkspaceResourceFocusMessage({
      type: 'leitbild:resource-focus',
      resource: { workspaceId: 'workspace', moduleId: 'world', type: 'world.simulation-run', id: 'run' },
    })).toEqual({
      type: 'leitbild:resource-focus',
      resource: { workspaceId: 'workspace', moduleId: 'world', type: 'world.simulation-run', id: 'run' },
    })
    expect(parseWorkspaceResourceFocusMessage({ type: 'leitbild:resource-focus', resource: null })).toEqual({
      type: 'leitbild:resource-focus', resource: null,
    })
  })

  test('rejects malformed, foreign and extended wire shapes', () => {
    expect(parseWorkspaceResourceFocusMessage({ type: 'other', resource: null })).toBeNull()
    expect(parseWorkspaceResourceFocusMessage({ type: 'leitbild:resource-focus' })).toBeNull()
    expect(parseWorkspaceResourceFocusMessage({
      type: 'leitbild:resource-focus',
      resource: { workspaceId: 'workspace', moduleId: 'world', type: 'agents.room', id: 'room' },
    })).toBeNull()
    expect(parseWorkspaceResourceFocusMessage({ type: 'leitbild:resource-focus', resource: null, extra: true })).toBeNull()
  })
})
