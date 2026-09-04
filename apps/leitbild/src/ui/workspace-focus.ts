import {
  workspaceSubjectFocusMessageSchema,
  type WorkspaceSubjectFocusMessage,
  type WorkspaceSubjectReference,
} from '@leitbild/contracts'

/**
 * Build the cross-frame focus message at the browser boundary. Component props
 * can be Svelte deep-state proxies, which the structured-clone algorithm used
 * by postMessage cannot carry. Schema parsing also gives the receiving Module
 * a validated, detached plain object rather than leaking UI state across frames.
 */
export const workspaceSubjectFocusMessage = (
  subjects: ReadonlyArray<WorkspaceSubjectReference>,
): WorkspaceSubjectFocusMessage => workspaceSubjectFocusMessageSchema.parse({
  type: 'leitbild:subject-focus',
  subjects,
})
