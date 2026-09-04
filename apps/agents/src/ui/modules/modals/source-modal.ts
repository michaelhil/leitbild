import {
  findProductSourceReferences,
  parseProductSourceReference,
  type ProductSourceLineRange,
  type ProductSourceReference,
} from '../../../core/product-source-reference.ts'
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

const formatLineRanges = (ranges: ReadonlyArray<ProductSourceLineRange>): string =>
  ranges.map(range => range.endLine === range.startLine
    ? String(range.startLine)
    : `${range.startLine}–${range.endLine}`).join(', ')

const sourceTitle = (reference: ProductSourceReference): string => {
  if (reference.lineRanges.length === 0) return reference.path
  return `${reference.path} · ${reference.lineRanges.length === 1 && reference.lineRanges[0]!.startLine === reference.lineRanges[0]!.endLine ? 'line' : 'lines'} ${formatLineRanges(reference.lineRanges)}`
}

const createSourceView = (
  content: string,
  requestedRanges: ReadonlyArray<ProductSourceLineRange>,
): { readonly pre: HTMLPreElement; readonly focus?: HTMLElement; readonly rangeOutsideRevision: boolean } => {
  const pre = document.createElement('pre')
  pre.className = 'text-xs font-mono whitespace-pre overflow-auto rounded border border-border bg-surface-raised p-3 text-text'
  pre.style.maxHeight = '68vh'
  if (requestedRanges.length === 0) {
    pre.textContent = content
    return { pre, rangeOutsideRevision: false }
  }
  const lines = content.split(/\r?\n/)
  const ranges = requestedRanges
    .filter(range => range.startLine <= lines.length)
    .map(range => ({ startLine: range.startLine, endLine: Math.min(range.endLine, lines.length) }))
  let cursor = 0
  let focus: HTMLElement | undefined
  for (const range of ranges) {
    const startIndex = range.startLine - 1
    const endIndex = range.endLine
    if (startIndex > cursor) pre.appendChild(document.createTextNode(`${lines.slice(cursor, startIndex).join('\n')}\n`))
    const mark = document.createElement('mark')
    mark.className = 'bg-accent/15 text-text'
    mark.textContent = lines.slice(startIndex, endIndex).join('\n') + (endIndex < lines.length ? '\n' : '')
    pre.appendChild(mark)
    focus ??= mark
    cursor = endIndex
  }
  if (cursor < lines.length) pre.appendChild(document.createTextNode(lines.slice(cursor).join('\n')))
  return {
    pre,
    ...(focus ? { focus } : {}),
    rangeOutsideRevision: ranges.length !== requestedRanges.length
      || requestedRanges.some(range => range.endLine > lines.length),
  }
}

export const openProductSourceModal = async (reference: ProductSourceReference): Promise<void> => {
  const source = await safeFetchJson<ProductSourceDocument>(
    `/product-source?path=${encodeURIComponent(reference.path)}`,
  )
  if (!source) {
    showToast(document.body, `Source unavailable: ${reference.path}`, { type: 'error', position: 'fixed' })
    return
  }
  const resolvedReference = { ...reference, path: source.path }
  const modal = createModal({ title: sourceTitle(resolvedReference), width: 'max-w-5xl' })
  const meta = document.createElement('div')
  meta.className = 'text-xs text-text-subtle mb-3'
  meta.textContent = `${source.kind} · ${source.authority} · ${source.totalLines.toLocaleString()} lines · ${source.revision}`
  modal.scrollBody.appendChild(meta)
  const view = createSourceView(source.content, reference.lineRanges)
  if (view.rangeOutsideRevision) {
    const warning = document.createElement('div')
    warning.className = 'text-xs text-warning mb-3'
    warning.textContent = 'Some cited lines are outside this deployed revision; the available lines are highlighted.'
    modal.scrollBody.appendChild(warning)
  }
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

const createReferenceButton = (reference: ProductSourceReference): HTMLButtonElement => {
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
  return button
}

const replaceReferenceElement = (element: HTMLElement, reference: ProductSourceReference): void => {
  const button = createReferenceButton(reference)
  element.replaceWith(button)
}

const decorateBareTextReferences = (root: HTMLElement): void => {
  const referencesByNode = new Map<Text, ReturnType<typeof findProductSourceReferences>>()
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!(node instanceof Text)) continue
    const parent = node.parentElement
    if (!parent || parent.closest('a, button, code, pre, script, style')) continue
    const references = findProductSourceReferences(node.data)
    if (references.length > 0) referencesByNode.set(node, references)
  }
  for (const [node, references] of referencesByNode) {
    const fragment = document.createDocumentFragment()
    let cursor = 0
    for (const reference of references) {
      if (reference.startIndex > cursor) fragment.appendChild(document.createTextNode(node.data.slice(cursor, reference.startIndex)))
      fragment.appendChild(createReferenceButton(reference))
      cursor = reference.endIndex
    }
    if (cursor < node.data.length) fragment.appendChild(document.createTextNode(node.data.slice(cursor)))
    node.replaceWith(fragment)
  }
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
      ?? parseProductSourceReference(anchor.getAttribute('href') ?? '')
    if (reference) replaceReferenceElement(anchor, reference)
  }
  decorateBareTextReferences(root)
  compactCitationParentheses(root)
}
