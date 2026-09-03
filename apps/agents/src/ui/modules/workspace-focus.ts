// Browser modules are transpiled individually rather than bundled. Keep this
// small wire validator local so the browser never receives a bare monorepo
// package import that it cannot resolve.
export interface WorkspaceResourceReference {
  readonly workspaceId: string
  readonly moduleId: string
  readonly type: string
  readonly id: string
}

interface WorkspaceResourceFocusMessage {
  readonly type: 'leitbild:resource-focus'
  readonly resource: WorkspaceResourceReference | null
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export const parseWorkspaceResourceFocusMessage = (value: unknown): WorkspaceResourceFocusMessage | null => {
  if (!isRecord(value) || value.type !== 'leitbild:resource-focus' || !('resource' in value)) return null
  if (value.resource === null) return Object.keys(value).length === 2
    ? { type: 'leitbild:resource-focus', resource: null }
    : null
  if (!isRecord(value.resource) || Object.keys(value).length !== 2 || Object.keys(value.resource).length !== 4) return null
  const { workspaceId, moduleId, type, id } = value.resource
  if (![workspaceId, moduleId, type, id].every(item => typeof item === 'string' && item.length > 0)) return null
  if (!(type as string).startsWith(`${moduleId as string}.`)) return null
  return {
    type: 'leitbild:resource-focus',
    resource: { workspaceId, moduleId, type, id } as WorkspaceResourceReference,
  }
}

let focusedResources: ReadonlyArray<WorkspaceResourceReference> = []

const currentWorkspaceId = (): string | null => {
  const match = location.pathname.match(/^\/workspaces\/([^/]+)\/agents(?:\/|$)/)
  return match ? decodeURIComponent(match[1] ?? '') : null
}

export const getFocusedResources = (): ReadonlyArray<WorkspaceResourceReference> => focusedResources

export const startWorkspaceFocusListener = (): (() => void) => {
  const receive = (event: MessageEvent): void => {
    if (event.origin !== location.origin || event.source !== window.parent) return
    const parsed = parseWorkspaceResourceFocusMessage(event.data)
    if (!parsed) return
    if (parsed.resource !== null && parsed.resource.workspaceId !== currentWorkspaceId()) return
    focusedResources = parsed.resource === null ? [] : [parsed.resource]
  }
  window.addEventListener('message', receive)
  return () => window.removeEventListener('message', receive)
}
