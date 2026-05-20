import type { CompiledPlantGraph } from './model.ts'

const nodeId = (index: number): string => `c${index}`

export const plantGraphToMermaid = (graph: CompiledPlantGraph): string => {
  const lines = ['flowchart LR']
  for (const component of graph.components) {
    lines.push(`  ${nodeId(component.index)}["${component.label}"]`)
  }
  for (const edge of graph.edges) {
    const from = graph.components[edge.fromComponentIndex]
    const to = graph.components[edge.toComponentIndex]
    if (!from || !to) throw new Error(`compiled edge ${edge.id} references missing component index`)
    lines.push(`  ${nodeId(from.index)} -- "${edge.kind}" --> ${nodeId(to.index)}`)
  }
  return `${lines.join('\n')}\n`
}
