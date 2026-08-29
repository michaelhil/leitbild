import { apiFetch } from "../api-client.ts"
// Right-rail script panel: immutable source above, live run status below.
//
// Visible only when a script is active in the selected room. Renders the
// The source pane always shows the original script.md. Runtime dialogue never
// enters that pane; it is summarized in the status pane below it.
//
// Width persists in localStorage. Hidden by default; user can dismiss via
// the close button (the chip in the room header still flags an active run).

import { $activeScriptByRoom, $selectedRoomId } from '../stores.ts'
import { domRefs } from '../app-dom.ts'
import { buildScriptStatusSnapshot } from './script-status.ts'

const STORAGE_WIDTH_KEY = 'leitbild:script-doc-width'
const STORAGE_HIDDEN_KEY = 'leitbild:script-doc-hidden'
const DEFAULT_WIDTH = 360
const MIN_WIDTH = 240
const MAX_WIDTH = 720

let dismissed = false
const sourceCache = new Map<string, string>()

const readWidth = (): number => {
  const raw = localStorage.getItem(STORAGE_WIDTH_KEY)
  const n = raw ? parseInt(raw, 10) : NaN
  if (!Number.isFinite(n)) return DEFAULT_WIDTH
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, n))
}

const writeWidth = (px: number): void => {
  localStorage.setItem(STORAGE_WIDTH_KEY, String(Math.round(px)))
}

const readDismissed = (): boolean => localStorage.getItem(STORAGE_HIDDEN_KEY) === '1'
const writeDismissed = (v: boolean): void => {
  if (v) localStorage.setItem(STORAGE_HIDDEN_KEY, '1')
  else localStorage.removeItem(STORAGE_HIDDEN_KEY)
}

const setVisible = (visible: boolean): void => {
  const { scriptDocRail, scriptDocResize } = domRefs
  if (visible) {
    scriptDocRail.classList.remove('hidden')
    scriptDocRail.classList.add('flex')
    scriptDocResize.classList.remove('hidden')
  } else {
    scriptDocRail.classList.add('hidden')
    scriptDocRail.classList.remove('flex')
    scriptDocResize.classList.add('hidden')
  }
}

const fetchSource = async (scriptName: string): Promise<string> => {
  const cached = sourceCache.get(scriptName)
  if (cached !== undefined) return cached
  try {
    const res = await apiFetch(`/scripts/${encodeURIComponent(scriptName)}`)
    if (res.ok) {
      const data = await res.json() as { source?: unknown }
      if (typeof data.source === 'string') {
        sourceCache.set(scriptName, data.source)
        return data.source
      }
    }
  } catch { /* source pane keeps a visible fallback */ }
  return '(script source unavailable)'
}

const renderStatus = (active: import('../stores.ts').ActiveScript): void => {
  const root = domRefs.scriptDocStatus
  root.replaceChildren()
  const snapshot = buildScriptStatusSnapshot(active)
  const heading = document.createElement('div')
  heading.className = 'font-semibold text-text-strong mb-2'
  heading.textContent = snapshot.complete
    ? `Complete · ${active.totalSteps} steps`
    : `Step ${active.stepIndex + 1}/${active.totalSteps} · ${snapshot.stepTitle}`
  root.appendChild(heading)

  if (snapshot.goal) {
    const goal = document.createElement('div')
    goal.className = 'text-text-muted mb-2'
    goal.textContent = snapshot.goal
    root.appendChild(goal)
  }

  const table = document.createElement('div')
  table.className = 'border border-border rounded overflow-hidden'
  for (const rowInfo of snapshot.rows) {
    const row = document.createElement('div')
    row.className = 'grid grid-cols-[1fr_auto_auto] items-center gap-2 px-2 py-1.5 border-b border-border last:border-b-0'

    const name = document.createElement('div')
    name.className = 'min-w-0 truncate font-medium'
    name.textContent = rowInfo.name
    name.title = rowInfo.name

    const utterances = document.createElement('div')
    utterances.className = 'text-text-muted whitespace-nowrap'
    utterances.textContent = `${rowInfo.utterances} utterance${rowInfo.utterances === 1 ? '' : 's'}`

    const state = document.createElement('div')
    state.className = rowInfo.ready ? 'text-emerald-500 whitespace-nowrap' : 'text-amber-500 whitespace-nowrap'
    state.textContent = rowInfo.ready
      ? (active.ended ? 'complete' : `ready${rowInfo.readyStreak > 1 ? ` · ${rowInfo.readyStreak}×` : ''}`)
      : 'not ready'

    row.append(name, utterances, state)
    table.appendChild(row)
  }
  root.appendChild(table)

  if (active.whisperFailures > 0) {
    const warning = document.createElement('div')
    warning.className = 'mt-2 text-amber-500'
    warning.textContent = `${active.whisperFailures} whisper classification failure${active.whisperFailures === 1 ? '' : 's'}`
    root.appendChild(warning)
  }
}

const fetchAndPaint = async (): Promise<void> => {
  const roomId = $selectedRoomId.get()
  if (!roomId) return
  const active = $activeScriptByRoom.get()[roomId]
  if (!active) return
  renderStatus(active)
  const source = await fetchSource(active.scriptName)
  const current = $activeScriptByRoom.get()[roomId]
  if (current?.scriptName === active.scriptName) domRefs.scriptDocBody.textContent = source
}

const refreshVisibility = (): void => {
  const roomId = $selectedRoomId.get()
  const active = roomId ? $activeScriptByRoom.get()[roomId] : undefined
  const shouldShow = !!active && !dismissed
  setVisible(shouldShow)
  if (shouldShow) void fetchAndPaint()
}

const initResize = (): void => {
  const { scriptDocRail, scriptDocResize } = domRefs
  scriptDocRail.style.width = readWidth() + 'px'

  let dragging = false
  let startX = 0
  let startW = 0

  const onMove = (e: MouseEvent): void => {
    if (!dragging) return
    const dx = startX - e.clientX
    const next = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startW + dx))
    scriptDocRail.style.width = next + 'px'
  }
  const onUp = (): void => {
    if (!dragging) return
    dragging = false
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
    const w = parseInt(scriptDocRail.style.width, 10)
    if (Number.isFinite(w)) writeWidth(w)
  }

  scriptDocResize.addEventListener('mousedown', (e) => {
    dragging = true
    startX = e.clientX
    startW = scriptDocRail.getBoundingClientRect().width
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    e.preventDefault()
  })
  window.addEventListener('mousemove', onMove)
  window.addEventListener('mouseup', onUp)
}

export const initScriptDocPanel = (): void => {
  dismissed = readDismissed()
  initResize()

  domRefs.btnScriptDocClose.onclick = () => {
    dismissed = true
    writeDismissed(true)
    setVisible(false)
  }
  $activeScriptByRoom.listen(() => {
    // A new script run resets the dismissed flag — opening the panel for
    // the new script. (Closing it dismisses for THAT run, not forever.)
    const roomId = $selectedRoomId.get()
    const active = roomId ? $activeScriptByRoom.get()[roomId] : undefined
    if (active) {
      dismissed = readDismissed()
    }
    refreshVisibility()
  })
  $selectedRoomId.listen(refreshVisibility)
  refreshVisibility()
}

// Allow the room-header chip to re-open the rail after dismissal.
export const showScriptDocPanel = (): void => {
  dismissed = false
  writeDismissed(false)
  refreshVisibility()
}
