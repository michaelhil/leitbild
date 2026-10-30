import type { CompiledComponent, CompiledPlantGraph, CompiledProcessLink } from '../graph/index.ts'
import type { CompiledProcessPlant } from '../plant-compiler.ts'
import { componentVariablePath, processLinkVariablePath, type ProcessPlantBehaviorContext } from './behavior-contract.ts'
import { clamp, optionalParameterNumber, parameterNumber } from './component-helpers.ts'
import { primarySystemPressurizer } from './system-topology.ts'
import { physicalFlowCapacityKgPerS } from './links/process-link-physical.ts'

// Explicitly selected, directed liquid delivery. This is a finite-capacity
// demand model, not a pressure-equilibrium or reverse-flow solver. Inventories
// are boundaries; pumps preserve their own curves and do not transmit a later
// pump's receiving pressure backwards through its suction.
type Node = {
  readonly index: number
  readonly component: CompiledComponent
  readonly kind: 'source' | 'receiver' | 'pump' | 'passive'
  readonly port: string
  readonly incoming: number[]
  readonly outgoing: number[]
}
type Edge = { readonly link: CompiledProcessLink; readonly from: number; readonly to: number }
type Network = { readonly nodes: readonly Node[]; readonly edges: readonly Edge[]; readonly order: readonly number[]; readonly nearestPumps: readonly (readonly CompiledComponent[])[]; readonly edgeByLink: ReadonlyMap<number, number>; readonly pumpNodes: ReadonlyMap<number, number> }
const networks = new WeakMap<CompiledPlantGraph, Network | null>()
const passiveKinds = new Set(['processHeader', 'processValve', 'heatExchanger'])
const receivers = new Set(['reactorCore', 'reactorVessel', 'steamGenerator', 'condenserSink', 'atmosphereBoundary'])

export const isDirectedDeliveryHeader = (component: CompiledComponent): boolean => component.kind === 'processHeader'
  && (component.parameters as Readonly<Record<string, unknown>>).distributionMode === 'directedDelivery'

