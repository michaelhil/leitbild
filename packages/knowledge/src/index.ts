import { resolve } from 'node:path'
import { z } from 'zod'
import { headingsFor } from './markdown.ts'
export { headingsFor, type KnowledgeHeading } from './markdown.ts'

const documentSchema = z.object({ path: z.string(), content: z.string() }).strict()
export const snapshotSchema = z.object({
  revision: z.string().regex(/^[a-f0-9]{40}$/),
  documents: z.array(documentSchema),
}).strict()
export type KnowledgeSnapshot = z.infer<typeof snapshotSchema>

export const safeDocumentPath = (path: string): boolean =>
  path.endsWith('.md') && !path.includes('\\') && !path.includes('\0')
  && path.split('/').every(segment => segment.length > 0 && segment !== '.' && segment !== '..' && !segment.startsWith('.'))

export const createKnowledge = (input: unknown) => {
  const snapshot = snapshotSchema.parse(input)
  const paths = new Set<string>()
  const documents = snapshot.documents.map(document => {
    if (!safeDocumentPath(document.path) || paths.has(document.path)) throw new Error(`Invalid or duplicate knowledge path: ${document.path}`)
    paths.add(document.path)
    const lines = document.content.split(/\r?\n/)
    const headings = headingsFor(document.content)
    const bodyStart = lines[0] === '---' ? lines.indexOf('---', 1) + 1 : 0
    const summary = lines.slice(bodyStart).find(line => line.trim() && !line.startsWith('#') && !line.startsWith('---')) ?? ''
    return { ...document, lines, headings, title: headings[0]?.title ?? document.path, summary }
  })
  const index = () => documents.map(({ path, title, summary, headings, lines }) => ({ path, title, summary, headings, totalLines: lines.length }))
  const read = (path: string, options: { readonly revision?: string; readonly startLine?: number; readonly lineCount?: number; readonly section?: string } = {}) => {
    if (options.revision !== undefined && options.revision !== snapshot.revision) throw new Error('Knowledge revision is not available in this publication; rediscover the current revision')
    const document = documents.find(candidate => candidate.path === path)
    if (!document) throw new Error(`Knowledge document not found: ${path}`)
    let start = options.startLine ?? 1
    let end = document.lines.length
    if (options.section !== undefined) {
      const heading = document.headings.find(candidate => candidate.anchor === options.section)
      if (!heading) throw new Error(`Unknown section: ${options.section}`)
      start = heading.line
      end = (document.headings.find(candidate => candidate.line > start && candidate.level <= heading.level)?.line ?? end + 1) - 1
      if (options.startLine !== undefined) {
        if (options.startLine < start || options.startLine > end) throw new Error('startLine is outside the selected section')
        start = options.startLine
      }
    }
    if (!Number.isSafeInteger(start) || start < 1 || start > document.lines.length) throw new Error('startLine is outside the document')
    const selectionEnd = end
    if (options.lineCount !== undefined) {
      if (!Number.isSafeInteger(options.lineCount) || options.lineCount < 1) throw new Error('lineCount must be a positive integer')
      end = Math.min(end, start + options.lineCount - 1)
    }
    return { revision: snapshot.revision, path, title: document.title, headings: document.headings,
      startLine: start, endLine: end, totalLines: document.lines.length,
      content: start === 1 && end === document.lines.length ? document.content : document.lines.slice(start - 1, end).join('\n'),
      ...(end < selectionEnd ? { nextLine: end + 1 } : {}),
      ...(options.section !== undefined ? { section: options.section, sectionComplete: end === selectionEnd } : {}),
    }
  }
  const search = (query: string, options: { readonly prefix?: string; readonly offset?: number; readonly limit?: number; readonly includeQuality?: boolean } = {}) => {
    const terms = [...new Set(query.toLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter(Boolean))]
    const matches = documents.filter(document =>
      (!options.prefix || document.path.startsWith(options.prefix))
      && (options.includeQuality || !document.path.startsWith('quality/')),
    ).flatMap(document => {
      const lower = `${document.path}\n${document.title}\n${document.content}`.toLowerCase()
      const score = terms.reduce((sum, term) => sum + (lower.includes(term) ? 1 : 0) + (document.title.toLowerCase().includes(term) ? 2 : 0), 0)
      if (terms.length > 0 && score === 0) return []
      let best = 0; let bestScore = -1
      document.lines.forEach((line, index) => {
        const lineScore = terms.filter(term => line.toLowerCase().includes(term)).length
        if (lineScore > bestScore) { best = index; bestScore = lineScore }
      })
      const heading = document.headings.filter(candidate => candidate.line <= best + 1).at(-1)
      const excerpt = document.lines[best] ?? ''
      const positions = terms.map(term => excerpt.toLowerCase().indexOf(term)).filter(position => position >= 0)
      const excerptStart = Math.max(0, (positions.length ? Math.min(...positions) : 0) - 120)
      // Search previews are bounded, not the document. Exact lines and sections
      // remain readable through the returned reference.
      const snippet = excerpt.slice(excerptStart, excerptStart + 1200)
      return [{ path: document.path, title: document.title, line: best + 1, section: heading?.anchor,
        snippet, snippetTruncated: excerptStart > 0 || excerpt.length > excerptStart + snippet.length, score }]
    }).sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    const offset = options.offset ?? 0
    const selected = matches.slice(offset, offset + (options.limit ?? 10)).map(({ score: _score, ...match }) => match)
    return { revision: snapshot.revision, total: matches.length, matches: selected,
      ...(offset + selected.length < matches.length ? { nextOffset: offset + selected.length } : {}) }
  }
  return { revision: snapshot.revision, index, read, search }
}
export type Knowledge = ReturnType<typeof createKnowledge>

export const knowledgeSnapshotPath = (applicationRoot: string): string => process.env.LEITBILD_KNOWLEDGE_SNAPSHOT
  ?? resolve(applicationRoot, 'knowledge/snapshot.json')

// Immutable publications share one parsed index per process. A new file identity
// invalidates it; failed reads are not cached as successful empty knowledge.
let cache: { readonly path: string; readonly modified: number; readonly size: number; readonly value: Knowledge } | undefined
export const loadKnowledge = async (path: string): Promise<Knowledge> => {
  const file = Bun.file(path)
  if (!await file.exists()) throw new Error('Leitbild knowledge publication is unavailable')
  const modified = file.lastModified
  if (cache?.path === path && cache.modified === modified && cache.size === file.size) return cache.value
  const value = createKnowledge(await file.json())
  cache = { path, modified, size: file.size, value }
  return value
}
