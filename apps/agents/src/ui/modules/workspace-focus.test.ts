import { describe, expect, test } from 'bun:test'
import { parseWorkspaceSubjectFocusMessage } from './workspace-focus.ts'

describe('Workspace focus browser boundary', () => {
  test('accepts the strict Host message shape', () => {
    expect(parseWorkspaceSubjectFocusMessage({
      type: 'leitbild:subject-focus',
      subjects: [
        { workspaceId: 'workspace', moduleId: 'world', type: 'world.simulation-run', id: 'run' },
        { workspaceId: 'workspace', moduleId: 'world', type: 'world.scenario', id: 'scenario', revisionId: 'revision' },
      ],
    })).toEqual({
      type: 'leitbild:subject-focus',
      subjects: [
        { workspaceId: 'workspace', moduleId: 'world', type: 'world.simulation-run', id: 'run' },
        { workspaceId: 'workspace', moduleId: 'world', type: 'world.scenario', id: 'scenario', revisionId: 'revision' },
      ],
    })
    expect(parseWorkspaceSubjectFocusMessage({ type: 'leitbild:subject-focus', subjects: [] })).toEqual({
      type: 'leitbild:subject-focus', subjects: [],
    })
  })

  test('rejects malformed, foreign and extended wire shapes', () => {
    expect(parseWorkspaceSubjectFocusMessage({ type: 'other', resource: null })).toBeNull()
    expect(parseWorkspaceSubjectFocusMessage({ type: 'leitbild:subject-focus' })).toBeNull()
    expect(parseWorkspaceSubjectFocusMessage({
      type: 'leitbild:subject-focus',
      subjects: [{ workspaceId: 'workspace', moduleId: 'world', type: 'agents.room', id: 'room' }],
    })).toBeNull()
    expect(parseWorkspaceSubjectFocusMessage({ type: 'leitbild:subject-focus', subjects: [], extra: true })).toBeNull()
  })
})
