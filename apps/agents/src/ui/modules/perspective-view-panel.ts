import { perspectiveView } from './perspective-view.ts'
import type { RoomProfile } from './render/render-types.ts'

export const mountPerspectiveViewPanel = (deps: {
  readonly form: HTMLFormElement
  readonly input: HTMLTextAreaElement
  readonly room: () => RoomProfile | undefined
  readonly connected: () => boolean
  readonly resume: () => void
}) => {
  if (!perspectiveView.privateIntent) return { refresh: () => {} }
  document.body.classList.add('perspective-room-view')
  const panel = document.createElement('section')
  panel.className = 'mx-3 my-2 p-3 rounded border border-border bg-surface-muted text-sm'
  panel.setAttribute('aria-label', 'Exercise Assistant scope')
  const title = document.createElement('strong')
  title.textContent = 'Exercise perspective · observation and attention'
  const status = document.createElement('p')
  status.setAttribute('role', 'status')
  const note = document.createElement('p')
  note.className = 'text-xs text-text-muted'
  note.textContent = 'This Assistant belongs to this exercise perspective. Configuration, shared writes and rich embedded displays are unavailable in this pilot.'
  const details = document.createElement('details'), summary = document.createElement('summary'), identity = document.createElement('pre')
  summary.textContent = 'Scope details'; identity.className = 'text-xs whitespace-pre-wrap'
  details.append(summary, identity); panel.append(title, status, note, details)
  const rail = document.getElementById('chat-and-rail')
  if (rail !== null) rail.before(panel); else deps.form.before(panel)
  let lastReady = ''
  const refresh = () => {
    const state = perspectiveView.status(), lease = perspectiveView.current(), room = deps.room()
    const label = state === 'connected' ? 'Connected' : state === 'connecting' ? 'Connecting' : state === 'expired' ? 'View expired' : 'View unavailable'
    status.textContent = state === 'expired' || state === 'unavailable'
      ? `${label}. Drafts stay only in this document. Copy unsent text before reconnecting or changing scope. Retained history is locked after revocation.`
      : `${label}. Send as yourself; the Assistant can read this view and offer attention cues.`
    identity.textContent = lease === undefined ? 'No admitted view.' : `Perspective: ${lease.perspective.id}\nConversation: ${lease.room.id}\nTemplate: ${room?.perspective?.admission.templateId ?? 'awaiting Room snapshot'}\nTemplate revision: ${room?.perspective?.admission.templateRevision ?? 'awaiting Room snapshot'}`
    const send = deps.form.querySelector<HTMLButtonElement>('button[type="submit"]')
    if (send !== null) send.disabled = lease === undefined || !deps.connected() || !perspectiveView.canSubmit(room?.id ?? '')
    if (lease !== undefined && room?.id === lease.room.id) deps.input.disabled = false // Keep unsent text editable/copyable while sending is locked.
    if (state !== 'connected') lastReady = ''
    if (state === 'connected' && lease !== undefined && room?.id === lease.room.id
      && room.perspective?.admission.status === 'bound' && room.perspective.admission.perspective.id === lease.perspective.id) {
      const ready = `${lease.documentId}:${lease.token}:${perspectiveView.deliveryVersion()}:${room.perspective.admission.revision}`
      if (ready !== lastReady && window.parent !== window) {
        lastReady = ready
        window.parent.postMessage({ type: 'leitbild:perspective-view-ready', room: lease.room, perspective: lease.perspective, documentId: lease.documentId }, location.origin)
      }
    }
  }
  perspectiveView.subscribe(() => { refresh(); if (perspectiveView.status() === 'connecting') deps.resume() })
  const timer = setInterval(refresh, 1_000)
  window.addEventListener('pagehide', () => clearInterval(timer), { once: true })
  refresh()
  return { refresh }
}
