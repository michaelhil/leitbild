import type { TopologyBinding, TopologyGraph } from '../../../core/observation/topology.ts'
import type { LayoutSubjectTopologyStructure } from './operation.ts'

const roles = new Set<TopologyBinding['role']>(['flow', 'running', 'conducting', 'position'])
export const layoutTopologyRefs = (topology: LayoutSubjectTopologyStructure): ReadonlyArray<string> =>
  [...new Set(topology.bindings.flatMap(binding => [binding.ref, ...(binding.while ? [binding.while] : [])]))]

/** Project an owner's declared graph; a component name or physical primitive
 * never establishes running/flow/position meaning. No layout algorithm runs. */
export const layoutSubjectTopologies = (graph: TopologyGraph, subjectIds: ReadonlyArray<string>): ReadonlyMap<string, LayoutSubjectTopologyStructure> => {
  const nodes = new Map(graph.nodes.map(node => [node.id, node])), elements = new Map<string, TopologyGraph['nodes'][number]>()
  for (const node of graph.nodes) {
    const id = node.element ?? node.id
    if (elements.has(id)) throw Error(`Owner topology has ambiguous layout element: ${id}`)
    elements.set(id, node)
  }
  const edges = new Map(graph.edges.map(edge => [edge.id, edge])), media = new Map(graph.media.map(medium => [medium.id, medium]))
  const result = new Map<string, LayoutSubjectTopologyStructure>()
  for (const id of subjectIds) {
    const node = elements.get(id), edge = edges.get(id)
    if (node && edge) throw Error(`Owner topology mixes component and connection identity: ${id}`)
    if (node) result.set(id, { kind: 'node', class: node.class, equipmentKind: node.kind, bindings: node.bindings.filter(binding => roles.has(binding.role)) })
    else if (edge) {
      const from = nodes.get(edge.from.node), to = nodes.get(edge.to.node), medium = media.get(edge.medium)
      if (!from || !to || !medium) throw Error(`Owner connection has no declared endpoints/medium: ${id}`)
      result.set(id, { kind: 'connection', directed: edge.directed, medium,
        from: { elementId: from.element ?? from.id, label: from.label, port: edge.from.port }, to: { elementId: to.element ?? to.id, label: to.label, port: edge.to.port },
        bindings: edge.bindings.filter(binding => roles.has(binding.role)) })
    }
  }
  return result
}
