export const PRODUCT_SOURCE_EXTENSIONS = new Set(['.md', '.ts', '.svelte', '.json', '.css'])
export const PRODUCT_SOURCE_EXCLUDED_SEGMENTS = new Set([
  'node_modules', 'dist', 'build', 'coverage', '.git', '.svelte-kit',
])

export const isExcludedProductSegment = (segment: string): boolean =>
  PRODUCT_SOURCE_EXCLUDED_SEGMENTS.has(segment) || segment.startsWith('.env')

export const isAllowedProductPath = (path: string): boolean => {
  if (path === 'README.md' || path === 'CONTEXT-MAP.md') return true
  const segments = path.split('/')
  if (segments.some(segment => segment.length === 0 || segment === '.' || segment === '..' || isExcludedProductSegment(segment))) return false
  if (path.startsWith('docs/') || path.startsWith('contexts/')) return true
  if (/^apps\/[^/]+\/(?:README\.md|src\/)/.test(path)) return true
  return /^packages\/[^/]+\/(?:README\.md|src\/)/.test(path)
}

const extensionOf = (path: string): string => {
  const dot = path.lastIndexOf('.')
  return dot < 0 ? '' : path.slice(dot)
}

export const isProductSourceBasename = (path: string): boolean =>
  !path.includes('/')
  && /^[A-Za-z0-9_@.-]+$/.test(path)
  && PRODUCT_SOURCE_EXTENSIONS.has(extensionOf(path))

export interface ProductSourceLineRange {
  readonly startLine: number
  readonly endLine: number
}

export interface ProductSourceReference {
  readonly path: string
  readonly lineRanges: ReadonlyArray<ProductSourceLineRange>
}

export interface LocatedProductSourceReference extends ProductSourceReference {
  readonly startIndex: number
  readonly endIndex: number
}

const normalizeLineRanges = (ranges: ReadonlyArray<ProductSourceLineRange>): ReadonlyArray<ProductSourceLineRange> => {
  const ordered = [...ranges].sort((left, right) => left.startLine - right.startLine || left.endLine - right.endLine)
  const normalized: ProductSourceLineRange[] = []
  for (const range of ordered) {
    const previous = normalized.at(-1)
    if (previous && range.startLine <= previous.endLine + 1) {
      normalized[normalized.length - 1] = {
        startLine: previous.startLine,
        endLine: Math.max(previous.endLine, range.endLine),
      }
    } else {
      normalized.push(range)
    }
  }
  return normalized
}

const parseLineRanges = (selector: string | undefined): ReadonlyArray<ProductSourceLineRange> | null => {
  if (selector === undefined) return []
  const ranges: ProductSourceLineRange[] = []
  for (const part of selector.split(',')) {
    const match = part.trim().match(/^(\d+)(?:[-–—](\d+))?$/)
    if (!match) return null
    const startLine = Number(match[1])
    const endLine = match[2] === undefined ? startLine : Number(match[2])
    if (!Number.isSafeInteger(startLine) || startLine < 1
      || !Number.isSafeInteger(endLine) || endLine < startLine) return null
    ranges.push({ startLine, endLine })
  }
  return normalizeLineRanges(ranges)
}

export const parseProductSourceReference = (
  value: string,
): ProductSourceReference | null => {
  const match = value.trim().match(/^(.+?)(?::(\d+(?:[-–—]\d+)?(?:\s*,\s*\d+(?:[-–—]\d+)?)*))?$/)
  if (!match) return null
  const path = match[1]!.replaceAll('\\', '/')
  const lineRanges = parseLineRanges(match[2])
  if (lineRanges === null) return null
  const qualified = isAllowedProductPath(path) && PRODUCT_SOURCE_EXTENSIONS.has(extensionOf(path))
  const uniquelyResolvableCandidate = lineRanges.length > 0 && isProductSourceBasename(path)
  return qualified || uniquelyResolvableCandidate ? { path, lineRanges } : null
}

const extensionPattern = [...PRODUCT_SOURCE_EXTENSIONS]
  .map(extension => extension.slice(1).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  .join('|')

const inlineReferencePattern = new RegExp(
  `(?:README\\.md|CONTEXT-MAP\\.md|(?:docs|contexts|apps|packages)\\/[A-Za-z0-9_@./-]+\\.(?:${extensionPattern}))(?::\\d+(?:[-–—]\\d+)?(?:\\s*,\\s*\\d+(?:[-–—]\\d+)?)*)?`,
  'g',
)

const pathLikeBoundary = /[A-Za-z0-9_@./:\\-]/

// Finds displayable references embedded in ordinary prose. The final shared
// parser remains authoritative, so this scanner cannot expand the exposed
// source corpus or turn URL substrings into source links.
export const findProductSourceReferences = (value: string): ReadonlyArray<LocatedProductSourceReference> => {
  const references: LocatedProductSourceReference[] = []
  inlineReferencePattern.lastIndex = 0
  for (const match of value.matchAll(inlineReferencePattern)) {
    const startIndex = match.index
    const endIndex = startIndex + match[0].length
    if ((startIndex > 0 && pathLikeBoundary.test(value[startIndex - 1]!))
      || (endIndex < value.length && pathLikeBoundary.test(value[endIndex]!))) continue
    const reference = parseProductSourceReference(match[0])
    if (reference) references.push({ ...reference, startIndex, endIndex })
  }
  return references
}
