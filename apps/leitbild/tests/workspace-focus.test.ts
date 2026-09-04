import { describe, expect, test } from 'bun:test'
import { newWorkspaceId, type WorkspaceSubjectReference } from '@leitbild/contracts'
import { workspaceSubjectFocusMessage } from '../src/ui/workspace-focus.ts'

describe('Workspace focus messaging', () => {
  test('detaches reactive-like proxies before crossing the iframe boundary', () => {
    const subject = new Proxy({
      workspaceId: newWorkspaceId(),
      moduleId: 'world',
      type: 'world.simulation-run',
      id: 'run-1',
    } as WorkspaceSubjectReference, {})

    expect(() => structuredClone({ type: 'leitbild:subject-focus', subjects: [subject] })).toThrow()

    const message = workspaceSubjectFocusMessage([subject])
    expect(structuredClone(message)).toEqual(message)
    expect(message.subjects[0]).not.toBe(subject)
  })
})
