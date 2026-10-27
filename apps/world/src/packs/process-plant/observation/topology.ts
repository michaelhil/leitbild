import type { ObjectId } from '../../../core/model/index.ts'
import type { TopologyGraph } from '../../../core/observation/topology.ts'
import { words } from '../../../core/model/text-search.ts'
import type { CompiledComponent, CompiledPlantGraph, CompiledStateAspect, ComponentId, ProcessSignalBinding, StateAspect, VariablePath } from '../graph/index.ts'
import { equipmentItemLabel } from '../equipment/items.ts'
import { linkCarrier } from '../graph/index.ts'
import { plantCarriers, plantLoops, principalCircuits } from '../equipment/circuits.ts'
import { electricalExternalPortId } from '../electrical-ports.ts'
import type { CompiledProcessPlant } from '../plant-compiler.ts'
import { insertionPositions, itemStateRoles, stoppedPaths } from './derived.ts'
import {lineStateSignals} from './line-state.ts'

// The Plant as World's `flow` topology (plan v3.1 §2.9, architecture A5):
// equipment as nodes with the ports its pipes and cables join, each port's
// circuit (the ports flow passes between inside the node) and the services
// it carries; every pipe and cable a drawing can show as an edge of its
// service, with its loop where it has its own. Media are the services, so a
// drawing narrows by them; groups are the loops, laned in their order. Nodes
// and edges keep the model's order, which every drawing's order follows.
// Bindings read the signals the Plant publishes, so a drawing shows live
// state: the values its kind reads first (value), in that order, which a
// drawing writes; a store's level, a mover running, a breaker's contacts or a
// supply live (conducting), what passes a header, a valve's position; a
// pipe's flow, a cable live. A share (a level, a power in percent) carries the
// word a drawing writes before it, since its unit does not say what it reads.
// A grid source
// with an external port is the boundary a Scenario connection joins. The
// overview is the principal circuits (equipment/circuits.ts), as the unit
// overview has always drawn them; World adds where the drawing stops.

const classOf = (component: CompiledComponent): TopologyGraph['nodes'][number]['class'] => {
  const energy = component.semantics.energy.map(role => role.role)
  if (energy.includes('source')) return 'source'
  if (energy.includes('transfer')) return 'transfer'
  if (energy.includes('sink')) return 'sink'
  const aspects = component.semantics.aspects.map(aspect => aspect.aspect)
  return aspects.includes('level') ? 'store' : aspects.includes('position') ? 'switch' : aspects.includes('running') ? 'mover' : aspects.includes('energized') ? 'bus' : 'junction'
}

const capitalized = (text: string): string => `${text.charAt(0).toUpperCase()}${text.slice(1)}`

type Bindings = TopologyGraph['nodes'][number]['bindings']
/** The word a drawing writes before a share (a percent or a fraction), by what it measures; the rest say it in their unit. */
const SHARE_WORDS: Readonly<Record<string, string>> = { level: 'LVL', power: 'PWR' }
const READINGS: ReadonlySet<string> = new Set(['level', 'value', 'flow', 'loading'])
const wordOf = (signal: ProcessSignalBinding): string | undefined => {
  if (signal.unit !== 'percent' && signal.unit !== 'fraction') return undefined
  const word = SHARE_WORDS[signal.quantity === 'ratio' ? signal.measurand ?? '' : signal.quantity]
  if (word === undefined) throw new Error(`${signal.path} is a share a drawing reads, and no word says what it reads`)
  return word
}
/** The roles whose signal the Plant publishes, each role and signal once; a reading of a share with its word. */
const bound = (objectId: ObjectId, graph: CompiledPlantGraph, roles: ReadonlyArray<readonly [Bindings[number]['role'], VariablePath | undefined]>): Bindings =>
  roles.flatMap(([role, path], index) => {
    const signal = path === undefined ? undefined : graph.signalBindingByPath.get(path)
    if (signal?.published !== true || roles.slice(0, index).some(([other, at]) => other === role && at === path)) return []
    const word = READINGS.has(role) ? wordOf(signal) : undefined
    return [{ role, ref: `${objectId}#${path}`, ...(word === undefined ? {} : { word }) }]
  })