const networkFor = (graph: CompiledPlantGraph): Network | null => {
  if (networks.has(graph)) return networks.get(graph)!
  const seeds = graph.components.filter(isDirectedDeliveryHeader)
  if (seeds.length === 0) { networks.set(graph, null); return null }
  const nodes: Node[] = [], edges: Edge[] = [], byKey = new Map<string, number>()
  const nodeFor = (component: CompiledComponent, port: string, from: boolean): number => {
    const stored = component.kind === 'processTank' || component.kind === 'containmentVolume'
    const kind: Node['kind'] = stored ? from ? 'source' : 'receiver'
      : component.kind === 'centrifugalPump' ? 'pump' : passiveKinds.has(String(component.kind)) ? 'passive' : from ? 'source' : 'receiver'
    const circuit = component.ports[port]?.circuit
    const boundary = kind === 'source' || kind === 'receiver'
    const key = `${component.index}:${boundary ? `${kind}:${from && stored ? 'inventory' : from ? port : circuit}` : circuit}`
    const found = byKey.get(key)
    if (found !== undefined) return found
    const index = nodes.length
    nodes.push({ index, component, kind, port, incoming: [], outgoing: [] }); byKey.set(key, index)
    return index
  }
  for (const link of graph.links) {
    if (link.kind !== 'fluidFlow') continue
    const from = nodeFor(graph.components[link.fromComponentIndex]!, String(link.fromPortName), true)
    const to = nodeFor(graph.components[link.toComponentIndex]!, String(link.toPortName), false)
    const index = edges.length; edges.push({ link, from, to }); nodes[from]!.outgoing.push(index); nodes[to]!.incoming.push(index)
  }
  const selectedNodes = new Set<number>(), selectedEdges = new Set<number>()
  const queue = nodes.filter(node => seeds.includes(node.component)).map(node => node.index)
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const index = queue[cursor]!
    if (selectedNodes.has(index)) continue
    selectedNodes.add(index)
    const node = nodes[index]!
    // A receiving volume never pulls unrelated primary loops or other supplies
    // into this model. A source includes every consumer of its one budget.
    const adjacent = node.kind === 'receiver' ? [] : node.kind === 'source' ? node.outgoing : [...node.incoming, ...node.outgoing]
    for (const edgeIndex of adjacent) {
      selectedEdges.add(edgeIndex)
      const edge = edges[edgeIndex]!
      queue.push(edge.from, edge.to)
    }
  }
  const chosen = [...selectedEdges].sort((a, b) => a - b).map(index => edges[index]!)
  for (const { link, from } of chosen) {
    const finiteBoundary = nodes[from]!.kind === 'source' && link.solverModel === 'sourceSink'
    if (link.nominalFluid !== 'water' || link.designPhase !== 'liquid' || !(link.solverModel === 'incompressibleLiquid' || finiteBoundary)) throw new Error(`directed delivery link ${link.id} requires explicit liquid water with an incompressible or finite-source model`)
    if (!link.variables.some(variable => String(variable.path) === `${link.id}.flowKgPerS`)) throw new Error(`directed delivery link ${link.id} requires an actual flow variable`)
    if (link.variables.some(variable => String(variable.path) === `${link.id}.leak.areaFraction` || String(variable.path) === `${link.id}.leakFlowKgPerS`)) throw new Error(`directed delivery link ${link.id} cannot declare an unrepresented leak branch`)
  }
  for (const index of selectedNodes) {
    const node = nodes[index]!, component = node.component
    node.incoming.splice(0, node.incoming.length); node.outgoing.splice(0, node.outgoing.length)
    if (component.kind === 'processHeader' && (component.parameters as Readonly<Record<string, unknown>>).distributionMode === 'pressureBalance') throw new Error(`directed delivery cannot also own pressure-balanced header ${component.id}`)
    if (node.kind === 'pump' && (component.parameters as Readonly<Record<string, unknown>>).primaryLoopId !== undefined) throw new Error(`directed delivery cannot own primary-loop pump ${component.id}`)
    if (node.kind === 'source' && component.kind !== 'processTank' && !(component.kind === 'containmentVolume' && node.port === 'sumpOut')) throw new Error(`directed delivery requires a finite liquid source at ${component.id}.${node.port}`)
    if (node.kind === 'receiver' && component.kind !== 'processTank' && component.kind !== 'containmentVolume' && !receivers.has(String(component.kind))) throw new Error(`directed delivery does not support receiver ${component.id}`)
  }
  chosen.forEach((edge, index) => { nodes[edge.from]!.outgoing.push(index); nodes[edge.to]!.incoming.push(index) })
  const pending = new Map([...selectedNodes].map(index => [index, nodes[index]!.incoming.length]))
  const order = [...pending].filter(([, count]) => count === 0).map(([index]) => index)
  for (let cursor = 0; cursor < order.length; cursor++) for (const edgeIndex of nodes[order[cursor]!]!.outgoing) {
    const target = chosen[edgeIndex]!.to, next = pending.get(target)! - 1
    pending.set(target, next); if (next === 0) order.push(target)
  }
  if (order.length !== selectedNodes.size) throw new Error('directed delivery contains a cycle without an explicit fluid inventory boundary')
  const nearestPumps: CompiledComponent[][] = nodes.map(() => [])
  for (const index of order) {
    const node = nodes[index]!
    nearestPumps[index] = node.kind === 'pump' ? [node.component] : [...new Set(node.incoming.flatMap(edge => nearestPumps[chosen[edge]!.from]!))]
  }
  const built = { nodes, edges: chosen, order, nearestPumps, edgeByLink: new Map(chosen.map((edge, index) => [edge.link.index, index])), pumpNodes: new Map(order.filter(index => nodes[index]!.kind === 'pump').map(index => [nodes[index]!.component.index, index])) }
  networks.set(graph, built)
  return built
}

/** Compile-time boundary validation; no state, flow or command is changed. */
export const assertDirectedFluidDeliveryValid = (graph: CompiledPlantGraph): void => { networkFor(graph) }

type ReadContext = Pick<ProcessPlantBehaviorContext, 'has' | 'readNumber'>
const pumpFlow = (component: CompiledComponent, context: ReadContext): number => Math.max(0, context.readNumber(componentVariablePath(component, 'flowKgPerS')))
const sourceCapacity = (node: Node, context: ReadContext, dtSeconds: number): number => {
  const sump = node.component.kind === 'containmentVolume'
  const inventory = context.readNumber(componentVariablePath(node.component, sump ? 'sumpInventoryKg' : 'inventoryKg'))
  const flow = sump ? optionalParameterNumber(node.component, 'maxSumpOutflowKgPerS', 0) : context.readNumber(componentVariablePath(node.component, 'availableOutletFlowKgPerS'))
  return Math.max(0, Math.min(flow, dtSeconds > 0 ? inventory / dtSeconds : inventory > 0 ? Number.POSITIVE_INFINITY : 0))
}
const nodeOpening = (node: Node, context: ReadContext): number => node.component.kind === 'processValve'
  ? clamp(context.readNumber(componentVariablePath(node.component, 'effectivePositionFraction')), 0, 1) : 1

