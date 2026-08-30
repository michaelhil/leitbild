import { apiFetch } from '../api-client.ts'
import { createModal } from '../modals/detail-modal.ts'
import { showToast } from '../toast.ts'
import { $selectedRoomId, $selectedAgentId, $rooms, $agents, $roomMembers, $selectedHumanByRoom } from '../stores.ts'
import { icon } from '../icon.ts'
import {
  getDemo,
  type DemoDefinition,
  type PromptDeckEntry,
} from '../../../core/definitions/demo-catalog.ts'
import { $activeDemoByRoom } from './active-demo-store.ts'

const parseErrorResponse = async (response: Response): Promise<string> => {
  try {
    const body = await response.json() as { error?: unknown }
    return typeof body.error === 'string' ? body.error : `HTTP ${response.status}`
  } catch {
    return `HTTP ${response.status}`
  }
}

const applyDemoDefinition = async (demo: DemoDefinition): Promise<string | undefined> => {
  try {
    const response = await apiFetch(`/demos/${encodeURIComponent(demo.id)}/apply`, {
      method: 'POST',
      credentials: 'same-origin',
    })
    if (!response.ok) throw new Error(await parseErrorResponse(response))
    const applied = await response.json() as {
      room: { id: string; name: string }
      human: { id: string; name: string }
      agents: ReadonlyArray<{ id: string; name: string }>
    }
    $rooms.setKey(applied.room.id, applied.room)
    $agents.setKey(applied.human.id, { ...applied.human, kind: 'human', state: 'idle' })
    for (const agent of applied.agents) {
      $agents.setKey(agent.id, { ...agent, kind: 'ai', state: 'idle' })
    }
    $roomMembers.setKey(applied.room.id, [applied.human.id, ...applied.agents.map(agent => agent.id)])
    $selectedHumanByRoom.setKey(applied.room.id, applied.human.id)
    $selectedAgentId.set(null)
    $selectedRoomId.set(applied.room.id)
    return applied.room.id
  } catch (error) {
    showToast(document.body, `Could not apply demo: ${error instanceof Error ? error.message : String(error)}`, {
      type: 'error', position: 'fixed', durationMs: 10000,
    })
    return undefined
  }
}

const runEntry = async (demo: DemoDefinition, entry: PromptDeckEntry): Promise<boolean> => {
  const roomId = $selectedRoomId.get()
  if (!roomId) return false
  try {
    const response = await apiFetch(
      `/demos/${encodeURIComponent(demo.id)}/rooms/${encodeURIComponent(roomId)}/entries/${encodeURIComponent(entry.id)}/run`,
      { method: 'POST', credentials: 'same-origin' },
    )
    if (!response.ok) throw new Error(await parseErrorResponse(response))
    const detail = entry.action.kind === 'start-script'
      ? 'Script started. Follow its living document in the right rail.'
      : entry.action.pauseAfterMs !== undefined
        ? `Discussion started and will pause after ${Math.round(entry.action.pauseAfterMs / 1000)} seconds.`
        : 'Prompt posted.'
    showToast(document.body, detail, { type: 'success', position: 'fixed', durationMs: 8000 })
    return true
  } catch (error) {
    showToast(document.body, `Could not run demo action: ${error instanceof Error ? error.message : String(error)}`, {
      type: 'error', position: 'fixed', durationMs: 10000,
    })
    return false
  }
}

const buildPromptRow = (
  demo: DemoDefinition,
  entry: PromptDeckEntry,
  onRan: () => void,
): HTMLButtonElement => {
  const button = document.createElement('button')
  button.className = 'w-full text-left px-3 py-2 mb-2 rounded border border-border bg-surface hover:bg-surface-strong'
  button.title = entry.description
  const label = document.createElement('div')
  label.className = 'text-sm font-semibold text-text'
  label.textContent = entry.label
  const description = document.createElement('div')
  description.className = 'text-xs text-text-subtle mt-0.5'
  description.textContent = entry.description
  button.append(label, description)
  button.addEventListener('click', async () => {
    button.disabled = true
    button.classList.add('opacity-60', 'cursor-wait')
    if (await runEntry(demo, entry)) onRan()
    else {
      button.disabled = false
      button.classList.remove('opacity-60', 'cursor-wait')
    }
  })
  return button
}

export const openDemoModal = async (
  demoId: string,
  options: { readonly reuseCurrentRoom?: boolean } = {},
): Promise<void> => {
  const demo = getDemo(demoId)
  if (!demo) {
    showToast(document.body, `Unknown demo: ${demoId}`, { type: 'error', position: 'fixed' })
    return
  }
  let roomId = $selectedRoomId.get()
  if (!options.reuseCurrentRoom) roomId = await applyDemoDefinition(demo)
  if (!roomId) {
    showToast(document.body, 'The demo room is no longer available.', { type: 'error', position: 'fixed' })
    return
  }
  $activeDemoByRoom.setKey(roomId, demo.id)

  const modal = createModal({ title: demo.title, width: 'max-w-2xl' })
  const blurb = document.createElement('p')
  blurb.className = 'text-sm text-text mb-3'
  blurb.textContent = demo.blurb
  modal.scrollBody.appendChild(blurb)
  const hint = document.createElement('div')
  hint.className = 'text-xs text-text-subtle mb-2'
  hint.textContent = 'Choose an action from this demo’s Prompt Deck:'
  modal.scrollBody.appendChild(hint)
  for (const entry of demo.deck.entries) {
    modal.scrollBody.appendChild(buildPromptRow(demo, entry, () => modal.close()))
  }
  document.body.appendChild(modal.overlay)
}

const HEADER_ICON_ID = 'demo-header-icon'

const buildHeaderIcon = (demo?: DemoDefinition): HTMLButtonElement => {
  const button = document.createElement('button')
  button.id = HEADER_ICON_ID
  button.setAttribute('data-room-icon-id', 'demo')
  button.setAttribute('data-room-icon-label', 'Demo')
  button.className = 'mode-btn icon-btn'
  button.dataset.demoId = demo?.id ?? ''
  const title = demo ? `Open ${demo.title}` : 'Browse demos'
  button.title = title
  button.setAttribute('aria-label', title)
  button.appendChild(icon('wand', { size: 16, title }))
  button.addEventListener('click', () => {
    if (demo) void openDemoModal(demo.id, { reuseCurrentRoom: true })
    else void import('./index.ts').then(module => module.openDemosNavPicker())
  })
  return button
}

export const refreshDemoHeaderIcon = (): void => {
  const roomId = $selectedRoomId.get()
  const cluster = document.querySelector('#room-header > div:nth-child(2)') as HTMLElement | null
  if (!cluster) return
  const groupId = `${HEADER_ICON_ID}-group`
  const existingGroup = document.getElementById(groupId)
  if (!roomId) { existingGroup?.remove(); return }
  const demoId = $activeDemoByRoom.get()[roomId]
  const demo = demoId ? getDemo(demoId) : undefined
  const existingButton = existingGroup?.querySelector(`#${HEADER_ICON_ID}`) as HTMLButtonElement | null
  if (existingButton?.dataset.demoId === (demo?.id ?? '')) return
  existingGroup?.remove()
  const group = document.createElement('div')
  group.className = 'toolbar-group toolbar-divider'
  group.id = groupId
  group.appendChild(buildHeaderIcon(demo))
  cluster.appendChild(group)
}
