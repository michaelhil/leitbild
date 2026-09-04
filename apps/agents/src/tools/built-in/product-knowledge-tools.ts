import { readFile, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { z } from 'zod'
import type { Tool } from '../../core/types/tool.ts'
import {
  MAX_PRODUCT_SOURCE_BYTES,
  listProductSourcePaths,
  productDocumentAuthority,
  productDocumentKind,
  productSourceRoot,
  readProductRevision,
  type ProductDocumentAuthority,
  type ProductDocumentKind,
} from '../../core/product-source.ts'

const MAX_CORPUS_BYTES = 32_000_000
const MAX_READ_LINES = 200

interface ProductDocument {
  readonly path: string
  readonly kind: ProductDocumentKind
  readonly authority: ProductDocumentAuthority
  readonly content: string
  readonly lines: ReadonlyArray<string>
}

interface ProductCorpus {
  readonly revision: string
  readonly documents: ReadonlyArray<ProductDocument>
}

const searchInputSchema = z.object({
  query: z.string().trim().min(1).max(256),
  kind: z.enum(['all', 'documentation', 'source']).default('all'),
  limit: z.number().int().min(1).max(20).default(8),
}).strict()

const readInputSchema = z.object({
  path: z.string().trim().min(1).max(1_024),
  startLine: z.number().int().min(1).default(1),
  lineCount: z.number().int().min(1).max(MAX_READ_LINES).default(80),
}).strict()

const loadCorpus = async (root: string): Promise<ProductCorpus> => {
  const documents: ProductDocument[] = []
  let totalBytes = 0
  for (const path of await listProductSourcePaths(root)) {
    const absolutePath = resolve(root, path)
    const file = await stat(absolutePath)
    if (file.size > MAX_PRODUCT_SOURCE_BYTES) continue
    totalBytes += file.size
    if (totalBytes > MAX_CORPUS_BYTES) throw new Error(`Product knowledge corpus exceeds ${MAX_CORPUS_BYTES} bytes`)
    const content = await readFile(absolutePath, 'utf8')
    documents.push({ path, kind: productDocumentKind(path), authority: productDocumentAuthority(path), content, lines: content.split(/\r?\n/) })
  }
  return { revision: await readProductRevision(root), documents }
}

const STOP_TERMS = new Set(['a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'how', 'i', 'in', 'is', 'it', 'me', 'of', 'on', 'or', 'that', 'the', 'this', 'to', 'was', 'what', 'where', 'with'])
const normalizeTerms = (query: string): ReadonlyArray<string> => {
  const meaningful = [...new Set(query.toLocaleLowerCase().split(/[^\p{L}\p{N}_.-]+/u).filter(term => term.length > 1 && !STOP_TERMS.has(term)))]
  return meaningful.length > 0 ? meaningful : [query.toLocaleLowerCase()]
}

export const createProductKnowledgeTools = (options: { readonly repoRoot?: string } = {}): ReadonlyArray<Tool> => {
  const root = productSourceRoot(options.repoRoot)
  let corpusPromise: Promise<ProductCorpus> | undefined
  const corpus = (): Promise<ProductCorpus> => corpusPromise ??= loadCorpus(root)

  const search: Tool = {
    name: 'product_search',
    description: 'Search the deployed Leitbild documentation and source corpus for authoritative implementation evidence.',
    usage: 'Use before explaining Leitbild internals; then read the most relevant exact paths.',
    returns: 'Revision-tagged matches with path, line, and a bounded source snippet.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        query: { type: 'string', minLength: 1, maxLength: 256 },
        kind: { type: 'string', enum: ['all', 'documentation', 'source'], default: 'all' },
        limit: { type: 'integer', minimum: 1, maximum: 20, default: 8 },
      },
      required: ['query'],
    },
    execute: async params => {
      const input = searchInputSchema.safeParse(params)
      if (!input.success) return { success: false, error: input.error.message }
      const loaded = await corpus()
      const terms = normalizeTerms(input.data.query)
      const matches = loaded.documents
        .filter(document => input.data.kind === 'all' || document.kind === input.data.kind)
        .flatMap(document => {
          const lowerPath = document.path.toLocaleLowerCase()
          const lowerContent = document.content.toLocaleLowerCase()
          if (!terms.some(term => lowerPath.includes(term) || lowerContent.includes(term))) return []
          let bestLine = 0
          let bestLineScore = -1
          for (let index = 0; index < document.lines.length; index += 1) {
            const lowerLine = document.lines[index]!.toLocaleLowerCase()
            const score = terms.reduce((sum, term) => sum + (lowerLine.includes(term) ? 3 : 0), 0)
            if (score > bestLineScore) { bestLine = index; bestLineScore = score }
          }
          const pathScore = terms.reduce((sum, term) => sum + (lowerPath.includes(term) ? 6 : 0), 0)
          const coverage = terms.reduce((sum, term) => sum + (lowerContent.includes(term) ? 1 : 0), 0)
          const from = Math.max(0, bestLine - 1)
          const to = Math.min(document.lines.length, bestLine + 2)
          const authorityScore = document.authority === 'implementation' ? 5 : document.authority === 'decision' ? 4 : document.authority === 'domain-language' ? 3 : 0
          return [{
            score: pathScore + bestLineScore + coverage + authorityScore,
            path: document.path,
            kind: document.kind,
            authority: document.authority,
            line: bestLine + 1,
            snippet: document.lines.slice(from, to).join('\n').slice(0, 1_200),
          }]
        })
        .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))
        .slice(0, input.data.limit)
        .map(({ score: _score, ...match }) => match)
      return { success: true, data: { revision: loaded.revision, query: input.data.query, matches } }
    },
  }

  const read: Tool = {
    name: 'product_read',
    description: 'Read a bounded line range from an allowlisted Leitbild path returned by product_search.',
    usage: 'Use exact search-result paths. Runtime data, deployment configuration, secrets, generated output, and arbitrary filesystem paths are inaccessible.',
    returns: 'Revision-tagged numbered lines and explicit range metadata.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        path: { type: 'string', minLength: 1, maxLength: 1024 },
        startLine: { type: 'integer', minimum: 1, default: 1 },
        lineCount: { type: 'integer', minimum: 1, maximum: MAX_READ_LINES, default: 80 },
      },
      required: ['path'],
    },
    execute: async params => {
      const input = readInputSchema.safeParse(params)
      if (!input.success) return { success: false, error: input.error.message }
      const loaded = await corpus()
      const document = loaded.documents.find(candidate => candidate.path === input.data.path)
      if (!document) return { success: false, error: 'Path is not in the Leitbild product knowledge corpus; search for an allowed path first.' }
      const startIndex = input.data.startLine - 1
      if (startIndex >= document.lines.length) return { success: false, error: `startLine exceeds the file's ${document.lines.length} lines` }
      const selected = document.lines.slice(startIndex, startIndex + input.data.lineCount)
      return { success: true, data: {
        revision: loaded.revision,
        path: document.path,
        kind: document.kind,
        authority: document.authority,
        startLine: input.data.startLine,
        endLine: input.data.startLine + selected.length - 1,
        totalLines: document.lines.length,
        content: selected.map((line, index) => `${input.data.startLine + index}: ${line}`).join('\n'),
      } }
    },
  }

  return [search, read]
}
