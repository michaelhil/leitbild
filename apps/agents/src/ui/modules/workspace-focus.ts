// Browser modules are transpiled individually rather than bundled. Keep this
// small wire validator local so the browser never receives a bare monorepo
// package import that it cannot resolve.
export interface WorkspaceSubjectReference {
  readonly workspaceId: string
  readonly moduleId: string
  readonly type: string
  readonly id: string
  readonly revisionId?: string
}

interface WorkspaceSubjectFocusMessage {
  readonly type: 'leitbild:subject-focus'
  readonly subjects: ReadonlyArray<WorkspaceSubjectReference>
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export const parseWorkspaceSubjectFocusMessage = (value: unknown): WorkspaceSubjectFocusMessage | null => {
  if (!isRecord(value) || value.type !== 'leitbild:subject-focus' || Object.keys(value).length !== 2 || !Array.isArray(value.subjects) || value.subjects.length > 4) return null
  const subjects: WorkspaceSubjectReference[] = []
  for (const raw of value.subjects) {
    if (!isRecord(raw)) return null
    const { workspaceId, moduleId, type, id, revisionId } = raw
    if (![workspaceId, moduleId, type, id].every(item => typeof item === 'string' && item.length > 0)) return null
    if (!(type as string).startsWith(`${moduleId as string}.`)) return null
    if (revisionId === undefined) {
      if (Object.keys(raw).length !== 4) return null
    } else if (typeof revisionId !== 'string' || revisionId.length === 0 || Object.keys(raw).length !== 5) return null
    subjects.push({ workspaceId, moduleId, type, id, ...(revisionId === undefined ? {} : { revisionId }) } as WorkspaceSubjectReference)
  }
  return { type: 'leitbild:subject-focus', subjects }
}

let focusedSubjects: ReadonlyArray<WorkspaceSubjectReference> = []

const currentWorkspaceId = (): string | null => {
  const match = location.pathname.match(/^\/workspaces\/([^/]+)\/agents(?:\/|$)/)
  return match ? decodeURIComponent(match[1] ?? '') : null
}

export const getFocusedSubjects = (): ReadonlyArray<WorkspaceSubjectReference> => focusedSubjects

export const startWorkspaceFocusListener = (): (() => void) => {
  const receive = (event: MessageEvent): void => {
    if (event.origin !== location.origin || event.source !== window.parent) return
    const parsed = parseWorkspaceSubjectFocusMessage(event.data)
    if (!parsed || parsed.subjects.some(subject => subject.workspaceId !== currentWorkspaceId())) return
    focusedSubjects = parsed.subjects
  }
  window.addEventListener('message', receive)
  return () => window.removeEventListener('message', receive)
}
