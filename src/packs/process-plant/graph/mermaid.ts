import type { CompiledPlantGraph, ComponentId } from './model.ts'

const nodeId = (index: number): string => `c${index}`

export const plantGraphToMermaid = (
  graph: CompiledPlantGraph,
  options: {
    readonly highlightedComponentIds?: ReadonlySet<ComponentId> | ReadonlyArray<ComponentId>
  } = {},
): string => {
  const highlightedComponentIds = options.highlightedComponentIds instanceof Set
    ? options.highlightedComponentIds
    : new Set(options.highlightedComponentIds ?? [])
  const lines = ['flowchart TB']
  for (const component of graph.components) {
    lines.push(`  ${nodeId(component.index)}["${component.label}"]`)
  }
  for (const link of graph.links) {
    const from = graph.components[link.fromComponentIndex]
    const to = graph.components[link.toComponentIndex]
    if (!from || !to) throw new Error(`compiled link ${link.id} references missing component index`)
    const service = link.service === undefined ? 'no-service' : String(link.service)
    lines.push(`  ${nodeId(from.index)} -- "${service}<br/>${link.kind}<br/>${link.id}" --> ${nodeId(to.index)}`)
  }
  const highlightedNodeIds = graph.components
    .filter(component => highlightedComponentIds.has(component.id))
    .map(component => nodeId(component.index))
  if (highlightedNodeIds.length > 0) {
    lines.push('  classDef overview fill:#fee2e2,stroke:#dc2626,stroke-width:3px,color:#111827')
    lines.push(`  class ${highlightedNodeIds.join(',')} overview`)
  }
  return `${lines.join('\n')}\n`
}
