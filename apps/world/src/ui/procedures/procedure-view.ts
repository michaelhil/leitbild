import type { ProcedureCatalogItem, ProcedureDocument, ProcedureRunScope } from '../../core/model/index.ts'

export const procedureViewKey = (document: ProcedureDocument, scope: ProcedureRunScope): string =>
  JSON.stringify([scope.plantId, scope.targetObjectId, document.source.sourceId, document.source.revision, document.sourcePath, document.procedureId])

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
