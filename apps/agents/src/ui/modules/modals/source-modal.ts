import { parseProductSourceReference } from '../../../core/product-source-reference.ts'
import { icon } from '../icon.ts'
import { safeFetchJson } from '../fetch-helpers.ts'
import { showToast } from '../toast.ts'
import { createModal } from './detail-modal.ts'

interface ProductSourceDocument {
  readonly path: string
  readonly kind: 'documentation' | 'source'
  readonly authority: 'implementation' | 'decision' | 'domain-language' | 'documentation'
  readonly revision: string
  readonly content: string
  readonly totalLines: number
}

type ProductSourceReference = NonNullable<ReturnType<typeof parseProductSourceReference>>

const sourceTitle = (reference: ProductSourceReference): string => {
  if (reference.startLine === undefined) return reference.path
  const range = reference.endLine && reference.endLine !== reference.startLine
    ? `${reference.startLine}–${reference.endLine}`
    : String(reference.startLine)
  return `${reference.path} · line ${range}`
}

const createSourceView = (
  content: string,
  startLine?: number,
  endLine?: number,
): { readonly pre: HTMLPreElement; readonly focus?: HTMLElement } => {
  const pre = document.createElement('pre')
  pre.className = 'text-xs font-mono whitespace-pre overflow-auto rounded border border-border bg-surface-raised p-3 text-text'
  pre.style.maxHeight = '68vh'
  if (startLine === undefined) {
    pre.textContent = content
    return { pre }
  }
  const lines = content.split(/\r?\n/)
  const startIndex = Math.min(lines.length, Math.max(0, startLine - 1))
  const endIndex = Math.min(lines.length, Math.max(startIndex + 1, endLine ?? startLine))
  const before = document.createTextNode(lines.slice(0, startIndex).join('\n') + (startIndex > 0 ? '\n' : ''))
  const focus = document.createElement('mark')
  focus.className = 'bg-accent/15 text-text'
  focus.textContent = lines.slice(startIndex, endIndex).join('\n')
  const after = document.createTextNode((endIndex < lines.length ? '\n' : '') + lines.slice(endIndex).join('\n'))
  pre.append(before, focus, after)
  return { pre, focus }
}

export const openProductSourceModal = async (reference: ProductSourceReference): Promise<void> => {
  const source = await safeFetchJson<ProductSourceDocument>(
    `/product-source?path=${encodeURIComponent(reference.path)}`,
  )
  if (!source) {
    showToast(document.body, `Source unavailable: ${reference.path}`, { type: 'error', position: 'fixed' })
    return
  }
  const modal = createModal({ title: sourceTitle(reference), width: 'max-w-5xl' })
  const meta = document.createElement('div')
  meta.className = 'text-xs text-text-subtle mb-3'
  meta.textContent = `${source.kind} · ${source.authority} · ${source.totalLines.toLocaleString()} lines · ${source.revision}`
  modal.scrollBody.appendChild(meta)
  const view = createSourceView(source.content, reference.startLine, reference.endLine)
  modal.scrollBody.appendChild(view.pre)

  const copy = document.createElement('button')
  copy.className = 'btn btn-ghost'
  copy.textContent = 'Copy source'
  copy.onclick = async () => {
    try {
      await navigator.clipboard.writeText(source.content)
      showToast(document.body, 'Source copied', { type: 'success', position: 'fixed' })
    } catch {
      showToast(document.body, 'Copy failed — clipboard unavailable', { type: 'error', position: 'fixed' })
    }
  }
  modal.footer.appendChild(copy)
  document.body.appendChild(modal.overlay)
  if (view.focus) requestAnimationFrame(() => view.focus?.scrollIntoView({ block: 'center' }))
}

const replaceReferenceElement = (element: HTMLElement, reference: ProductSourceReference): void => {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'inline-flex align-middle text-text-subtle hover:text-accent mx-0.5'
  button.title = `Open source · ${sourceTitle(reference)}`
  button.setAttribute('aria-label', button.title)
  button.dataset.productSourceReference = reference.path
  button.appendChild(icon('link', { size: 13 }))
  button.onclick = (event) => {
    event.preventDefault()
    event.stopPropagation()
    void openProductSourceModal(reference)
  }
  element.replaceWith(button)
}

const compactCitationParentheses = (root: HTMLElement): void => {
  for (const first of root.querySelectorAll<HTMLButtonElement>('[data-product-source-reference]')) {
    const previous = first.previousSibling
    if (!(previous instanceof Text) || !/\(\s*$/.test(previous.data)) continue
    previous.data = previous.data.replace(/\(\s*$/, '')
    let cursor: ChildNode | null = first.nextSibling
    while (cursor) {
      if (cursor instanceof HTMLElement && cursor.dataset.productSourceReference) {
        cursor = cursor.nextSibling
        continue
      }
      if (!(cursor instanceof Text)) break
      if (/^\s*,\s*$/.test(cursor.data)) {
        cursor.data = ' '
        cursor = cursor.nextSibling
        continue
      }
      if (/^\s*\)/.test(cursor.data)) cursor.data = cursor.data.replace(/^\s*\)/, '')
      break
    }
  }
}

// All agent messages share this post-render pass. It recognizes only paths
// from the allowlisted product corpus, leaving ordinary code spans and web
// links untouched. That makes source citations compact without introducing
// a second, agent-specific response format.
export const decorateProductSourceReferences = (root: HTMLElement): void => {
  for (const code of root.querySelectorAll<HTMLElement>('code')) {
    if (code.closest('pre')) continue
    const reference = parseProductSourceReference(code.textContent ?? '')
    if (reference) replaceReferenceElement(code.closest('a') ?? code, reference)
  }
  for (const anchor of root.querySelectorAll<HTMLAnchorElement>('a')) {
    if (!root.contains(anchor)) continue
    const reference = parseProductSourceReference(anchor.textContent ?? '')
    if (reference) replaceReferenceElement(anchor, reference)
  }
  compactCitationParentheses(root)
}
