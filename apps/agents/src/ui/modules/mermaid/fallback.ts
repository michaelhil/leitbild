// Fallback UI for mermaid render failures. Used by both the inline chat
// renderer and the artifact renderer so the visual is consistent.
//
// Built with createElement + textContent rather than innerHTML so future
// edits can't accidentally introduce an XSS hole by concatenating source
// into a template literal.

import { truncateForDisplay } from './normalise.ts'

export type FallbackReason = 'render-failed' | 'too-large' | 'unavailable'

const REASON_TEXT: Record<FallbackReason, string> = {
  'render-failed': "Diagram couldn't render — showing source.",
  'too-large': 'Diagram source exceeds the rendering limit — showing the full source.',
  'unavailable': 'Diagram rendering unavailable. Reload the page to try again.',
}

export const showRenderFallback = (
  el: HTMLElement,
  source: string,
  reason: FallbackReason = 'render-failed',
  error?: unknown,
): void => {
  // Clear existing content.
  el.replaceChildren()
  el.className = 'my-2 text-xs border border-border rounded p-2 bg-surface-muted'
  el.setAttribute('role', 'alert')
  el.setAttribute('aria-label', 'Diagram rendering failed')

  const notice = document.createElement('div')
  notice.className = 'text-text-muted whitespace-pre-wrap mb-1'
  // Actual parser/limit messages help the author repair the source. Keep only
  // the message, never a stack or HTML, and retain the complete source below.
  const detail = error instanceof Error ? error.message : typeof error === 'string' ? error : undefined
  notice.textContent = reason === 'render-failed' && detail ? `${REASON_TEXT[reason]}\n${detail}` : REASON_TEXT[reason]
  el.appendChild(notice)

  if (source) {
    const pre = document.createElement('pre')
    pre.className = 'whitespace-pre-wrap text-text font-mono text-[11px]'
    pre.textContent = truncateForDisplay(source)
    el.appendChild(pre)
  }
}