/** What an item's state aspects drive: its level, running, contacts or supply (conducting), what passes it, a valve's opening (position). */
const aspectRoles = (aspects: ReadonlyArray<CompiledStateAspect>): ReadonlyArray<readonly [Bindings[number]['role'], VariablePath | undefined]> => {
  const state = (aspect: StateAspect) => aspects.find(candidate => candidate.aspect === aspect)?.state
  const [position, running, energized] = [state('position'), state('running'), state('energized')]
  return [
    ['level', state('level')?.path],
    ['running', running?.reading === 'true' ? running.path : undefined],
    ['conducting', position?.reading === 'closedWhileTrue' ? position.path : position === undefined && energized?.reading === 'true' ? energized.path : undefined],
    ['flow', state('throughput')?.path],
    ['position', position?.reading === 'value' ? position.path : undefined],
  ]
}

/** Its key values first, as its kind ranks them (a drawing writes its readings in this order), then what its aspects drive. */
const nodeBindings = (objectId: ObjectId, graph: CompiledPlantGraph, component: CompiledComponent): Bindings => bound(objectId, graph, [
  ...component.semantics.keyValues.map(path => ['value', path] as const),
  ...aspectRoles(component.semantics.aspects),
])

/**
 * What a component's instruments read in turn (a core's neutron flux: counted by its source range, read as a current
 * by its intermediate range while P-6 holds and in percent by its power range while P-10 does), narrowest first,
 * each wider one while its flag holds; a chain any of whose signals or flags the Plant does not publish is left out.
 */
const inTurn = (objectId: ObjectId, graph: CompiledPlantGraph, component: CompiledComponent): Bindings => {
  const switched = component.semantics.widerRanges.filter(range => range.while !== undefined)
  const next = new Map(switched.map(range => [range.reading, range]))
  const widened = new Set(switched.map(range => range.wider))
  const published = (path: VariablePath): boolean => graph.signalBindingByPath.get(path)?.published === true
  // The compiler holds each chain free of returns, so following it ends.
  return switched.filter(range => !widened.has(range.reading)).flatMap(root => {
    const steps: Array<{ readonly path: VariablePath; readonly while?: VariablePath }> = [{ path: root.reading }]
    for (let range = next.get(root.reading); range !== undefined; range = next.get(range.wider)) steps.push({ path: range.wider, while: range.while! })
    if (!steps.every(step => published(step.path) && (step.while === undefined || published(step.while)))) return []
    return steps.map(step => {
      const word = wordOf(graph.signalBindingByPath.get(step.path)!)
      return { role: 'value' as const, ref: `${objectId}#${step.path}`, ...(step.while === undefined ? {} : { while: `${objectId}#${step.while}` }), ...(word === undefined ? {} : { word }) }
    })
  })
}

const graphs = new WeakMap<CompiledPlantGraph, TopologyGraph>()

