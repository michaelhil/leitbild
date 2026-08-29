// Shell for the top-left "System Prompt" button: fetches Workspace settings.
// system prompt + response-format template, shows them in a modal with
// dirty-state tracking and a single Update button that PUTs back to the
// Workspace settings endpoint.

import { createModal, createTextarea, createButton, setButtonPending } from '../modals/detail-modal.ts'
import { showToast } from '../toast.ts'

export const openSystemPromptModal = async (): Promise<void> => {
  const res = await fetch('/api/workspace/settings').catch(() => null)
  if (!res || !res.ok) return
  const data = await res.json() as { workspacePrompt?: string; responseFormat?: string } | null
  if (!data) return

  const modal = createModal({ title: 'System Prompt', width: 'max-w-2xl' })

  const workspaceLabel = document.createElement('div')
  workspaceLabel.className = 'text-xs font-semibold uppercase tracking-wide mb-1 text-text-muted'
  workspaceLabel.textContent = 'Workspace Prompt'
  modal.scrollBody.appendChild(workspaceLabel)
  const workspaceArea = createTextarea(data.workspacePrompt ?? '', 6)
  modal.scrollBody.appendChild(workspaceArea)

  const formatLabel = document.createElement('div')
  formatLabel.className = 'text-xs font-semibold uppercase tracking-wide mb-1 mt-3 text-text-muted'
  formatLabel.textContent = 'Response Format'
  modal.scrollBody.appendChild(formatLabel)
  const formatArea = createTextarea(data.responseFormat ?? '', 6)
  modal.scrollBody.appendChild(formatArea)

  const btnRow = document.createElement('div')
  btnRow.className = 'flex justify-end relative w-full'
  const updateBtn = createButton({ variant: 'primary-pending', label: 'Update' })
  btnRow.appendChild(updateBtn)
  modal.footer.appendChild(btnRow)

  let savedWorkspace = workspaceArea.value
  let savedFormat = formatArea.value
  const isDirty = (): boolean =>
    workspaceArea.value !== savedWorkspace || formatArea.value !== savedFormat

  const updateStyle = (): void => {
    setButtonPending(updateBtn, !isDirty())
  }

  workspaceArea.oninput = updateStyle
  formatArea.oninput = updateStyle

  updateBtn.onclick = async () => {
    if (!isDirty()) return
    await fetch('/api/workspace/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspacePrompt: workspaceArea.value, responseFormat: formatArea.value }),
    }).catch(() => {})
    savedWorkspace = workspaceArea.value
    savedFormat = formatArea.value
    updateStyle()
    showToast(btnRow, 'Prompts updated')
  }

  document.body.appendChild(modal.overlay)
}
