import { createKnowledge, safeDocumentPath, type KnowledgeSnapshot } from './index.ts'
import { posix } from 'node:path'

const git = async (root: string, args: string[]): Promise<string> => {
  const child = Bun.spawn(['git', '-C', root, ...args], { stdout: 'pipe', stderr: 'pipe' })
  const [out, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  if (code !== 0) throw new Error(`Knowledge Git input failed: ${error}`)
  return out
}

export const publishKnowledge = async (root: string): Promise<KnowledgeSnapshot> => {
  if ((await git(root, ['status', '--porcelain'])).trim()) throw new Error('Commit the knowledge repository before publishing')
  const revision = (await git(root, ['rev-parse', 'HEAD'])).trim()
  const names = (await git(root, ['ls-tree', '-r', '--name-only', '-z', revision])).split('\0').filter(path =>
    safeDocumentPath(path) && path !== 'AGENTS.md',
  ).sort()
  const documents = await Promise.all(names.map(async path => ({ path, content: await git(root, ['show', `${revision}:${path}`]) })))
  if (!documents.some(document => document.path === 'index.md')) throw new Error('Knowledge repository requires index.md')
  const snapshot = { revision, documents }
  const knowledge = createKnowledge(snapshot)
  for (const document of documents) {
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
