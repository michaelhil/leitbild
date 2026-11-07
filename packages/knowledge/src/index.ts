import { resolve } from 'node:path'
import { z } from 'zod'
import { headingsFor, summaryFor } from './markdown.ts'
import { isProcedureMarkdown, parseProcedure } from '@leitbild/procmd'
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

const searchStopWords = new Set('a an and are as at be by can could do does for from how i in is it me of on or see that the this to use was what when where which with would you your'.split(' '))
const searchWord = '[\\p{L}\\p{N}_]'
// A phrase may vary its articles and helper words. Keep linking words such
// as “of” significant so “copy of a Run” isn't ranked as an instruction.
const searchPhraseSeparator = '[^\\p{L}\\p{N}_]+(?:(?:a|an|are|be|can|do|is|see|the|this|to|use)[^\\p{L}\\p{N}_]+)*'
const wholeSearchTerm = (pattern: string): RegExp => new RegExp(`(?<!${searchWord})${pattern}(?!${searchWord})`, 'u')
const escapeSearchTerm = (term: string): string => term.replaceAll('.', '\\.')
const isReferencePage = (path: string): boolean =>
  path.startsWith('archive/') || path.startsWith('engineering-analysis/') || path.startsWith('quality/')
  || path.includes('/reference-designs/') || path.startsWith('world/packs/lfr-1/')

