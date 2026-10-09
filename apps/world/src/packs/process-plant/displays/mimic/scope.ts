import type { CompiledPlantGraph, CompiledProcessLink } from '../../graph/index.ts'
import { carriersAt, downstreamLinks, linkCarrier, routeLinks, upstreamLinks } from '../../graph/index.ts'
import { SUGGESTION_COUNT, letters, matchedWords, normalized, words } from '../name-matching.ts'

// What a mimic draws, resolved from the agent's intent in plant terms. The
// scope comes from the static Plant graph alone (never from live values), so
// the same intent on the same model always draws the same equipment.

export interface MimicIntent {
  readonly from?: ReadonlyArray<string> | undefined
  readonly to?: ReadonlyArray<string> | undefined
  readonly services?: ReadonlyArray<string> | undefined
  readonly loops?: ReadonlyArray<string> | undefined
  readonly exclude?: ReadonlyArray<string> | undefined
}

/** Where the drawing stops: links that leave a drawn component for equipment not drawn, grouped by port. */
export interface MimicStub {
  readonly component: number
  readonly port: string
  /** `out`: flow leaves the drawing here; `in`: flow enters it. */
  readonly direction: 'in' | 'out'
  readonly links: ReadonlyArray<number>
  /** The far ends, by component and port. */
  readonly others: ReadonlyArray<{ readonly component: number; readonly port: string }>
}

export interface MimicScope {
  readonly components: ReadonlyArray<number>
  readonly links: ReadonlyArray<number>
  readonly stubs: ReadonlyArray<MimicStub>
  readonly carriers: ReadonlyArray<string>
  /** How each name resolved, for the compose result. */
  readonly names: ReadonlyArray<{ readonly name: string; readonly component: number; readonly via: 'id' | 'tag' | 'label' }>
}

export type MimicScopeResult =
  | { readonly ok: true; readonly scope: MimicScope }
  | { readonly ok: false; readonly issues: ReadonlyArray<{ readonly field: string; readonly message: string; readonly didYouMean?: ReadonlyArray<string> }> }

/** Steps down- or upstream a one-ended intent follows: enough to show a component's neighbours and theirs. */
export const MIMIC_REACH_LINKS = 3

const shortLabelOf = (graph: CompiledPlantGraph, index: number): string => {
  const component = graph.components[index]!
  return component.metadata?.presentation?.shortLabel ?? component.label
}

/** "sgB (Steam Generator B, SG B)". */
export const componentDescription = (graph: CompiledPlantGraph, index: number): string => {
  const component = graph.components[index]!
  const short = component.metadata?.presentation?.shortLabel
  return `${component.id} (${component.label}${short === undefined ? '' : `, ${short}`})`
}

const loopOf = (graph: CompiledPlantGraph, link: CompiledProcessLink): string | undefined =>
  link.metadata?.loopId
    ?? graph.components[link.fromComponentIndex]!.metadata?.loopId
    ?? graph.components[link.toComponentIndex]!.metadata?.loopId

// A name is a component id, a tag measured on equipment (its owner), or its
// label or short label, ignoring case, spaces and hyphens ("safety bus A",
// "SG-B"). A tag on a pipe names the pipe's end that the role points at: what
// a route starts from, or what it reaches.
const resolveName = (
  graph: CompiledPlantGraph,
  name: string,
  role: 'from' | 'to' | 'exclude',
): { readonly component: number; readonly via: 'id' | 'tag' | 'label' } | { readonly error: string; readonly didYouMean: ReadonlyArray<string> } => {
  const byId = graph.componentIndexById.get(name as never)
  if (byId !== undefined) return { component: byId, via: 'id' }
  const binding = graph.signalBindingByTagId.get(name as never)
  if (binding !== undefined) {
    if (binding.owner.type === 'component') return { component: binding.owner.componentIndex, via: 'tag' }
    const link = graph.links[binding.owner.linkIndex]!
    if (role === 'exclude') return { error: `${name} is measured on the pipe ${link.id}; exclude equipment, not a pipe`, didYouMean: [] }
    return { component: role === 'from' ? link.fromComponentIndex : link.toComponentIndex, via: 'tag' }
  }
  const wanted = normalized(name)
  const byLabel = graph.components.filter(component => [component.label, component.metadata?.presentation?.shortLabel]
    .some(label => label !== undefined && normalized(label) === wanted))
  if (byLabel.length === 1) return { component: byLabel[0]!.index, via: 'label' }
  if (byLabel.length > 1) return { error: `"${name}" names ${byLabel.length} components; name one by its id`, didYouMean: byLabel.slice(0, SUGGESTION_COUNT).map(component => componentDescription(graph, component.index)) }
  return { error: `unknown equipment "${name}"; name one component per entry: its id, a tag measured on it, its label or its short label`, didYouMean: equipmentSuggestions(graph, name) }
}