/** A Plant graph's flow topology, built once per compiled graph, as the object it is named by and at the revision given (a Plant's model digest). */
export const plantTopology = (objectId: ObjectId, graph: CompiledPlantGraph, revision: string): TopologyGraph => {
  const known = graphs.get(graph)
  if (known !== undefined && known.objectId === objectId && known.revision === revision) return known
  const carriers = new Set(plantCarriers(graph))
  const links = graph.links.filter(link => carriers.has(linkCarrier(link)))
  const lineStates=lineStateSignals(graph)
  const portMedia = new Map<string, Set<string>>()
  for (const link of links) {
    for (const key of [`${link.fromComponentIndex}|${link.fromPortName}`, `${link.toComponentIndex}|${link.toPortName}`]) portMedia.set(key, new Set([...(portMedia.get(key) ?? []), linkCarrier(link)]))
  }
  const topology: TopologyGraph = {
    objectId,
    revision,
    family: 'flow',
    media: [...carriers].map(carrier => ({
      id: carrier,
      label: capitalized(words(carrier).join(' ')).slice(0, 40),
      kind: links.some(link => linkCarrier(link) === carrier && link.kind === 'electricalPower') ? 'electric-ac' as const
        : links.some(link => linkCarrier(link) === carrier && link.nominalFluid === 'steam') ? 'steam' as const : 'fluid' as const,
    })),
    groups: plantLoops(graph).map((loop, order) => ({ id: loop, label: `Loop ${loop}`, kind: 'loop', lane: { key: loop, order } })),
    nodes: graph.components.flatMap(component => {
      const ports = Object.entries(component.ports).flatMap(([name, port]) => {
        const media = portMedia.get(`${component.index}|${name}`)
        return media === undefined ? [] : [{
          id: name, rank: name, media: [...media].sort(), direction: port.direction === 'bidirectional' ? 'both' as const : port.direction === 'out' ? 'out' as const : 'in' as const,
          ...(port.circuit === undefined ? {} : { circuit: port.circuit }),
        }]
      })
      const shortLabel = component.metadata?.presentation?.shortLabel
      return ports.length === 0 ? [] : [{
        id: String(component.id), element: String(component.id), class: classOf(component), kind: component.kind, label: component.label,
        ...(shortLabel === undefined ? {} : { shortLabel }),
        rank: [component.kind, component.metadata?.equipmentClass ?? '', component.metadata?.role ?? ''].join('|'),
        ...(component.metadata?.loopId === undefined ? {} : { group: component.metadata.loopId }),
        ports, bindings: nodeBindings(objectId, graph, component),
      }]
    }),
    edges: links.map(link => ({
      id: String(link.id), rank: `${linkCarrier(link)}|${link.id}`, medium: linkCarrier(link), directed: true,
      bindings: (lineStates.byLink.get(String(link.id))??[]).map(({role,signal})=>({role,ref:`${objectId}#${signal.path}`})),
      from: { node: String(graph.components[link.fromComponentIndex]!.id), port: String(link.fromPortName) },
      to: { node: String(graph.components[link.toComponentIndex]!.id), port: String(link.toPortName) },
      ...(link.metadata?.loopId === undefined ? {} : { group: link.metadata.loopId }),
    })),
    boundaries: [],
  }
  const principal = principalCircuits(graph)
  const withBoundaries: TopologyGraph = {
    ...topology,
    boundaries: topology.nodes.flatMap(node => {
      const externalPortId = electricalExternalPortId(graph.components[graph.componentIndexById.get(node.id as ComponentId)!]!)
      return externalPortId === undefined ? [] : node.ports.map(port => ({ node: node.id, port: port.id, externalPortId }))
    }),
    ...(!principal.ok ? {} : { overview: { nodes: principal.components.map(index => String(graph.components[index]!.id)), edges: principal.links.map(index => String(graph.links[index]!.id)) } }),
  }
  graphs.set(graph, withBoundaries)
  return withBoundaries
}

/**
 * Each device a component bundles (a pressurizer's PORV and its block valve)
 * as a switch on the line its port feeds, from the component outward in the
 * order the component declares them, named as the equipment item it is
 * (equipment/items.ts): a person reaches and operates it as its own element.
 */
const withDevices = (objectId: ObjectId, graph: CompiledPlantGraph, topology: TopologyGraph): TopologyGraph => {
  const nodes = [...topology.nodes]
  let edges = [...topology.edges]
  for (const component of graph.components) {
    const host = topology.nodes.find(node => node.id === String(component.id))
    for (const port of host?.ports ?? []) {
      const devices = component.semantics.embedded.filter(device => String(device.port) === port.id)
      if (host === undefined || devices.length === 0) continue
      const outward = port.direction !== 'in'
      const chain = (outward ? devices : [...devices].reverse()).map(device => {
        const id = `${component.id}.${device.id}`
        const label = equipmentItemLabel(component, device)
        const ports = (['in', 'out'] as const).map(direction => ({ id: direction, rank: direction, media: port.media, direction, circuit: 'through' }))
        return { id, element: id, class: 'switch' as const, kind: device.function, label, ...(label.length <= 24 ? { shortLabel: label } : {}), rank: `${host.rank}|${device.id}`, ...(host.group === undefined ? {} : { group: host.group }), ports, bindings: bound(objectId, graph, aspectRoles(device.aspects)) }
      })
      nodes.push(...chain)
      const media = [...new Set(edges.filter(edge => (outward ? edge.from : edge.to).node === host.id && (outward ? edge.from : edge.to).port === port.id).map(edge => edge.medium))]
      // The line now leaves (or enters) at the far device; the component and its devices join in a row, one edge per medium.
      edges = edges.map(edge => outward && edge.from.node === host.id && edge.from.port === port.id ? { ...edge, from: { node: chain.at(-1)!.id, port: 'out' } }
        : !outward && edge.to.node === host.id && edge.to.port === port.id ? { ...edge, to: { node: chain[0]!.id, port: 'in' } } : edge)
      const joins = chain.map((node, at) => outward
        ? [at === 0 ? { node: host.id, port: port.id } : { node: chain[at - 1]!.id, port: 'out' }, { node: node.id, port: 'in' }] as const
        : [{ node: node.id, port: 'out' }, at === chain.length - 1 ? { node: host.id, port: port.id } : { node: chain[at + 1]!.id, port: 'in' }] as const)
      for (const [from, to] of joins) {
        for (const medium of media) edges.push({ id: `${from.node}>${to.node}:${medium}`, rank: `${medium}|${from.node}>${to.node}`, from, to, medium, directed: true, bindings: [], ...(host.group === undefined ? {} : { group: host.group }) })
      }
    }
  }
  return { ...topology, nodes, edges }
}