export const createKnowledge = (input: unknown) => {
  const snapshot = snapshotSchema.parse(input)
  const paths = new Set<string>()
  const documents = snapshot.documents.map(document => {
    if (!safeDocumentPath(document.path) || paths.has(document.path)) throw new Error(`Invalid or duplicate knowledge path: ${document.path}`)
    paths.add(document.path)
    const lines = document.content.split(/\r?\n/)
    const headings = headingsFor(document.content)
    const summary = summaryFor(document.content)
    const procedure = isProcedureMarkdown(document.content) ? parseProcedure(document.content) : undefined
    return { ...document, lines, headings, title: headings[0]?.title ?? document.path, summary, procedure, procedureId: procedure?.procedureId }
  })
  const parentFor = (path: string): string | null => {
    const parts = path.split('/'); parts.pop()
    if (path.endsWith('/index.md')) parts.pop()
    while (parts.length) {
      const parent = `${parts.join('/')}/index.md`
      if (paths.has(parent)) return parent
      parts.pop()
    }
    return path !== 'index.md' && paths.has('index.md') ? 'index.md' : null
  }
  const navigation = documents.map(({ path, title, summary }) => ({ path, title, summary, parent: parentFor(path), hub: path === 'index.md' || path.endsWith('/index.md') }))
  const procedureReferences = (path: string) => {
    const procedure = documents.find(document => document.path === path)?.procedure
    const branches = procedure?.steps.flatMap(step => step.branches).filter(branch => branch.targetKind === 'procedure') ?? []
    // Include every candidate for an authored identity. The reader can resolve
    // a unique sibling, but duplicated identities must never become a guess.
    return documents.filter(document => document.procedure && branches.some(branch => branch.target === document.procedureId))
      .map(document => ({
        path: document.path,
        procedureId: document.procedure!.procedureId,
        steps: document.procedure!.steps.filter(step => branches.some(branch => branch.target === document.procedureId && branch.targetStepId === step.id))
          .map(step => {
            const heading = document.headings.find(heading => heading.line === step.sourceLine)
            if (!heading) throw new Error(`Procedure step has no source heading: ${document.path}#${step.id}`)
            return { id: step.id, anchor: heading.anchor }
          }),
      }))
  }
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
      // Direct children only. Exact Markdown bytes and line positions remain intact.
      children: navigation.filter(entry => entry.parent === path),
      parent: parentFor(path),
      startLine: start, endLine: end, totalLines: document.lines.length,
      content: start === 1 && end === document.lines.length ? document.content : document.lines.slice(start - 1, end).join('\n'),
      ...(end < selectionEnd ? { nextLine: end + 1 } : {}),
      ...(options.section !== undefined ? { section: options.section, sectionComplete: end === selectionEnd } : {}),
    }
  }
  const search = (query: string, options: { readonly prefix?: string; readonly offset?: number; readonly limit?: number; readonly includeQuality?: boolean } = {}) => {
    const normalizedQuery = query.trim().toLowerCase()
    // Keep engineering identifiers such as LD-01 and ECA-0.0 intact.
    const words = normalizedQuery.match(/[\p{L}\p{N}_]+(?:[.-][\p{L}\p{N}_]+)*/gu) ?? []
    const meaningful = words.filter(word => !searchStopWords.has(word))
    const terms = [...new Set(meaningful.length ? meaningful : words)]
    const patterns = terms.map(term => wholeSearchTerm(escapeSearchTerm(term)))
    const countMatches = (value: string): number => patterns.filter(pattern => pattern.test(value)).length
    const archiveRequested = terms.includes('archive') || terms.includes('archived')
    const phrase = meaningful.length > 1 && terms.length > 1
      ? wholeSearchTerm(terms.map(escapeSearchTerm).join(searchPhraseSeparator))
      : undefined
    const matches = documents.filter(document =>
      (!options.prefix || document.path.startsWith(options.prefix))
      && (options.includeQuality || !document.path.startsWith('quality/')),
    ).flatMap(document => {
      const path = document.path.toLowerCase()
      const title = document.title.toLowerCase()
      const coverage = countMatches(`${path}\n${title}\n${document.content.toLowerCase()}`)
      const exactPath = normalizedQuery === path || normalizedQuery === `knowledge/${path}`
      if (terms.length > 0 && coverage === 0 && !exactPath) return []

      let best = 0; let bestScore = -1
      if (terms.length) document.lines.forEach((line, index) => {
        const lower = line.toLowerCase()
        const lineScore = countMatches(lower) + (phrase?.test(lower) ? terms.length : 0)
        if (lineScore > bestScore) { best = index; bestScore = lineScore }
      })
      const heading = document.headings.filter(candidate => candidate.line <= best + 1).at(-1)
      const excerpt = document.lines[best] ?? ''
      const lowerExcerpt = excerpt.toLowerCase()
      const positions = patterns.map(pattern => lowerExcerpt.search(pattern)).filter(position => position >= 0)
      const excerptStart = Math.max(0, (positions.length ? Math.min(...positions) : 0) - 120)
      // Search previews are bounded, not the document. Exact lines and sections
      // remain readable through the returned reference.
      const snippet = excerpt.slice(excerptStart, excerptStart + 1200)
      // Prefer useful co-located matches and explicit identities. Current guidance
      // wins close general matches without excluding design or retained sources.
      const procedure = document.procedureId?.toLowerCase()
      const scope = archiveRequested ? Number(path.startsWith('archive/')) * 8 : Number(!isReferencePage(path)) * 3
      const score = exactPath ? Number.POSITIVE_INFINITY : terms.length === 0 ? 0
        : coverage * 4 + bestScore * 2 + countMatches(path) * 3 + countMatches(title) * 2 + scope
          + (procedure !== undefined && terms.includes(procedure) ? 15 : 0)
      return [{ path: document.path, title: document.title, line: best + 1, section: heading?.anchor,
        snippet, snippetTruncated: excerptStart > 0 || excerpt.length > excerptStart + snippet.length, score }]
    }).sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    const offset = options.offset ?? 0
    const selected = matches.slice(offset, offset + (options.limit ?? 10)).map(({ score: _score, ...match }) => match)
    return { revision: snapshot.revision, total: matches.length, matches: selected,
      ...(offset + selected.length < matches.length ? { nextOffset: offset + selected.length } : {}) }
  }
  return {
    revision: snapshot.revision,
    navigation: () => navigation.map(({ path, title, parent, hub }) => ({ path, title, parent, hub })),
    procedureReferences,
    read,
    search,
  }
}
export type Knowledge = ReturnType<typeof createKnowledge>
export type KnowledgeNavigationEntry = ReturnType<Knowledge['navigation']>[number]
export type KnowledgeProcedureReference = ReturnType<Knowledge['procedureReferences']>[number]

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
