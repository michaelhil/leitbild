import { marked } from 'marked'

/** Frontmatter is source metadata, not visible Markdown. Preserve source lines. */
export const markdownBody = (content: string): string => {
  const lines = content.split(/\r?\n/)
  if (lines[0] !== '---') return content
  const end = lines.indexOf('---', 1)
  if (end < 0) throw new Error('Unterminated Markdown frontmatter')
  return lines.map((line, index) => index <= end ? '' : line).join('\n')
}

export interface KnowledgeHeading { readonly title: string; readonly line: number; readonly level: number; readonly anchor: string }
/** A paragraph, not a raw metadata/list/code line, describes a page in discovery. */
export const summaryFor = (content: string): string => {
  const paragraph = marked.lexer(markdownBody(content)).find(token => token.type === 'paragraph')
  return paragraph?.type === 'paragraph' ? paragraph.text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/[*`_]/g, '').replace(/\s+/g, ' ').trim() : ''
}
export const headingsFor = (content: string): ReadonlyArray<KnowledgeHeading> => {
  const body = markdownBody(content).replaceAll('\r\n', '\n')
  const result: KnowledgeHeading[] = []
  const anchors = new Map<string, number>()
  let cursor = 0
  for (const token of marked.lexer(body)) {
    const start = body.indexOf(token.raw, cursor)
    if (start < 0) throw new Error('Cannot locate Markdown block in its source')
    cursor = start + token.raw.length
    if (token.type !== 'heading') continue
    const title = token.text
    const base = title.toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, '').trim().replace(/\s+/g, '-')
    const count = anchors.get(base) ?? 0
    anchors.set(base, count + 1)
    result.push({ title, line: body.slice(0, start).split('\n').length, level: token.depth, anchor: count === 0 ? base : `${base}-${count}` })
  }
  return result
}
