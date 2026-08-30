import { apiFetch } from './api-client.ts'
import { icon } from './icon.ts'
import { createModal } from './modals/detail-modal.ts'
import { $rooms, $selectedRoomId } from './stores.ts'
import { showToast } from './toast.ts'

interface PromptDeckEntry {
  readonly id: string
  readonly label: string
  readonly description: string
  readonly action: { readonly kind: 'post-message'; readonly pauseAfterMs?: number } | { readonly kind: 'start-script' }
}

interface PromptDeckResponse {
  readonly definition: {
    readonly id: string
    readonly revisionId: string
    readonly title: string
    readonly description: string
  }
  readonly promptDeck: {
    readonly id: string
    readonly entries: ReadonlyArray<PromptDeckEntry>
  }
}

const HEADER_GROUP_ID = 'prompt-deck-header-group'

const loadPromptDeck = async (roomId: string): Promise<PromptDeckResponse | null> => {
  const response = await apiFetch(`/rooms/${encodeURIComponent(roomId)}/prompt-deck`, {
    credentials: 'same-origin',
  })
  if (response.status === 404) return null
  if (!response.ok) throw new Error(`Prompt Deck request failed: HTTP ${response.status}`)
  return await response.json() as PromptDeckResponse
}

const runEntry = async (roomId: string, entry: PromptDeckEntry): Promise<boolean> => {
  try {
    const response = await apiFetch(
      `/rooms/${encodeURIComponent(roomId)}/prompt-deck/${encodeURIComponent(entry.id)}/run`,
      { method: 'POST', credentials: 'same-origin' },
    )
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const detail = entry.action.kind === 'start-script'
      ? 'Script started.'
      : entry.action.pauseAfterMs === undefined
        ? 'Prompt posted.'
        : `Discussion started and will pause after ${Math.round(entry.action.pauseAfterMs / 1000)} seconds.`
    showToast(document.body, detail, { type: 'success', position: 'fixed', durationMs: 8000 })
    return true
  } catch (error) {
    showToast(document.body, `Prompt Deck action failed: ${error instanceof Error ? error.message : String(error)}`, {
      type: 'error', position: 'fixed', durationMs: 10000,
    })
    return false
  }
}

const openPromptDeck = async (roomId: string): Promise<void> => {
  const loaded = await loadPromptDeck(roomId)
  if (!loaded) return
  const modal = createModal({ title: loaded.definition.title, width: 'max-w-2xl' })
  const description = document.createElement('p')
  description.className = 'text-sm text-text mb-3'
  description.textContent = loaded.definition.description
  modal.scrollBody.appendChild(description)
  for (const entry of loaded.promptDeck.entries) {
    const button = document.createElement('button')
    button.className = 'w-full text-left px-3 py-2 mb-2 rounded border border-border bg-surface hover:bg-surface-strong'
    button.title = entry.description
    const label = document.createElement('div')
    label.className = 'text-sm font-semibold text-text'
    label.textContent = entry.label
    const detail = document.createElement('div')
    detail.className = 'text-xs text-text-subtle mt-0.5'
    detail.textContent = entry.description
    button.append(label, detail)
    button.addEventListener('click', async () => {
      button.disabled = true
      if (await runEntry(roomId, entry)) modal.close()
      else button.disabled = false
    })
    modal.scrollBody.appendChild(button)
  }
  document.body.appendChild(modal.overlay)
}

const refreshHeader = async (): Promise<void> => {
  const selectedRoomId = $selectedRoomId.get()
  const previous = document.getElementById(HEADER_GROUP_ID)
  previous?.remove()
  if (!selectedRoomId) return
  const loaded = await loadPromptDeck(selectedRoomId)
  if (!loaded || $selectedRoomId.get() !== selectedRoomId) return
  const cluster = document.querySelector('#room-header > div:nth-child(2)') as HTMLElement | null
  if (!cluster) return
  const group = document.createElement('div')
  group.id = HEADER_GROUP_ID
  group.className = 'toolbar-group toolbar-divider'
  const button = document.createElement('button')
  button.className = 'mode-btn icon-btn'
  button.title = `Open ${loaded.definition.title}`
  button.setAttribute('aria-label', button.title)
  button.appendChild(icon('wand', { size: 16, title: button.title }))
  button.addEventListener('click', () => { void openPromptDeck(selectedRoomId) })
  group.appendChild(button)
  cluster.appendChild(group)
}

export const initPromptDeck = (): void => {
  const requestedRoomId = new URL(location.href).searchParams.get('room')
  let selectedRequestedRoom = false
  $rooms.listen(rooms => {
    if (selectedRequestedRoom || !requestedRoomId || !rooms[requestedRoomId]) return
    selectedRequestedRoom = true
    $selectedRoomId.set(requestedRoomId)
  })
  $selectedRoomId.listen(roomId => {
    if (roomId) {
      const url = new URL(location.href)
      url.searchParams.set('room', roomId)
      history.replaceState(null, '', url)
    }
    void refreshHeader().catch(error => {
      showToast(document.body, error instanceof Error ? error.message : String(error), { type: 'error', position: 'fixed' })
    })
  })
}
