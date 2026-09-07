import { createKnowledge, safeDocumentPath, type KnowledgeSnapshot } from './index.ts'
import { posix } from 'node:path'
import { readProductSource } from './source.ts'
import { parseProductSourceReference } from './source-reference.ts'
import { updateSchematicDocument } from './schematic.ts'

const git = async (root: string, args: string[]): Promise<string> => {
  const child = Bun.spawn(['git', '-C', root, ...args], { stdout: 'pipe', stderr: 'pipe' })
  const [out, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  if (code !== 0) throw new Error(`Knowledge Git input failed: ${error}`)
  return out
}

/** Check actual served source and return the exact code files needed for inspection.
 * Packaging includes these validated references, not entire development directories.
 * Knowledge references already live in the publication rather than separate files.
 */
export const validateKnowledgeSources = async (snapshot: KnowledgeSnapshot, sourceRoot?: string): Promise<ReadonlyArray<string>> => {
  const paths = new Set<string>()
  for (const document of snapshot.documents) {
    for (const match of document.content.matchAll(/(?<!!)\[[^\]]*\]\((source:[^\s)]+)(?:\s+"[^"]*")?\)/g)) {
      const href = match[1]!
      if (!sourceRoot) throw new Error('A product source root is required to validate implementation links')
      const ref = parseProductSourceReference(href.slice(7).replace(/#L(\d+)(?:-L?(\d+))?$/, (_match, start, end) => `:${start}${end ? `-${end}` : ''}`))
      if (!ref) throw new Error(`Invalid source reference in ${document.path}: ${href}`)
      const source = await readProductSource(ref.path, sourceRoot).catch(error => {
        throw new Error(`Invalid source link in ${document.path}: ${href}: ${error instanceof Error ? error.message : String(error)}`)
      })
      if (ref.lineRanges.some(range => range.endLine > source.totalLines)) throw new Error(`Source line range exceeds file in ${document.path}: ${href}`)
      if (!source.path.startsWith('knowledge/')) paths.add(source.path)
    }
  }
  return [...paths].sort()
}

export const publishKnowledge = async (root: string, sourceRoot?: string): Promise<KnowledgeSnapshot> => {
  if ((await git(root, ['status', '--porcelain'])).trim()) throw new Error('Commit the knowledge repository before publishing')
  const revision = (await git(root, ['rev-parse', 'HEAD'])).trim()
  const names = (await git(root, ['ls-tree', '-r', '--name-only', '-z', revision])).split('\0').filter(path =>
    safeDocumentPath(path) && path !== 'AGENTS.md',
  ).sort()
  const documents = await Promise.all(names.map(async path => ({ path, content: await git(root, ['show', `${revision}:${path}`]) })))
  if (!documents.some(document => document.path === 'index.md')) throw new Error('Knowledge repository requires index.md')
  const snapshot = { revision, documents }
  const knowledge = createKnowledge(snapshot)
  await validateKnowledgeSources(snapshot, sourceRoot)
  for (const document of documents) {
    if (/^```plant-schematic\s*$/m.test(document.content)
      && updateSchematicDocument(document.content) !== document.content)
      throw new Error(`Stale generated schematic in ${document.path}; regenerate before publishing`)
    // Relative authored document links must resolve in this exact publication.
    // External/code references are independently checkable, not mirrored here.
    for (const match of document.content.matchAll(/(?<!!)\[[^\]]*\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g)) {
      const href = match[1]!
      if (/^[a-z][a-z\d+.-]*:/i.test(href) || href.startsWith('/')) continue
      const [target, section] = href.split('#')
      const path = target ? posix.normalize(posix.join(posix.dirname(document.path), decodeURIComponent(target))) : document.path
      if (!path.endsWith('.md')) throw new Error(`Use an explicit Markdown document link in ${document.path}: ${href}`)
      knowledge.read(path, section ? { section: decodeURIComponent(section) } : {})
    }
  }
  return snapshot
}