/** Components whose id, label, short label or tags match the guessed words best. */
export const equipmentSuggestions = (graph: CompiledPlantGraph, guess: string): ReadonlyArray<string> => {
  const guessed = words(guess)
  if (guessed.length === 0) return []
  const tagsByComponent = new Map<number, string[]>()
  for (const binding of graph.signalBindings) {
    if (binding.tagId === undefined || binding.owner.type !== 'component') continue
    tagsByComponent.set(binding.owner.componentIndex, [...(tagsByComponent.get(binding.owner.componentIndex) ?? []), String(binding.tagId)])
  }
  return graph.components
    .map(component => {
      const keys = [String(component.id), component.label, component.metadata?.presentation?.shortLabel ?? '', ...(tagsByComponent.get(component.index) ?? [])]
      const matched = matchedWords(guessed, [...new Set(keys.flatMap(words))])
      return { component, score: letters(matched) / letters(guessed), substantive: matched.some(word => word.length >= 2) }
    })
    .filter(entry => entry.substantive && entry.score >= 0.5)
    .sort((left, right) => right.score - left.score || String(left.component.id).localeCompare(String(right.component.id)))
    .slice(0, SUGGESTION_COUNT)
    .map(entry => {
      const tags = (tagsByComponent.get(entry.component.index) ?? []).slice(0, 2)
      return `${componentDescription(graph, entry.component.index)}${tags.length === 0 ? '' : `; tags ${tags.join(', ')}`}`
    })
}

/** The carriers of this Plant: its fluid services and its power and signal link kinds. */
export const plantCarriers = (graph: CompiledPlantGraph): ReadonlyArray<string> =>
  [...new Set(graph.links.filter(link => link.kind === 'fluidFlow' || link.kind === 'electricalPower').map(linkCarrier))].sort()

export const plantLoops = (graph: CompiledPlantGraph): ReadonlyArray<string> =>
  [...new Set(graph.components.map(component => component.metadata?.loopId).filter((loop): loop is string => loop !== undefined))]
    .sort((left, right) => {
      const ordinal = (loop: string) => graph.components.find(component => component.metadata?.loopId === loop)?.metadata?.ordinal ?? 0
      return ordinal(left) - ordinal(right) || left.localeCompare(right)
    })

// "AFW" for auxFeedwater: the guess's letters, in order, from the same first letter; or a shared word.
const serviceResembles = (guess: string, candidate: string): boolean => {
  const letters_ = guess.toLowerCase().replace(/[^a-z0-9]/g, '')
  const target = candidate.toLowerCase()
  let at = 0
  for (const letter of target) if (letter === letters_[at]) at += 1
  return (letters_.length >= 2 && letters_[0] === target[0] && at === letters_.length) || matchedWords(words(guess), words(candidate)).length > 0
}

const sorted = (indexes: Iterable<number>): ReadonlyArray<number> => [...new Set(indexes)].sort((left, right) => left - right)

