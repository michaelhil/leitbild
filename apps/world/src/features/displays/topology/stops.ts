// Where a flow drawing stops (plan v5 W6.2; #41, #42, U-17): what a stop
// says and draws. Its label writes "to" or "from" and the names of what lies
// beyond: alike names (one designator apart, "SG B", "SG C") once with how
// many ("SG ×3"), and what its room does not hold counted ("+4 more"), never
// cut. Under it, on a power line, the state of the equipment it names (LIVE,
// DEAD, LIVE 1/2), never of the line towards it, which its pipe draws: a dead
// line through an open breaker to a bus a diesel holds live. A stop opens the
// equipment it names.
import type { TopologyGraph, TopologyNode } from '../../../core/observation/topology.ts'

/** Where a drawing stops: whether flow leaves through it ("to") or comes in ("from"), what it writes, its far ends' node ids, the lines it stands for and their medium. */
export interface DrawnStop {
  readonly direction: 'in' | 'out'
  readonly label: string
  readonly far: ReadonlyArray<string>
  readonly edges: ReadonlyArray<string>
  readonly medium: string
}

/** The most characters a stop's label takes before what it does not name is counted ("+4 more"); one name is never cut. */
export const STOP_CHARACTERS = 32

/** A word that tells alike items apart: one capital letter, or a number. */
const DESIGNATOR = /^([A-Z]|\d+)$/
/** A name without its one designator ("SG" for "SG B"); null for a name with none, or with several. */
const stemOf = (name: string): string | null => {
  const words = name.split(' ')
  const designators = words.filter(word => DESIGNATOR.test(word))
  return words.length < 2 || designators.length !== 1 ? null : words.filter(word => word !== designators[0]).join(' ')
}

/**
 * What a stop writes: "from AFW valve A", "to PZR, SG B, SG C, SG D", "from RCP ×4", "from ACC check valve ×4 +4 more";
 * without its direction's word (`direction` null) where its drawing has no room for it (flow-sizing.ts flowLayout).
 */
export const stopLabel = (direction: 'in' | 'out' | null, names: ReadonlyArray<string>, characters = STOP_CHARACTERS): string => {
  const verb = direction === null ? '' : direction === 'out' ? 'to ' : 'from '
  const unique = [...new Set(names)]
  const whole = `${verb}${unique.join(', ')}`
  if (whole.length <= characters) return whole
  const parts: Array<{ readonly stem: string | null; readonly names: string[] }> = []
  for (const name of unique) {
    const stem = stemOf(name)
    const alike = stem === null ? undefined : parts.find(part => part.stem === stem)
    if (alike === undefined) parts.push({ stem, names: [name] })
    else alike.names.push(name)
  }
  const texts = parts.map(part => (part.names.length > 1 ? `${part.stem} ×${part.names.length}` : part.names[0]!))
  const grouped = `${verb}${texts.join(', ')}`
  if (grouped.length <= characters || texts.length === 1) return grouped
  for (let kept = texts.length - 1; ; kept -= 1) {
    const counted = `${verb}${texts.slice(0, kept).join(', ')} +${parts.slice(kept).reduce((sum, part) => sum + part.names.length, 0)} more`
    if (counted.length <= characters || kept === 1) return counted
  }
}

type Binding = TopologyNode['bindings'][number]
/** A far end's state: its running or conducting binding. */
export const farState = <T extends Pick<Binding, 'role'>>(bindings: ReadonlyArray<T>): T | undefined => bindings.find(binding => binding.role === 'running' || binding.role === 'conducting')

/** Whether a stop writes the state of what it names: a power line's, where every far end has a state. */
export const stopStated = (graph: Pick<TopologyGraph, 'nodes' | 'edges' | 'media'>, stop: { readonly edges: ReadonlyArray<string>; readonly others: ReadonlyArray<{ readonly node: string }> }): boolean => {
  const medium = graph.edges.find(edge => edge.id === stop.edges[0])?.medium
  const kind = graph.media.find(entry => entry.id === medium)?.kind
  return (kind === 'electric-ac' || kind === 'electric-dc') && stop.others.every(other => farState(graph.nodes.find(node => node.id === other.node)?.bindings ?? []) !== undefined)
}

/**
 * A stop as a drawing names it (the section's node and its edge): its label, its direction and each far end with
 * its element and its state's binding, which the caller reads where the stop writes it; its edge with the flow its
 * lines read, so its pipe draws the line as the lines are.
 */
export const stopViews = <B>(graph: TopologyGraph, id: string, stop: DrawnStop, bound: (bindings: TopologyNode['bindings']) => ReadonlyArray<B>) => ({
  node: {
    id, class: 'stop' as const, label: stop.label, bindings: [] as ReadonlyArray<B>,
    stop: {
      direction: stop.direction,
      far: stop.far.map(at => {
        const node = graph.nodes.find(entry => entry.id === at)!
        const state = farState(node.bindings)
        return { id: node.id, label: node.shortLabel ?? node.label, ...(node.element === undefined ? {} : { element: node.element }), bindings: bound(state === undefined ? [] : [state]) }
      }),
    },
  },
  edge: { id: `${id}.edge`, mediumKind: graph.media.find(entry => entry.id === stop.medium)!.kind, bindings: bound(stop.edges.flatMap(edge => graph.edges.find(entry => entry.id === edge)?.bindings.filter(binding => binding.role === 'flow') ?? [])) },
})

/** What a drawing's stops read: the flow of the lines each stands for, and the state of what a stated one names. */
export const stopRefs = (graph: TopologyGraph, stubs: ReadonlyArray<{ readonly edges: ReadonlyArray<string>; readonly others: ReadonlyArray<{ readonly node: string }> }>): ReadonlyArray<string> => stubs.flatMap(stub => [
  ...stub.edges.flatMap(edge => graph.edges.find(entry => entry.id === edge)?.bindings.filter(binding => binding.role === 'flow').map(binding => binding.ref) ?? []),
  ...(stopStated(graph, stub) ? stub.others.flatMap(other => farState(graph.nodes.find(node => node.id === other.node)?.bindings ?? [])?.ref ?? []) : []),
])
