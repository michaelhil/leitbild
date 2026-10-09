import type { CompiledPlantGraph, CompiledProcessLink } from './model.ts'

/**
 * The flow a link is rated for: its own nominal flow, else what the equipment
 * driving it is rated to deliver, found upstream through the components it
 * passes (ports in one circuit) on the same service. Where several drivers
 * feed it, the largest one bounds it. Null when nothing upstream is rated, so
 * a reader cannot judge "no flow" on that link.
 */
export const ratedFlowForLink = (graph: CompiledPlantGraph, link: CompiledProcessLink): number | null => {
  const visited = new Set<number>()
  const rated = (current: CompiledProcessLink): number | null => {
    if (visited.has(current.index)) return null
    visited.add(current.index)
    const nominal = current.physical?.nominalFlowKgPerS
    if (nominal !== undefined) return nominal
    const source = graph.components[current.fromComponentIndex]
    if (source === undefined) throw new Error(`link ${current.id} references a missing source component`)
    const own = source.semantics.ratedOutflow.find(rating => rating.port === current.fromPortName)
    if (own !== undefined) return own.flowKgPerS
    const circuit = source.ports[String(current.fromPortName)]?.circuit
    if (circuit === undefined) return null
    const upstream = (graph.incomingLinksByComponent[source.index] ?? [])
      .map(index => graph.links[index]!)
      .filter(incoming => incoming.kind === 'fluidFlow' && incoming.service === current.service && source.ports[String(incoming.toPortName)]?.circuit === circuit)
      .map(rated)
      .filter((flow): flow is number => flow !== null)
    return upstream.length === 0 ? null : Math.max(...upstream)
  }
  return rated(link)
}
