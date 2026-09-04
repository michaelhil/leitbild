import { lstat, readFile } from 'node:fs/promises'
import { extname, relative, resolve, sep } from 'node:path'
import {
  PRODUCT_SOURCE_EXTENSIONS,
  isAllowedProductPath,
} from './product-source-reference.ts'

export {
  PRODUCT_SOURCE_EXTENSIONS,
  PRODUCT_SOURCE_EXCLUDED_SEGMENTS,
  isAllowedProductPath,
  isExcludedProductSegment,
  parseProductSourceReference,
} from './product-source-reference.ts'

export const MAX_PRODUCT_SOURCE_BYTES = 1_000_000

export type ProductDocumentKind = 'documentation' | 'source'
export type ProductDocumentAuthority = 'implementation' | 'decision' | 'domain-language' | 'documentation'

export interface ProductSourceDocument {
  readonly path: string
  readonly kind: ProductDocumentKind
  readonly authority: ProductDocumentAuthority
  readonly revision: string
  readonly content: string
  readonly totalLines: number
}

export const productSourceRoot = (root?: string): string =>
  resolve(root ?? resolve(import.meta.dir, '../../../..'))

export const productDocumentKind = (path: string): ProductDocumentKind =>
  path.endsWith('.md') ? 'documentation' : 'source'

export const productDocumentAuthority = (path: string): ProductDocumentAuthority =>
  path.includes('/src/') ? 'implementation'
    : path.startsWith('docs/adr/') ? 'decision'
      : path.startsWith('contexts/') || path === 'CONTEXT-MAP.md' ? 'domain-language'
        : 'documentation'

export const readProductRevision = async (root: string): Promise<string> => {
  try {
    const deployment = JSON.parse(await readFile(resolve(root, 'DEPLOYMENT.json'), 'utf8')) as Record<string, unknown>
    for (const key of ['releaseId', 'baseCommit', 'commit', 'revision', 'sha']) {
      if (typeof deployment[key] === 'string' && deployment[key].length > 0) return deployment[key]
    }
  } catch {
    // A source checkout has no deployment manifest. Reporting development is
    // explicit and avoids presenting an invented revision.
  }
  return 'development'
}

const canonicalProductPath = (root: string, absolutePath: string): string =>
  relative(root, absolutePath).split(sep).join('/')

export const readProductSource = async (
  requestedPath: string,
  rootOverride?: string,
): Promise<ProductSourceDocument> => {
  const root = productSourceRoot(rootOverride)
  const path = requestedPath.trim().replaceAll('\\', '/')
  if (!path || path.startsWith('/') || !isAllowedProductPath(path) || !PRODUCT_SOURCE_EXTENSIONS.has(extname(path))) {
    throw new Error('Path is not in the Leitbild product source corpus')
  }
  const absolutePath = resolve(root, path)
  if (canonicalProductPath(root, absolutePath) !== path) {
    throw new Error('Path is not in the Leitbild product source corpus')
  }
  const file = await lstat(absolutePath).catch(() => {
    throw new Error('Product source is unavailable in this deployed revision')
  })
  if (!file.isFile() || file.size > MAX_PRODUCT_SOURCE_BYTES) {
    throw new Error('Product source is unavailable for inline inspection')
  }
  const content = await readFile(absolutePath, 'utf8').catch(() => {
    throw new Error('Product source is unavailable in this deployed revision')
  })
  return {
    path,
    kind: productDocumentKind(path),
    authority: productDocumentAuthority(path),
    revision: await readProductRevision(root),
    content,
    totalLines: content.split(/\r?\n/).length,
  }
}
