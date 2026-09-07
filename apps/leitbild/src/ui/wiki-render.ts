import { marked, Renderer } from 'marked'
import {
  markdownBody,
  type KnowledgeHeading,
} from '@leitbild/knowledge/markdown'
export const escapeHtml = (s: string): string =>
  s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
export const wikiPageUrl = (path: string, revision?: string): string =>
  `/wiki?${new URLSearchParams({ path, ...(revision ? { revision } : {}) })}`
export const renderWiki = (
  document: {
    path: string
    content: string
    headings: ReadonlyArray<KnowledgeHeading>
  },
  revision?: string,
): string => {
  const renderer = new Renderer(),
    blocks = marked.lexer(markdownBody(document.content)),
    anchors = new WeakMap<object, string>()
  let index = 0
  for (const block of blocks)
    if (block.type === 'heading')
      anchors.set(block, document.headings[index++]!.anchor)
  renderer.html = ({ text }) => escapeHtml(text)
  renderer.heading = (token) =>
    `<h${token.depth}${anchors.has(token) ? ` id="${escapeHtml(anchors.get(token)!)}"` : ''}>${renderer.parser.parseInline(token.tokens)}</h${token.depth}>`
  renderer.link = ({ href, tokens }) => {
    const label = renderer.parser.parseInline(tokens)
    if (href.startsWith('source:'))
      return `<a data-source="${escapeHtml(href.slice(7))}" href="/api/knowledge/source?path=${encodeURIComponent(href.slice(7))}" title="Inspect implementation source">${label} ↗</a>`
    if (/^https?:\/\//i.test(href))
      return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${label}</a>`
    if (/^[a-z][a-z\d+.-]*:/i.test(href) || href.startsWith('//')) return label
    const target = new URL(href, `https://wiki.invalid/${document.path}`)
    return `<a href="${escapeHtml(wikiPageUrl(decodeURIComponent(target.pathname.slice(1)), revision) + target.hash)}">${label}</a>`
  }
  renderer.image = ({ href, text }) =>
    /^https:\/\//i.test(href)
      ? `<img src="${escapeHtml(href)}" alt="${escapeHtml(text)}" loading="lazy" referrerpolicy="no-referrer" />`
      : escapeHtml(text)
  renderer.code = ({ text, lang }) =>
    lang === 'mermaid'
      ? `<div class="wiki-diagram"><pre class="mermaid">${escapeHtml(text)}</pre></div>`
      : `<pre><code>${escapeHtml(text)}</code></pre>`
  return marked.parser(blocks, { renderer })
}