/** The existing injection curve at the final receiver, independently of a
 * different outlet that supplies another pump's suction. */
const receiverCurveCapacity = (system: CompiledProcessPlant, pump: CompiledComponent, context: ReadContext): number => {
  const shutoff = (pump.parameters as Readonly<Record<string, unknown>>).reactorCoolantShutoffPressureMPa
  if (typeof shutoff !== 'number') return parameterNumber(pump, 'nominalFlowKgPerS') * context.readNumber(componentVariablePath(pump, 'speedFraction'))
  const pressurizer = primarySystemPressurizer(system)
  if (pressurizer === null) throw new Error(`injection pump ${pump.id} has no reactor coolant pressure boundary`)
  const speed = context.readNumber(componentVariablePath(pump, 'speedFraction'))
  const pressure = context.readNumber(componentVariablePath(pressurizer, 'pressureMPa'))
  const curve = shutoff * speed * speed
  const fraction = curve > 0 ? Math.sqrt(clamp(1 - pressure / curve, 0, 1)) : 0
  return parameterNumber(pump, 'nominalFlowKgPerS') * speed * fraction
}
const directPumpFlow = (system: CompiledProcessPlant, pump: CompiledComponent, context: ReadContext): number => Math.min(pumpFlow(pump, context), receiverCurveCapacity(system, pump, context))

type Solution = { readonly graph: CompiledPlantGraph; readonly potential: Float64Array; readonly requests: Float64Array; readonly flows: Float64Array; readonly nodePotential: Float64Array }
const solutions = new WeakMap<object, Solution>()

/** One solve per existing fluid-link phase. Reused numeric buffers are derived
 * mechanics only; checkpoints retain all physical inventories and actuators. */
export const prepareDirectedFluidDelivery = (system: CompiledProcessPlant, context: ProcessPlantBehaviorContext, dtSeconds: number): void => {
  const network = networkFor(system.graph)
  if (network === null) return
  let state = solutions.get(context)
  if (state?.graph !== system.graph) {
    state = { graph: system.graph, potential: new Float64Array(network.edges.length), requests: new Float64Array(network.edges.length), flows: new Float64Array(network.edges.length), nodePotential: new Float64Array(network.nodes.length) }
    solutions.set(context, state)
  }
  const { potential, requests, flows, nodePotential } = state
  potential.fill(0); requests.fill(0); flows.fill(0); nodePotential.fill(0)
  // First establish finite available supply without yet spending it at splits.
  for (const index of network.order) {
    const node = network.nodes[index]!
    const incoming = node.incoming.reduce((total, edge) => total + potential[edge]!, 0)
    const available = node.kind === 'source' ? sourceCapacity(node, context, dtSeconds)
      : node.kind === 'pump' ? Math.min(incoming, pumpFlow(node.component, context)) : incoming
    const valveCv = node.component.kind === 'processValve' ? optionalParameterNumber(node.component, 'cvKgPerSPerSqrtMPa', Number.POSITIVE_INFINITY) : Number.POSITIVE_INFINITY
    const upstreamPressure = node.incoming.reduce((highest, edge) => {
      const reading = processLinkVariablePath(network.edges[edge]!.link, 'pressureMPa')
      return context.has(reading) ? Math.max(highest, context.readNumber(reading)) : highest
    }, 0)
    // Retain the ordinary reduced valve capacity law. Its pressure input is
    // the declared upstream reading, not a newly solved suction equilibrium.
    const valveCapacity = Number.isFinite(valveCv) ? valveCv * Math.sqrt(Math.max(0, upstreamPressure)) : Number.POSITIVE_INFINITY
    nodePotential[index] = Math.min(available, valveCapacity) * nodeOpening(node, context)
    for (const edgeIndex of node.outgoing) {
      const edge = network.edges[edgeIndex]!
      potential[edgeIndex] = Math.min(nodePotential[index]!, physicalFlowCapacityKgPerS(edge.link))
    }
  }
  // Demand stops at an intervening pump. Merges divide the request by their
  // available supply/conductance, never by a fictional pressure balance.
  for (let cursor = network.order.length - 1; cursor >= 0; cursor--) {
    const node = network.nodes[network.order[cursor]!]!
    const needed = node.kind === 'receiver' ? Number.POSITIVE_INFINITY
      : Math.min(nodePotential[node.index]!, node.outgoing.reduce((total, edge) => total + requests[edge]!, 0))
    const totalPotential = node.incoming.reduce((total, edge) => total + potential[edge]!, 0)
    for (const edgeIndex of node.incoming) {
      const edge = network.edges[edgeIndex]!
      const receiverDemand = node.kind !== 'receiver' ? needed
        : network.nearestPumps[edge.from]!.length > 0 ? network.nearestPumps[edge.from]!.reduce((total, pump) => total + (node.component.kind === 'reactorCore' ? directPumpFlow(system, pump, context) : pumpFlow(pump, context)), 0)
          : potential[edgeIndex]!
      requests[edgeIndex] = node.kind === 'receiver' ? Math.min(potential[edgeIndex]!, receiverDemand)
        : totalPotential > 0 ? needed * potential[edgeIndex]! / totalPotential : 0
    }
  }
  // Spend each source/pump/passive circuit budget exactly once. Every arrival
  // at a massless junction leaves it; an unavailable source cannot be replaced
  // by a stale pump flow or duplicated onto another outlet.
  for (const index of network.order) {
    const node = network.nodes[index]!
    const arrived = node.incoming.reduce((total, edge) => total + flows[edge]!, 0)
    const available = node.kind === 'source' ? nodePotential[index]! : Math.min(arrived, nodePotential[index]!)
    const demand = node.outgoing.reduce((total, edge) => total + requests[edge]!, 0)
    const supplied = Math.min(available, demand)
    for (const edge of node.outgoing) flows[edge] = demand > 0 ? supplied * requests[edge]! / demand : 0
  }
}

