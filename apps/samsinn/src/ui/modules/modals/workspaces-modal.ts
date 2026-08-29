// Settings > Workspaces. A Workspace is the stable boundary for isolated
// rooms, agents, messages, and module state. This surface deliberately offers
// create, switch, share, and reset only; deletion belongs behind a future
// authenticated administration boundary.

import { showToast } from '../toast.ts'
import { triggerReset } from '../reset-button.ts'
import { rotateSessionTokenForWorkspaceSwitch } from '../stores.ts'

interface WorkspaceRow {
  readonly id: string
  readonly displayName: string
  readonly snapshotMtimeMs: number
  readonly snapshotSizeBytes: number
  readonly isLive: boolean
}

interface WorkspaceListResponse {
  readonly workspaces: ReadonlyArray<WorkspaceRow>
  readonly currentId: string | null
}

const formatSavedAt = (timestamp: number): string => timestamp === 0
  ? 'not saved yet'
  : new Date(timestamp).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })

const formatSize = (bytes: number): string => {
  if (bytes === 0) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

const readError = async (response: Response): Promise<string> => {
  const body = await response.json().catch(() => null) as { error?: string } | null
  return body?.error ?? `Request failed (${response.status})`
}

const shareWorkspace = async (workspaceId: string): Promise<void> => {
  const url = `${window.location.origin}/?join=${encodeURIComponent(workspaceId)}`
  try {
    await navigator.clipboard.writeText(url)
    showToast(document.body, 'Workspace link copied', { type: 'success', position: 'fixed' })
  } catch {
    window.prompt('Copy this Workspace link:', url)
  }
}

const switchWorkspace = async (workspaceId: string): Promise<void> => {
  try {
    const response = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/switch`, { method: 'POST' })
    if (!response.ok) {
      showToast(document.body, await readError(response), { type: 'error', position: 'fixed' })
      return
    }
    rotateSessionTokenForWorkspaceSwitch()
    window.location.reload()
  } catch {
    showToast(document.body, 'Workspace switch failed', { type: 'error', position: 'fixed' })
  }
}

const createWorkspace = async (button: HTMLButtonElement): Promise<void> => {
  const displayName = window.prompt('Workspace name:', 'New Workspace')?.trim()
  if (!displayName) return
  button.disabled = true
  try {
    const response = await fetch('/api/workspaces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName }),
    })
    if (!response.ok) {
      showToast(document.body, await readError(response), { type: 'error', position: 'fixed' })
      return
    }
    const created = await response.json() as { id: string }
    await switchWorkspace(created.id)
  } catch {
    showToast(document.body, 'Workspace creation failed', { type: 'error', position: 'fixed' })
  } finally {
    button.disabled = false
  }
}

const buildRow = (workspace: WorkspaceRow, currentId: string | null): HTMLElement => {
  const current = workspace.id === currentId
  const row = document.createElement('div')
  row.dataset.workspaceId = workspace.id
  row.className = `flex items-center gap-3 px-3 py-2 rounded ${current ? 'bg-success-soft-bg' : 'hover:bg-surface-muted'}`

  const main = document.createElement('div')
  main.className = 'flex-1 min-w-0'
  const title = document.createElement('div')
  title.className = 'text-sm font-medium text-text-strong truncate'
  title.textContent = workspace.displayName
  if (current) {
    const marker = document.createElement('span')
    marker.className = 'ml-2 text-[10px] font-semibold uppercase text-success'
    marker.textContent = 'current'
    title.appendChild(marker)
  } else if (workspace.isLive) {
    const marker = document.createElement('span')
    marker.className = 'ml-2 text-[10px] font-semibold uppercase text-text-subtle'
    marker.textContent = 'active'
    title.appendChild(marker)
  }
  const id = document.createElement('div')
  id.className = 'font-mono text-[11px] text-text-subtle truncate'
  id.textContent = workspace.id
  const meta = document.createElement('div')
  meta.className = 'text-[11px] text-text-subtle'
  meta.textContent = `saved ${formatSavedAt(workspace.snapshotMtimeMs)} · ${formatSize(workspace.snapshotSizeBytes)}`
  main.append(title, id, meta)

  const actions = document.createElement('div')
  actions.className = 'flex items-center gap-1.5 shrink-0'
  const share = document.createElement('button')
  share.className = 'px-2 py-1 text-xs border border-border-strong rounded hover:bg-surface-muted'
  share.textContent = 'Share'
  share.onclick = () => { void shareWorkspace(workspace.id) }
  actions.appendChild(share)

  if (current) {
    const reset = document.createElement('button')
    reset.className = 'px-2 py-1 text-xs border border-danger text-danger rounded hover:bg-danger hover:text-white'
    reset.textContent = 'Reset'
    reset.title = 'Permanently clear Samsinn state in this Workspace'
    reset.onclick = () => {
      (document.getElementById('workspaces-modal') as HTMLDialogElement | null)?.close()
      void triggerReset()
    }
    actions.appendChild(reset)
  } else {
    const switchButton = document.createElement('button')
    switchButton.className = 'px-2 py-1 text-xs border border-border-strong rounded hover:bg-surface-muted'
    switchButton.textContent = 'Switch'
    switchButton.onclick = () => { void switchWorkspace(workspace.id) }
    actions.appendChild(switchButton)
  }

  row.append(main, actions)
  return row
}

const renderWorkspaces = async (list: HTMLElement): Promise<void> => {
  list.innerHTML = '<div class="text-text-subtle italic p-3">Loading…</div>'
  try {
    const response = await fetch('/api/workspaces')
    if (!response.ok) throw new Error(await readError(response))
    const data = await response.json() as WorkspaceListResponse
    list.innerHTML = ''
    if (data.workspaces.length === 0) {
      list.innerHTML = '<div class="text-text-subtle italic p-3">No Workspaces exist.</div>'
      return
    }
    for (const workspace of data.workspaces) list.appendChild(buildRow(workspace, data.currentId))
  } catch (error) {
    list.textContent = `Failed to load Workspaces: ${error instanceof Error ? error.message : String(error)}`
    list.className = 'flex-1 overflow-y-auto px-5 py-4 text-sm text-danger'
  }
}

export const openWorkspacesModal = async (): Promise<void> => {
  const dialog = document.getElementById('workspaces-modal') as HTMLDialogElement | null
  const list = document.getElementById('workspaces-list')
  const create = document.getElementById('create-workspace') as HTMLButtonElement | null
  const close = document.getElementById('close-workspaces') as HTMLButtonElement | null
  if (!dialog || !list || !create || !close) return

  create.onclick = () => { void createWorkspace(create) }
  close.onclick = () => dialog.close()
  if (!dialog.open) dialog.showModal()
  await renderWorkspaces(list)
}
