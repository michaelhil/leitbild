// Which embedded views run live. Each live view polls its Module and keeps a
// Run active, so only the newest view in the conversation (plus one the reader
// explicitly chose) is live; older ones collapse to cards. A live view mounts
// its frame only while on screen and unmounts after leaving it for a while.
import type { EmbeddedViewEnvelope } from '@leitbild/contracts'
import { embeddedViewFragment, embeddedViewPath } from '@leitbild/contracts/embedded-view-route'

// Long enough to scroll past and back without reloading the view, short
// enough that a view scrolled out of sight stops polling soon.
const OFFSCREEN_UNMOUNT_MS = 30_000
const SWEEP_MS = 2_000

interface ViewSlot {
  readonly wrapper: HTMLElement
  readonly body: HTMLElement
  readonly envelope: EmbeddedViewEnvelope
  readonly observer: IntersectionObserver
  mode: 'card' | 'live'
  visible: boolean
  frame: HTMLIFrameElement | null
  offscreenTimer: ReturnType<typeof setTimeout> | undefined
}

const slots = new Map<HTMLElement, ViewSlot>()
let chosen: HTMLElement | null = null
let sweepTimer: ReturnType<typeof setInterval> | undefined

const frameFor = (envelope: EmbeddedViewEnvelope): HTMLIFrameElement => {
  const frame = document.createElement('iframe')
  frame.src = embeddedViewPath(envelope) + embeddedViewFragment(envelope)
  frame.title = `Live display: ${envelope.title}`
  frame.style.cssText = `display:block;width:100%;height:${envelope.height}px;border:0;`
  // The chat page may hold camera permission for biometrics; a view never gets it.
  frame.setAttribute('allow', "camera 'none'; microphone 'none'; geolocation 'none'; display-capture 'none'")
  frame.setAttribute('referrerpolicy', 'same-origin')
  return frame
}

const unmountFrame = (slot: ViewSlot): void => {
  clearTimeout(slot.offscreenTimer)
  slot.offscreenTimer = undefined
  slot.frame?.remove()
  slot.frame = null
}

const mountFrame = (slot: ViewSlot): void => {
  clearTimeout(slot.offscreenTimer)
  slot.offscreenTimer = undefined
  if (slot.frame !== null) return
  slot.frame = frameFor(slot.envelope)
  slot.body.replaceChildren(slot.frame)
}

const showCard = (slot: ViewSlot): void => {
  unmountFrame(slot)
  slot.body.style.height = ''
  const card = document.createElement('div')
  card.className = 'flex items-center gap-3 px-3 py-2 text-xs text-text-muted'
  const label = document.createElement('span')
  label.className = 'flex-1 min-w-0 truncate'
  label.textContent = `Earlier display: ${slot.envelope.title}`
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'px-2 py-1 rounded border border-border text-text'
  button.textContent = 'Show live'
  button.onclick = () => { chosen = slot.wrapper; refreshLiveViews() }
  card.append(label, button)
  slot.body.replaceChildren(card)
}

const showLive = (slot: ViewSlot): void => {
  // Reserve the height before the frame loads so the conversation does not jump.
  slot.body.style.height = `${slot.envelope.height}px`
  slot.body.replaceChildren()
  if (slot.visible) mountFrame(slot)
}

const onVisibility = (slot: ViewSlot, visible: boolean): void => {
  slot.visible = visible
  if (slot.mode !== 'live') return
  if (visible) { mountFrame(slot); return }
  if (slot.frame !== null && slot.offscreenTimer === undefined) {
    slot.offscreenTimer = setTimeout(() => unmountFrame(slot), OFFSCREEN_UNMOUNT_MS)
  }
}

const release = (slot: ViewSlot): void => {
  slot.observer.disconnect()
  unmountFrame(slot)
  slots.delete(slot.wrapper)
  if (chosen === slot.wrapper) chosen = null
}

export const refreshLiveViews = (): void => {
  for (const slot of [...slots.values()]) if (!slot.wrapper.isConnected) release(slot)
  const ordered = [...slots.values()].sort((left, right) =>
    left.wrapper.compareDocumentPosition(right.wrapper) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1)
  const newest = ordered.at(-1)?.wrapper
  for (const slot of ordered) {
    const mode = slot.wrapper === newest || slot.wrapper === chosen ? 'live' : 'card'
    if (mode === slot.mode) continue
    slot.mode = mode
    if (mode === 'card') showCard(slot)
    else showLive(slot)
  }
  if (slots.size === 0) { clearInterval(sweepTimer); sweepTimer = undefined }
  else if (sweepTimer === undefined) sweepTimer = setInterval(refreshLiveViews, SWEEP_MS)
}

/** `body` is the element inside `wrapper` that the view's card or frame replaces. */
export const registerLiveView = (wrapper: HTMLElement, body: HTMLElement, envelope: EmbeddedViewEnvelope): void => {
  const slot: ViewSlot = {
    wrapper,
    body,
    envelope,
    mode: 'card',
    visible: false,
    frame: null,
    offscreenTimer: undefined,
    observer: new IntersectionObserver(entries => {
      for (const entry of entries) onVisibility(slot, entry.isIntersecting)
    }),
  }
  slots.set(wrapper, slot)
  showCard(slot)
  slot.observer.observe(wrapper)
  refreshLiveViews()
}
