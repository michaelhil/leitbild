import type { CompiledPlantGraph } from './model.ts'

const nodeId = (index: number): string => `c${index}`

export const plantGraphToMermaid = (graph: CompiledPlantGraph): string => {
  const lines = ['flowchart LR']
  for (const component of graph.components) {
    lines.push(`  ${nodeId(component.index)}["${component.label}"]`)
  }
  for (const link of graph.links) {
    const from = graph.components[link.fromComponentIndex]
    const to = graph.components[link.toComponentIndex]
    if (!from || !to) throw new Error(`compiled link ${link.id} references missing component index`)
    lines.push(`  ${nodeId(from.index)} -- "${link.kind}" --> ${nodeId(to.index)}`)
  }
  return `${lines.join('\n')}\n`
}