export const resolveMimicScope = (graph: CompiledPlantGraph, intent: MimicIntent): MimicScopeResult => {
  const issues: Array<{ readonly field: string; readonly message: string; readonly didYouMean?: ReadonlyArray<string> }> = []
  const names: Array<MimicScope['names'][number]> = []
  const resolveAll = (field: 'from' | 'to' | 'exclude', list: ReadonlyArray<string> | undefined): ReadonlyArray<number> => (list ?? []).flatMap((name, index) => {
    const resolved = resolveName(graph, name, field)
    if ('error' in resolved) {
      issues.push({ field: `${field}.${index}`, message: resolved.error, ...(resolved.didYouMean.length === 0 ? {} : { didYouMean: resolved.didYouMean }) })
      return []
    }
    names.push({ name, component: resolved.component, via: resolved.via })
    return [resolved.component]
  })
  const from = resolveAll('from', intent.from)
  const to = resolveAll('to', intent.to)
  const excluded = new Set(resolveAll('exclude', intent.exclude))

  const known = plantCarriers(graph)
  for (const [index, service] of (intent.services ?? []).entries()) {
    if (known.includes(service)) continue
    const close = known.filter(candidate => serviceResembles(service, candidate))
    issues.push({ field: `services.${index}`, message: `${graph.specId} has no service ${service}; its services are ${known.join(', ')}`, ...(close.length === 0 ? {} : { didYouMean: close.slice(0, SUGGESTION_COUNT) }) })
  }
  const loops = plantLoops(graph)
  const unknownLoops = (intent.loops ?? []).filter(loop => !loops.includes(loop))
  if (unknownLoops.length > 0) issues.push({ field: 'loops', message: `loops ${unknownLoops.join(', ')} do not exist; this Plant has loops ${loops.join(', ')}` })
  if (from.length === 0 && to.length === 0 && intent.services === undefined && issues.length === 0) {
    issues.push({ field: '(mimic)', message: 'say what to draw: from and/or to (equipment), or services (with loops)' })
  }
  for (const anchor of [...from, ...to]) {
    if (excluded.has(anchor)) issues.push({ field: 'exclude', message: `${graph.components[anchor]!.id} is an end of the drawing and cannot be excluded` })
  }
  if (issues.length > 0) return { ok: false, issues }

  // Without services, a route uses what its ends deliver and receive; a one-ended
  // intent must say which service when its end has several.
  const ends = (list: ReadonlyArray<number>) => list.map(index => graph.components[index]!.id).join(', ')
  const delivered = (list: ReadonlyArray<number>) => new Set(list.flatMap(index => carriersAt(graph, index, 'out')).filter(carrier => known.includes(carrier)))
  const received = (list: ReadonlyArray<number>) => new Set(list.flatMap(index => carriersAt(graph, index, 'in')).filter(carrier => known.includes(carrier)))
  const shared = (left: ReadonlySet<string>, right: ReadonlySet<string>) => new Set([...left].filter(carrier => right.has(carrier)))
  const listed = (carriers: ReadonlySet<string>) => [...carriers].sort().join(', ') || 'nothing'
  // What equipment does carry, so a wrong service is corrected in one call.
  const carriedBy = (list: ReadonlyArray<number>) => list.map(index => `${graph.components[index]!.id} carries ${listed(new Set([...delivered([index]), ...received([index])]))}`).join('; ')
  const carriers: ReadonlySet<string> = intent.services !== undefined ? new Set(intent.services)
    : from.length > 0 && to.length > 0 ? shared(delivered(from), received(to))
      : from.length > 0 ? delivered(from) : received(to)
  if (intent.services === undefined && (from.length === 0 || to.length === 0) && carriers.size > 1) {
    const anchor = from.length > 0 ? from : to
    return { ok: false, issues: [{ field: 'services', message: `${ends(anchor)} ${from.length > 0 ? 'delivers' : 'receives'} ${[...carriers].sort().join(', ')}; add services to say which` }] }
  }

  const passable = (link: CompiledProcessLink): boolean => !excluded.has(link.fromComponentIndex) && !excluded.has(link.toComponentIndex)
  const allowed = new Set(graph.links.filter(link => carriers.has(linkCarrier(link)) && passable(link)).map(link => link.index))
  const subgraph = (indexes: ReadonlySet<number>): ReadonlySet<number> => new Set([...indexes].filter(index => allowed.has(index)))
  const reached = subgraph(
    from.length > 0 && to.length > 0 ? routeLinks(graph, from, to, carriers)
      : from.length > 0 ? downstreamLinks(graph, from, carriers, MIMIC_REACH_LINKS)
        : to.length > 0 ? upstreamLinks(graph, to, carriers, MIMIC_REACH_LINKS)
          : allowed,
  )
  // A reach that stops one step short of where the flow starts or ends (a
  // tank feeding the pumps) draws that end too: one symbol says more than a
  // stub at every pump it feeds.
  const terminalSteps = (from.length > 0) === (to.length > 0) ? [] : [...allowed].filter(index => {
    if (reached.has(index)) return false
    const link = graph.links[index]!
    const ends = new Set([...reached].flatMap(drawn => [graph.links[drawn]!.fromComponentIndex, graph.links[drawn]!.toComponentIndex]))
    const carried = (indexes: ReadonlyArray<number> | undefined) => (indexes ?? []).filter(other => allowed.has(other))
    return to.length > 0
      ? ends.has(link.toComponentIndex) && !ends.has(link.fromComponentIndex) && carried(graph.incomingLinksByComponent[link.fromComponentIndex]).length === 0
      : ends.has(link.fromComponentIndex) && !ends.has(link.toComponentIndex) && carried(graph.outgoingLinksByComponent[link.toComponentIndex]).length === 0
  })
  const selected = new Set([...reached, ...terminalSteps])
  if (selected.size === 0) {
    const reverseCarriers = intent.services !== undefined ? carriers : shared(delivered(to), received(from))
    const reverse = from.length > 0 && to.length > 0 && routeLinks(graph, to, from, reverseCarriers).size > 0
    if (from.length > 0 && to.length > 0 && carriers.size === 0 && !reverse) {
      return { ok: false, issues: [{ field: '(mimic)', message: `${ends(from)} delivers ${listed(delivered(from))} and ${ends(to)} receives ${listed(received(to))}: no service connects them` }] }
    }
    return {
      ok: false,
      issues: [{
        field: '(mimic)',
        message: reverse ? `${ends(to)} feeds ${ends(from)}, not the other way: swap from and to`
          : from.length > 0 && to.length > 0 ? `no ${[...carriers].join(' or ')} route from ${ends(from)} to ${ends(to)} in the Plant model; ${ends(from)} delivers ${listed(delivered(from))} and ${ends(to)} receives ${listed(received(to))}`
            : `nothing ${[...carriers].join(' or ')} connects to ${ends([...from, ...to])} in the Plant model; ${carriedBy([...from, ...to])}`,
      }],
    }
  }

  // Loops narrow a drawing to their own links and the shared equipment on routes into or out of them.
  const inLoops = (() => {
    if (intent.loops === undefined) return selected
    const wanted = new Set(intent.loops)
    const own = new Set([...selected].filter(index => {
      const loop = loopOf(graph, graph.links[index]!)
      return loop !== undefined && wanted.has(loop)
    }))
    const shared = new Set([...selected].filter(index => loopOf(graph, graph.links[index]!) === undefined))
    const ends = [...own].map(index => graph.links[index]!)
    const sharedSubset = new Set([...shared, ...own])
    const reachable = new Set([
      ...[...upstreamLinks(graph, ends.map(link => link.fromComponentIndex), carriers)],
      ...[...downstreamLinks(graph, ends.map(link => link.toComponentIndex), carriers)],
    ].filter(index => sharedSubset.has(index)))
    return new Set([...own, ...[...shared].filter(index => reachable.has(index))])
  })()

  const components = sorted([...inLoops].flatMap(index => [graph.links[index]!.fromComponentIndex, graph.links[index]!.toComponentIndex]))
  const drawn = new Set(components)
  // Links among drawn equipment of the drawn services are drawn too (a recirculation line, a cross-tie).
  const links = sorted([...allowed].filter(index => {
    if (inLoops.has(index)) return true
    const link = graph.links[index]!
    return drawn.has(link.fromComponentIndex) && drawn.has(link.toComponentIndex) && (intent.loops === undefined || loopOf(graph, link) === undefined || intent.loops.includes(loopOf(graph, link)!))
  }))
  const drawnLinks = new Set(links)

  // Every other link of a drawn service at a drawn component is where the drawing
  // stops. Narrowed to loops, flow into a shared hub from the other loops is not
  // part of the question; flow leaving the drawing toward them still is.
  const otherLoop = (link: CompiledProcessLink): boolean => intent.loops !== undefined && loopOf(graph, link) !== undefined && !intent.loops.includes(loopOf(graph, link)!)
  const stubsByKey = new Map<string, { component: number; port: string; direction: 'in' | 'out'; links: number[]; others: Array<{ component: number; port: string }> }>()
  for (const component of components) {
    for (const [direction, indexes] of [['out', graph.outgoingLinksByComponent[component]], ['in', graph.incomingLinksByComponent[component]]] as const) {
      for (const index of indexes ?? []) {
        const link = graph.links[index]!
        if (drawnLinks.has(index) || !carriers.has(linkCarrier(link))) continue
        if (direction === 'in' && otherLoop(link)) continue
        // A link with both ends drawn but left out stops where it leaves, not where it arrives.
        if (direction === 'in' && drawn.has(link.fromComponentIndex)) continue
        const port = String(direction === 'out' ? link.fromPortName : link.toPortName)
        // Alike ports of one circuit (a header's outlets) stop the drawing once, naming every far end.
        const circuit = graph.components[component]!.ports[port]?.circuit
        const key = `${component}|${circuit ?? port}|${direction}`
        const stub = stubsByKey.get(key) ?? { component, port, direction, links: [], others: [] }
        stub.links.push(index)
        stub.others.push(direction === 'out' ? { component: link.toComponentIndex, port: String(link.toPortName) } : { component: link.fromComponentIndex, port: String(link.fromPortName) })
        stubsByKey.set(key, stub)
      }
    }
  }
  const stubs = [...stubsByKey.values()]
    .map(stub => ({ ...stub, links: sorted(stub.links), others: [...stub.others].sort((left, right) => left.component - right.component || left.port.localeCompare(right.port)) }))
    .sort((left, right) => left.component - right.component || left.port.localeCompare(right.port) || left.direction.localeCompare(right.direction))
  return { ok: true, scope: { components, links, stubs, carriers: [...carriers].sort(), names } }
}

