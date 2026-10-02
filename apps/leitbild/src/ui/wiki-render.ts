import { marked, Renderer } from 'marked'
import { isProcedureMarkdown, parseProcedure } from '@leitbild/procmd'
import { renderProcedurePage } from './wiki-procedure.ts'
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
  procedures: ReadonlyArray<{ readonly path: string; readonly procedureId?: string; readonly headings?: ReadonlyArray<KnowledgeHeading> }> = [],
): string => {
  const renderer = new Renderer(),
    blocks = marked.lexer(markdownBody(document.content)),
    anchors = new WeakMap<object, string>()
  const procedure = isProcedureMarkdown(document.content) ? parseProcedure(document.content) : undefined
  let insideLink = false
  let index = 0
  for (const block of blocks)
    if (block.type === 'heading')
      anchors.set(block, document.headings[index++]!.anchor)
  renderer.html = ({ text }) => /^\s*<!--(?:(?!-->)[\s\S])*-->\s*$/.test(text) ? '' : escapeHtml(text)
  renderer.heading = (token) =>
    `<h${token.depth}${anchors.has(token) ? ` id="${escapeHtml(anchors.get(token)!)}"` : ''}>${renderer.parser.parseInline(token.tokens)}</h${token.depth}>`
  renderer.link = ({ href, tokens }) => {
    // An already authored link owns its label; never insert nested tag links.
    const previous = insideLink
    insideLink = true
    let label: string
    try { label = renderer.parser.parseInline(tokens) } finally { insideLink = previous }
    if (href.startsWith('source:'))
      return `<a data-source="${escapeHtml(href.slice(7))}" href="/api/knowledge/source?path=${encodeURIComponent(href.slice(7))}" title="Inspect implementation source">${label} ↗</a>`
    if (/^https?:\/\//i.test(href))
      return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${label}</a>`
    if (/^[a-z][a-z\d+.-]*:/i.test(href) || href.startsWith('//')) return label
    const target = new URL(href, `https://wiki.invalid/${document.path}`)
    return `<a href="${escapeHtml(wikiPageUrl(decodeURIComponent(target.pathname.slice(1)), revision) + target.hash)}">${label}</a>`
  }
  const renderText = renderer.text.bind(renderer)
  renderer.text = token => {
    const html = renderText(token)
    if (!procedure || insideLink || ('tokens' in token && token.tokens)) return html
    // Markdown's lexer excludes code spans, code blocks and existing links here.
    // Resolve exact authored identities, never guessed filename conventions.
    return html.replace(/«([A-Za-z0-9][A-Za-z0-9._/-]*)»/g, (raw, id: string) => {
      const tag = procedure.tags.find(candidate => candidate.id === id)
      if (!tag?.source || /[\s<>]/.test(tag.source)) return raw
      return renderer.link({ type: 'link', raw, text: raw, href: tag.source, title: null, tokens: [{ type: 'text', raw, text: raw }] })
    })
  }
  renderer.image = ({ href, text }) =>
    /^https:\/\//i.test(href)
      ? `<img src="${escapeHtml(href)}" alt="${escapeHtml(text)}" loading="lazy" referrerpolicy="no-referrer" />`
      : escapeHtml(text)
  renderer.code = ({ text, lang }) =>
    lang === 'mermaid'
      ? `<div class="wiki-diagram"><pre class="mermaid">${escapeHtml(text)}</pre></div>`
      : `<pre><code>${escapeHtml(text)}</code></pre>`
  if (procedure) return renderProcedurePage(
    document.content, document.headings,
    (text, lineOffset = 0) => {
      const body = markdownBody(text), fragment = marked.lexer(body)
      let cursor = 0
      for (const token of fragment) {
        const start = body.indexOf(token.raw, cursor)
        cursor = start + token.raw.length
        if (token.type === 'heading') {
          const line = lineOffset + body.slice(0, start).split('\n').length
          const heading = document.headings.find(candidate => candidate.line === line)
          if (heading) anchors.set(token, heading.anchor)
        }
      }
      return marked.parser(fragment, { renderer })
    },
    text => marked.parseInline(text, { renderer, async: false }),
    escapeHtml,
    (id, stepId) => {
      const directory = document.path.slice(0, document.path.lastIndexOf('/') + 1)
      const matches = procedures.filter(candidate => candidate.procedureId === id)
      const siblings = matches.filter(candidate => candidate.path.slice(0, candidate.path.lastIndexOf('/') + 1) === directory)
      const target = siblings.length === 1 ? siblings[0] : matches.length === 1 ? matches[0] : undefined
      if (!target) return undefined
      const heading = stepId ? target.headings?.find(heading => heading.title.match(/\[id:\s*([^\],\s]+)\s*(?:,|\])/)?.[1] === stepId) : undefined
      // An unresolved step is not silently linked to the normal entry instead.
      if (stepId && !heading) return undefined
      return wikiPageUrl(target.path, revision) + (heading ? `#${heading.anchor}` : '')
    },
  )
  return marked.parser(blocks, { renderer })
}
