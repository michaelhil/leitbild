import {
  workspaceResourceFocusMessageSchema,
  type WorkspaceResourceReference,
} from '@leitbild/contracts'

let focusedResources: ReadonlyArray<WorkspaceResourceReference> = []

const currentWorkspaceId = (): string | null => {
  const match = location.pathname.match(/^\/workspaces\/([^/]+)\/agents(?:\/|$)/)
  return match ? decodeURIComponent(match[1] ?? '') : null
}

export const getFocusedResources = (): ReadonlyArray<WorkspaceResourceReference> => focusedResources

export const startWorkspaceFocusListener = (): (() => void) => {
  const receive = (event: MessageEvent): void => {
    if (event.origin !== location.origin || event.source !== window.parent) return
    const parsed = workspaceResourceFocusMessageSchema.safeParse(event.data)
    if (!parsed.success) return
    if (parsed.data.resource !== null && parsed.data.resource.workspaceId !== currentWorkspaceId()) return
    focusedResources = parsed.data.resource === null ? [] : [parsed.data.resource]
  }
  window.addEventListener('message', receive)
  return () => window.removeEventListener('message', receive)
}
