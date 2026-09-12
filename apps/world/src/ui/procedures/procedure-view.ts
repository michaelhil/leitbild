import type { ProcedureBranch, ProcedureCatalogItem, ProcedureDocument, ProcedureRunScope, ProcedureStep, ProcedureTextBlock } from '../../core/model/index.ts'

const primaryKinds = new Set(['check', 'action', 'decision', 'when', 'until', 'within', 'concurrent'])
type StepItem =
  | { readonly kind: 'block'; readonly block: ProcedureTextBlock; readonly primary: boolean; readonly sourceLine: number }
  | { readonly kind: 'branch'; readonly branch: ProcedureBranch; readonly primary: false; readonly sourceLine: number }

/** Source order is also reading order. Keep original branch objects for command identity. */
export const procedureStepItems = (step: ProcedureStep): ReadonlyArray<StepItem> => [
  ...step.blocks
    .filter(block => !(block.kind === 'note' && block.text.startsWith('Simulator applicability')))
    .map(block => ({ kind: 'block' as const, block, primary: primaryKinds.has(block.kind), sourceLine: block.sourceLine })),
  ...step.branches.map(branch => ({ kind: 'branch' as const, branch, primary: false as const, sourceLine: branch.sourceLine })),
].sort((left, right) => left.sourceLine - right.sourceLine)

export const procedureTextSegments = (text: string, tagIds: readonly string[]): ReadonlyArray<{ readonly kind: 'text' | 'tag'; readonly text: string }> => {
  const allowed = new Set(tagIds)
  const segments: Array<{ kind: 'text' | 'tag'; text: string }> = []
  let cursor = 0
  // Inline code and fenced examples are text, never live instrumentation links.
  for (const match of text.matchAll(/(`+)[\s\S]*?\1|«([^»]+)»/g)) {
    const start = match.index ?? 0
    if (start > cursor) segments.push({ kind: 'text', text: text.slice(cursor, start) })
    const id = match[2]
    segments.push(id !== undefined && allowed.has(id) ? { kind: 'tag', text: id } : { kind: 'text', text: match[0] })
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