const STUB_NAMES = 3

/** "cold leg A" for a port named coldLegA. */
const portName = (port: string): string => words(port).map(word => word.length === 1 ? word.toUpperCase() : word).join(' ')

/**
 * "to SG A, SG C, SG D", "to Core cold leg A, cold leg B" where one far
 * component has several such ports, or "to PZR, RCP A, RCP C and 8 more".
 */
export const stubText = (graph: CompiledPlantGraph, stub: MimicStub): string => {
  const byComponent = new Map<number, string[]>()
  for (const other of stub.others) byComponent.set(other.component, [...(byComponent.get(other.component) ?? []), other.port])
  const parts = [...byComponent].map(([component, ports]) => {
    // Ports are named only where the far component has several alike (the core's cold legs).
    const far = graph.components[component]!
    const first = far.ports[ports[0]!]
    const alike = Object.values(far.ports).filter(port => port.circuit !== undefined && port.circuit === first?.circuit && port.direction === first.direction)
    return alike.length > 1 ? `${shortLabelOf(graph, component)} ${ports.map(portName).join(', ')}` : shortLabelOf(graph, component)
  })
  const named = parts.slice(0, parts.length > STUB_NAMES + 1 ? STUB_NAMES : STUB_NAMES + 1)
  const more = parts.length - named.length
  return `${stub.direction === 'out' ? 'to' : 'from'} ${named.join(', ')}${more > 0 ? ` and ${more} more` : ''}`
}
