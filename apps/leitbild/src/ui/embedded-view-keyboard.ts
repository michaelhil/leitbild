/**
 * Keyboard events in an embedded document do not bubble to the Host dialog.
 * Let an unhandled Escape close it, after the owner's document handlers. An
 * owner-native modal keeps its own Escape. Each load replaces the listener;
 * removing the iframe removes it too.
 */
export const closeEmbeddedViewOnEscape = (frame: HTMLIFrameElement, close: () => void): { destroy: () => void } => {
  let documentListener: AbortController | null = null

  const loaded = (): void => {
    documentListener?.abort()
    documentListener = null
    const document = frame.contentDocument
    const child = frame.contentWindow
    // The Host frames same-origin owner routes; another origin cannot relay keys.
    if (document === null || child === null) return
    const controller = new AbortController()
    documentListener = controller
    const modalEscapes = new WeakSet<KeyboardEvent>()
    // An owner's key handler may close its own dialog before the bubble phase.
    // That Escape still belongs to the dialog that had it at capture time.
    child.addEventListener('keydown', event => {
      if (event.key === 'Escape' && frame.contentDocument === document && document.querySelector('dialog:modal') !== null) modalEscapes.add(event)
    }, { capture: true, signal: controller.signal })
    child.addEventListener('keydown', event => {
      if (frame.contentDocument !== document || event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return
      if (modalEscapes.has(event) || document.querySelector('dialog:modal') !== null) return
      event.preventDefault()
      close()
    }, { signal: controller.signal })
  }

  frame.addEventListener('load', loaded)
  loaded()
  return {
    destroy: () => {
      frame.removeEventListener('load', loaded)
      documentListener?.abort()
      documentListener = null
    },
  }
}
