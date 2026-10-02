import type { ProcedureBranch, ProcedureCatalogItem, ProcedureDocument, ProcedureRunScope, ProcedureStep, ProcedureTextBlock } from '../../core/model/index.ts'
import type { ProcedureSourceEvidenceRequest } from './procedure-client.ts'

const primaryKinds = new Set(['check', 'action', 'expected', 'decision', 'when', 'until', 'within', 'concurrent'])
type StepItem =
  | { readonly kind: 'block'; readonly block: ProcedureTextBlock; readonly primary: boolean; readonly sourceLine: number }
  | { readonly kind: 'branch'; readonly branch: ProcedureBranch; readonly primary: false; readonly sourceLine: number }

/** Source order is also reading order. Keep original branch objects for command identity. */
export const procedureStepItems = (step: ProcedureStep): ReadonlyArray<StepItem> => [
  ...step.blocks.map(block => ({ kind: 'block' as const, block, primary: primaryKinds.has(block.kind), sourceLine: block.sourceLine })),
  ...step.branches.map(branch => ({ kind: 'branch' as const, branch, primary: false as const, sourceLine: branch.sourceLine })),
].sort((left, right) => left.sourceLine - right.sourceLine)

export type ProcedureTextSegment =
  | { readonly kind: 'text' | 'tag'; readonly text: string }
  | { readonly kind: 'link'; readonly text: string; readonly href: string }

export const procedureSourceEvidenceRequest = (href: string, document: ProcedureDocument): ProcedureSourceEvidenceRequest | undefined => {
  if (!href.startsWith('/wiki?')) return undefined
  try {
    const target = new URL(href, 'https://knowledge.invalid')
    const path = target.searchParams.get('path')
    if (!path || target.searchParams.get('revision') !== document.source.revision) return undefined
    return {
      sourceId: document.source.sourceId, sourceRevision: document.source.revision, sourcePath: path,
      ...(target.hash.length > 1 ? { section: decodeURIComponent(target.hash.slice(1)) } : {}), lineCount: 100,
    }
  } catch { return undefined }
}

const procedureSourceHref = (target: string, sourceUrl?: string): string | undefined => {
  try {
    if (target.startsWith('source:')) return `/api/knowledge/source?${new URLSearchParams({ path: target.slice(7) })}`
    if (target.startsWith('//')) return undefined
    if (sourceUrl?.startsWith('/wiki?') && !/^[a-z][a-z0-9+.-]*:/i.test(target)) {
      const source = new URL(sourceUrl, 'https://knowledge.invalid')
      const sourcePath = source.searchParams.get('path')
      const revision = source.searchParams.get('revision')
      if (sourcePath && revision) {
        const resolved = new URL(target, `https://knowledge.invalid/${sourcePath}`)
        return `/wiki?${new URLSearchParams({ path: decodeURIComponent(resolved.pathname.slice(1)), revision })}${resolved.hash}`
      }
    }
    const url = sourceUrl === undefined ? new URL(target) : new URL(target, sourceUrl)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : undefined
  } catch { return undefined }
}

export const procedureBlockLabel = (kind: ProcedureTextBlock['kind']): string => ({
  check: 'Check', action: 'Action', expected: 'Expected response', rno: 'Response not obtained',
  unknown: 'Unknown or unreliable indication', basis: 'Technical basis', decision: 'Decision',
  when: 'When', until: 'Until', 'abort-if': 'Abort condition', 'abort-to': 'Abort destination',
  within: 'Time limit', concurrent: 'Concurrent action', caution: 'Caution', note: 'Note',
  because: 'Because', against: 'Against', text: '',
})[kind]

export const procedureObservationEvidence = (result: Record<string, unknown>): ReadonlyArray<{
  readonly label: string; readonly value: string; readonly criterion: string; readonly status: string; readonly reason?: string
}> => Array.isArray(result.evidence) ? result.evidence.map(value => {
  const item = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
  const signal = typeof item.signal === 'object' && item.signal !== null ? item.signal as Record<string, unknown> : {}
  const variable = typeof item.variable === 'object' && item.variable !== null ? item.variable as Record<string, unknown> : {}
  const comparison = typeof item.comparison === 'object' && item.comparison !== null ? item.comparison as Record<string, unknown> : {}
  return {
    label: typeof signal.label === 'string' ? signal.label : typeof signal.path === 'string' ? signal.path : 'Unavailable signal',
    value: variable.value === undefined ? 'unavailable' : `${String(variable.value)}${typeof variable.unit === 'string' ? ` ${variable.unit}` : ''}`,
    criterion: `${String(comparison.operator ?? '?')} ${String(comparison.value ?? '?')}${typeof comparison.unit === 'string' ? ` ${comparison.unit}` : ''}`,
    status: typeof item.status === 'string' ? item.status : 'unknown',
    ...(typeof item.reason === 'string' ? { reason: item.reason } : {}),
  }
}) : []

export const procedureObservationBasis = (result: Record<string, unknown>): string => {
  const basis = typeof result.basis === 'object' && result.basis !== null ? result.basis as Record<string, unknown> : {}
  const source = typeof basis.source === 'string' && /^(source:|https?:\/\/)|\.md(?:#|$)/.test(basis.source)
    ? `[Technical source](${basis.source})` : basis.source
  return [basis.description, source].filter(value => typeof value === 'string').join(' — ')
}

export const procedureTextSegments = (text: string, tagIds: readonly string[], sourceUrl?: string): ReadonlyArray<ProcedureTextSegment> => {
  const allowed = new Set(tagIds)
  const segments: ProcedureTextSegment[] = []
  let cursor = 0
  // Inline code and fenced examples are text, never live instrumentation links.
  for (const match of text.matchAll(/(`+)[\s\S]*?\1|«([^»]+)»|\[([^\]\n]+)\]\(([^)\s]+)\)/g)) {
    const start = match.index ?? 0
    if (start > cursor) segments.push({ kind: 'text', text: text.slice(cursor, start) })
    const id = match[2]
    const href = match[4] === undefined ? undefined : procedureSourceHref(match[4], sourceUrl)
    segments.push(id !== undefined && allowed.has(id) ? { kind: 'tag', text: id }
      : href !== undefined ? { kind: 'link', text: match[3]!, href }
      : { kind: 'text', text: match[0] })
    cursor = start + match[0].length
  }
  if (cursor < text.length) segments.push({ kind: 'text', text: text.slice(cursor) })
  return segments
}

export const procedureViewKey = (document: ProcedureDocument, scope: ProcedureRunScope): string =>
  JSON.stringify([scope.plantId, document.source.sourceId, document.source.revision, document.sourcePath, document.procedureId])

export const procedureCategories = (procedures: ReadonlyArray<ProcedureCatalogItem>) => {
  const groups = new Map<string, ProcedureCatalogItem[]>()
  for (const procedure of procedures) {
    const category = procedure.category ?? 'Procedures'
    const items = groups.get(category) ?? []
    items.push(procedure)
    groups.set(category, items)
  }
  return [...groups].map(([id, procedures]) => ({ id, label: id.replace(/[-_]/g, ' '), procedures }))
}