export const directedFluidDeliveryFlow = (system: CompiledProcessPlant, link: CompiledProcessLink, context: ProcessPlantBehaviorContext): number | null => {
  const network = networkFor(system.graph), edge = network?.edgeByLink.get(link.index)
  if (edge === undefined) return null
  const solution = solutions.get(context)
  if (solution?.graph !== system.graph) throw new Error(`directed delivery was not solved before reading ${link.id}`)
  return solution.flows[edge]!
}

/** A live open route to a later pump is a suction demand, not the RCS's
 * pressure. The later pump must itself be moving water; no readiness flag. */
export const downstreamPumpSuctionDemandOpen = (system: CompiledProcessPlant, pump: CompiledComponent, context: ReadContext & Pick<ProcessPlantBehaviorContext, 'readBoolean'>): boolean => {
  const network = networkFor(system.graph)
  if (network === null) return false
  const startIndex = network.pumpNodes.get(pump.index)
  if (startIndex === undefined) return false
  const start = network.nodes[startIndex]!
  const queue = [...start.outgoing.map(edge => network.edges[edge]!.to)], visited = new Set<number>()
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const node = network.nodes[queue[cursor]!]!
    if (visited.has(node.index)) continue
    visited.add(node.index)
    if (node.kind === 'pump') {
      if ((context.readBoolean(componentVariablePath(node.component, 'runningState')) && receiverCurveCapacity(system, node.component, context) > 0) || pumpFlow(node.component, context) > 0) return true
      continue
    }
    if (node.kind !== 'passive' || nodeOpening(node, context) <= 0) continue
    queue.push(...node.outgoing.map(edge => network.edges[edge]!.to))
  }
  return false
}

/** Actual pump discharge, from the allocated branches, after the candidate
 * pump curves have been shared. Null leaves independently owned solvers alone. */
export const directedPumpDeliveredFlow = (system: CompiledProcessPlant, pump: CompiledComponent, context: ProcessPlantBehaviorContext): number | null => {
  const network = networkFor(system.graph), index = network?.pumpNodes.get(pump.index)
  if (index === undefined) return null
  const solution = solutions.get(context)
  if (solution?.graph !== system.graph) throw new Error(`directed delivery was not solved before reconciling ${pump.id}`)
  return network!.nodes[index]!.outgoing.reduce((total, edge) => total + solution.flows[edge]!, 0)
}
