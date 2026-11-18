// Public entrypoints for mermaid rendering.
//
//   renderMermaidBlocks(container) — post-processes ```mermaid code fences
//     inside a rendered markdown container (used by chat message rendering).
//   reRenderAllMermaid() — re-renders every live mermaid node on the page
//     with the current theme (called on theme flip).
//
// Each rendered wrapper stores the normalised source on `data-mermaid-source`
// so theme re-renders can reuse it without re-walking markdown.

import { ensureMermaid, getMermaidApi, reinitMermaid, renderQueued, nextMermaidId } from './api.ts'
import { normaliseMermaidSource, MAX_MERMAID_SOURCE } from './normalise.ts'
import { showRenderFallback } from './fallback.ts'
import { addPostRenderProcessor } from '../extensions/post-render-registry.ts'
import { createMermaidViewer } from './viewer.ts'
export { setMermaidAskHandler, type MermaidAskRequest, type MermaidAskHandler } from './viewer.ts'

const viewers = new WeakMap<HTMLElement, ReturnType<typeof createMermaidViewer>>()
let removalObserver: MutationObserver | undefined
const observeRemovedViewers = (): void => {
  if (removalObserver) return
  removalObserver = new MutationObserver(records => {
    for (const record of records) for (const removed of record.removedNodes) {
      if (!(removed instanceof HTMLElement) || removed.isConnected) continue
      const candidates = [removed, ...removed.querySelectorAll<HTMLElement>('[data-mermaid-viewer]')]
      for (const candidate of candidates) if (!candidate.isConnected) viewers.get(candidate)?.dispose()
    }
  })
  removalObserver.observe(document.body, { childList: true, subtree: true })
}

const renderSource = async (rawSource: string): Promise<{ source: string; svg: string }> => {
  if (isOversized(rawSource)) throw new Error('The source exceeds the diagram rendering limit.')
  const source = normaliseMermaidSource(rawSource)
  if (isOversized(source)) throw new Error('The normalized source exceeds the diagram rendering limit.')
  const api = await ensureMermaid()
  if (!api) throw new Error('Diagram rendering is unavailable. Reload the page to try again.')
  const { svg } = await renderQueued(api, nextMermaidId(), source)
  return { source, svg }
}

// Size check, single source of truth for "should we bother rendering?"
const isOversized = (source: string): boolean => source.length > MAX_MERMAID_SOURCE

// Build a rendered-wrapper element from a mermaid SVG string.
const buildRenderedWrapper = (svg: string, source: string, rawSource: string, messageId: string | undefined, blockIndex: number): HTMLElement => {
  const viewer = createMermaidViewer({ rawSource, source, svg, messageId, blockIndex, renderSource })
  viewer.element.dataset.mermaidViewer = ''
  viewers.set(viewer.element, viewer)
  observeRemovedViewers()
  return viewer.element
}

export const renderMermaidBlocks = async (container: HTMLElement): Promise<void> => {
  const blocks = container.querySelectorAll('code.language-mermaid')
  if (blocks.length === 0) return

  const api = await ensureMermaid()

  for (const [blockIndex, block] of Array.from(blocks).entries()) {
    const pre = block.parentElement
    if (!pre) continue
    const rawSource = block.textContent ?? ''

    const wrapper = document.createElement('div')
    wrapper.setAttribute('data-mermaid-source', rawSource)

    if (!api) {
      showRenderFallback(wrapper, rawSource, 'unavailable')
      pre.replaceWith(wrapper)
      continue
    }

    if (isOversized(rawSource)) {
      showRenderFallback(wrapper, rawSource, 'too-large')
      pre.replaceWith(wrapper)
      continue
    }

    const source = normaliseMermaidSource(rawSource)
    if (isOversized(source)) {
      showRenderFallback(wrapper, rawSource, 'too-large')
      pre.replaceWith(wrapper)
      continue
    }
    const id = nextMermaidId('mermaid')
    try {
      const { svg } = await renderQueued(api, id, source)
      // A Room switch or message deletion can remove the original fence while
      // it waits in the render queue. Intentionally drop that stale result
      // before creating a viewer with observers that could never be removed.
      if (!pre.isConnected) continue
      const marker = (block as HTMLElement).dataset.mermaidIndex
      const sourceIndex = marker !== undefined && /^\d+$/.test(marker) && Number.isSafeInteger(Number(marker)) ? Number(marker) : undefined
      // Only the markdown renderer can establish a source-fence index. Raw HTML
      // code blocks may render, but cannot safely address an Agent modification.
      const messageId = sourceIndex === undefined ? undefined : container.closest<HTMLElement>('[data-msg-id]')?.dataset.msgId ?? container.dataset.diagramMessageId
      pre.replaceWith(buildRenderedWrapper(svg, source, rawSource, messageId, sourceIndex ?? blockIndex))
    } catch (error) {
      showRenderFallback(wrapper, rawSource, 'render-failed', error)
      pre.replaceWith(wrapper)
    }
  }
}

// Self-register at module-load time. Order = first-registered wins; mermaid
// is imported before map in render-message.ts so it lands first in the
// registry, preserving the prior const-array order.
addPostRenderProcessor('mermaid', renderMermaidBlocks)

// Re-render every live mermaid diagram with the current theme. Runs in
// parallel — serial rendering was noticeable flicker for pages with many
// diagrams.
export const reRenderAllMermaid = async (): Promise<void> => {
  const api = getMermaidApi()
  if (!api) return
  reinitMermaid()

  const nodes = [...document.querySelectorAll<HTMLElement>('[data-mermaid-source]')]
  await Promise.all(nodes.map(async (node) => {
    const viewer = viewers.get(node)
    if (viewer) { await viewer.retheme(); return }
    const source = node.getAttribute('data-mermaid-source') ?? ''
    if (!source) return
    if (isOversized(source)) return // An oversized fallback remains source, including after a theme change.
    try {
      const id = nextMermaidId('mermaid-retheme')
      const normalized = normaliseMermaidSource(source)
      if (isOversized(normalized)) return
      const { svg } = await renderQueued(api, id, normalized)
      node.innerHTML = svg
    } catch {
      // Keep the old render if re-parse fails.
    }
  }))
}
