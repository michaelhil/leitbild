export const PRODUCT_SOURCE_EXTENSIONS = new Set(['.md', '.ts', '.svelte', '.json', '.css'])
export const PRODUCT_SOURCE_EXCLUDED_SEGMENTS = new Set([
  'node_modules', 'dist', 'build', 'coverage', 'deploy', 'data', 'runtime',
  'storage', 'public', '.git', '.svelte-kit',
])

export const isExcludedProductSegment = (segment: string): boolean =>
  PRODUCT_SOURCE_EXCLUDED_SEGMENTS.has(segment) || segment.startsWith('.env')

export const isAllowedProductPath = (path: string): boolean => {
  if (path === 'README.md' || path === 'CONTEXT-MAP.md') return true
  const segments = path.split('/')
  if (segments.some(isExcludedProductSegment)) return false
  if (path.startsWith('docs/') || path.startsWith('contexts/')) return true
  if (/^apps\/[^/]+\/(?:README\.md|src\/)/.test(path)) return true
  return /^packages\/[^/]+\/(?:README\.md|src\/)/.test(path)
}

const extensionOf = (path: string): string => {
  const dot = path.lastIndexOf('.')
  return dot < 0 ? '' : path.slice(dot)
}

export const parseProductSourceReference = (
  value: string,
): { readonly path: string; readonly startLine?: number; readonly endLine?: number } | null => {
  const match = value.trim().match(/^(.+?)(?::(\d+)(?:-(\d+))?)?$/)
  if (!match) return null
  const path = match[1]!.replaceAll('\\', '/')
  if (!isAllowedProductPath(path) || !PRODUCT_SOURCE_EXTENSIONS.has(extensionOf(path))) return null
  const startLine = match[2] === undefined ? undefined : Number(match[2])
  const endLine = match[3] === undefined ? startLine : Number(match[3])
  if (startLine !== undefined && (!Number.isSafeInteger(startLine) || startLine < 1)) return null
  if (endLine !== undefined && (!Number.isSafeInteger(endLine) || endLine < (startLine ?? 1))) return null
  return {
    path,
    ...(startLine === undefined ? {} : { startLine }),
    ...(endLine === undefined ? {} : { endLine }),
  }
}