const served = new WeakMap<CompiledProcessPlant, TopologyGraph>()

/**
 * What a drawing traces over its last ten minutes with an item (W6.6; the old mimic's vessel trends): a tank's or a
 * heat exchanger's level, and a heat source's own readings outside what its instruments read in turn (a core's exit
 * temperature); and the program a level is held to (a pressurizer's level program), which the drawing marks on it.
 */
const withTraces = (objectId: ObjectId, graph: CompiledPlantGraph, component: CompiledComponent, kind: TopologyGraph['nodes'][number]['class'], bindings: Bindings, turns: Bindings): Bindings => {
  if (kind === 'store' || kind === 'transfer') {
    const level = bindings.find(binding => binding.role === 'level')
    if (level === undefined) return bindings
    const program = component.semantics.programs.find(entry => `${objectId}#${entry.reading}` === level.ref)?.program
    const programmed = program !== undefined && graph.signalBindingByPath.get(program)?.published === true ? [{ role: 'program' as const, ref: `${objectId}#${program}` }] : []
    return [...bindings.map(binding => (binding === level ? { ...binding, trace: true as const } : binding)), ...programmed]
  }
  if (kind !== 'source') return bindings
  const own = bindings.filter(binding => binding.role === 'value' && !turns.some(turn => turn.ref === binding.ref))
  return own.length === 0 ? bindings : bindings.map(binding => (own.includes(binding) ? { ...binding, trace: true as const } : binding))
}

/**
 * The topology the Plant serves World: its graph's, with the devices its
 * equipment bundles drawn on their lines; each item that runs, is live, or
 * opens and shuts bound to its state observable (derived.ts) for running or
 * conducting, so a drawing writes its word (RUN, SHUT, ON LINE) and the
 * command it does not follow (a valve's glyph still opens with its position);
 * equipment a trip stops bound to what says it stopped ("Rods on bottom"),
 * with the trip it does not follow; what its instruments read in turn (a
 * core's flux on the instrument in range) its first reading; and what it
 * inserts, part by part in its groups (a core's shutdown banks, then its
 * control banks).
 */
export const servedPlantTopology = (objectId: ObjectId, plant: CompiledProcessPlant): TopologyGraph => {
  const known = served.get(plant)
  if (known !== undefined && known.objectId === objectId) return known
  const topology = withDevices(objectId, plant.graph, plantTopology(objectId, plant.graph, plant.modelDigest))
  const roles = itemStateRoles(plant)
  const parts = insertionPositions(plant)
  const stopped = stoppedPaths(plant)
  const bound: TopologyGraph = { ...topology, nodes: topology.nodes.map(node => {
    const index = plant.graph.componentIndexById.get(node.id as ComponentId)
    const state = roles.get(node.id)
    const stop = stopped.get(node.id)
    const turns = index === undefined ? [] : inTurn(objectId, plant.graph, plant.graph.components[index]!)
    // Its state observable runs or conducts it in place of the signal it rests on: its word, and the command it does not follow.
    const stated = [
      ...(state === undefined ? [] : [{ role: state.role, ref: `${objectId}#${state.path}`, ...(state.commanded ? { commanded: true as const } : {}) }]),
      ...(stop === undefined ? [] : [{ role: 'stopped' as const, ref: `${objectId}#${stop}` }]),
    ]
    const kept = node.bindings.filter(binding => (state === undefined || binding.role !== state.role) && !turns.some(turn => turn.ref === binding.ref))
    // What it inserts (a core's rod banks), each part at the share of its range it stands inserted (1 fully in), in its group.
    const positions = (parts.get(node.id) ?? []).flatMap((group, at) => group.map(path => ({ role: 'position' as const, ref: `${objectId}#${path}`, group: String(at + 1) })))
    const bindings = stated.length === 0 && turns.length === 0 && positions.length === 0 ? node.bindings : [...stated, ...turns, ...kept, ...positions]
    const traced = index === undefined ? bindings : withTraces(objectId, plant.graph, plant.graph.components[index]!, node.class, bindings, turns)
    return traced === node.bindings ? node : { ...node, bindings: traced }
  }) }
  served.set(plant, bound)
  return bound
}
