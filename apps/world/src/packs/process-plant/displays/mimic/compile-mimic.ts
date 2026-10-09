import type { CompiledComponent, CompiledPlantGraph, CompiledProcessLink, VariablePath } from '../../graph/index.ts'
import { linkCarrier } from '../../graph/index.ts'
import type { CompiledProcessPlant } from '../../plant-compiler.ts'
import { unitLabel } from '../display-text.ts'
import { framingRules, itemBinding, linkFlowBinding, linkPowerBinding, type MimicItem, type MimicItemBinding } from './bindings.ts'
import { layoutDiagram, type DiagramEdge, type DiagramGraph, type DiagramLayoutResult, type DiagramNode, type DiagramProfile, type PlacedNode } from './layout/index.ts'
import { MIMIC_LAYOUT_VERSION, type CompiledMimic, type MimicDrawnItem, type MimicPipeState } from './mimic-model.ts'
import { embeddedPresentation, presentationFor, type MimicPresentation } from './presentation.ts'
import { itemRows, type MimicRow } from './rows.ts'
import { resolveMimicScope, stubText, plantLoops, type MimicIntent, type MimicScope, type MimicStub } from './scope.ts'
import { openBridgeDevice, readoutBlockWidth, smallStateRowWidth, smallValueRowWidth, textWidth, unmeasurable, type OpenBridgeTextStyle } from './text-metrics.ts'

// Intent → scope → items with their bindings → a diagram sized in OpenBridge
// px → the layout engine → a compiled mimic. Every step reads the Plant's
// declared semantics; no step knows the reference model.

export interface MimicBudget {
  readonly maxWidth: number
  readonly maxHeight: number
}

export interface MimicIssue {
  readonly field: string
  readonly message: string
  readonly didYouMean?: ReadonlyArray<string>
}

export type MimicCompileResult =
  | { readonly ok: true; readonly mimic: CompiledMimic }
  | { readonly ok: false; readonly issues: ReadonlyArray<MimicIssue> }

/** The HMI standard the layout enforces (OpenBridge grid, alarm frames, density). */
const profileFor = (budget: MimicBudget): DiagramProfile => ({
  grid: 24,
  cell: 24,
  pipe: { outline: 6, cornerRadius: 8, crossingHalfGap: 5 },
  textClearance: 9,
  frameMargin: 1,
  flapHeight: openBridgeDevice.flapHeight,
  flapLabelPadding: openBridgeDevice.flapLabelInset,
  maxWidth: budget.maxWidth,
  maxHeight: budget.maxHeight,
  // About three symbols per loop and eight shared: what an operator takes in at
  // a glance, and enough for one service to all four loops or a diesel to its pump.
  limits: { symbols: 20, symbolsPerLane: 3, sharedSymbols: 8, lanes: 4, crossings: 6, bendsPerEdge: 3 },
})

interface PlannedItem {
  readonly id: string
  readonly item: MimicItem
  readonly binding: MimicItemBinding
  readonly presentation: MimicPresentation
  readonly rows: ReadonlyArray<MimicRow>
  readonly role: DiagramNode['role']
  readonly rank: string
  readonly lane?: DiagramNode['lane']
}

const laneOf = (component: CompiledComponent, orders: ReadonlyMap<string, number>): DiagramNode['lane'] | undefined => {
  const key = component.metadata?.loopId
  return key === undefined || !orders.has(key) ? undefined : { key, order: orders.get(key)! }
}

const valueRowWidth = (unit: string): number =>
  readoutBlockWidth(3, 1) + (unitLabel(unit) === '' ? 0 : textWidth('unit', unitLabel(unit))) + openBridgeDevice.valueRowPadding

const stateRowWidth = (texts: ReadonlyArray<string>): number =>
  Math.max(...texts.map(text => textWidth('stateRow', text))) + openBridgeDevice.stateRowPadding

// Devices use OpenBridge's small readout stack; vessels our stack of readout blocks.
const rowSize = (row: MimicRow, device: boolean): { readonly width: number; readonly height: number } => {
  if (!device) {
    if (row.kind === 'value') return { width: valueRowWidth(row.unit), height: openBridgeDevice.row }
    if (row.kind === 'position') return { width: Math.max(valueRowWidth('fraction'), stateRowWidth(['POS ?'])), height: openBridgeDevice.row }
    return { width: stateRowWidth(row.texts), height: openBridgeDevice.row }
  }
  if (row.kind === 'value') return { width: smallValueRowWidth(unitLabel(row.unit)), height: openBridgeDevice.smallValueRow }
  if (row.kind === 'position') return { width: Math.max(smallValueRowWidth('%'), smallStateRowWidth('POS ?')), height: openBridgeDevice.smallValueRow }
  return { width: Math.max(...row.texts.map(smallStateRowWidth)), height: openBridgeDevice.smallStateRow }
}

const rowTexts = (row: MimicRow): ReadonlyArray<{ readonly style: OpenBridgeTextStyle; readonly text: string }> =>
  row.kind === 'value' ? [{ style: 'unit', text: unitLabel(row.unit) }]
    : row.kind === 'position' ? [{ style: 'stateRow', text: 'POS ?' }]
      : row.texts.map(text => ({ style: 'stateRow' as const, text }))

const isDevice = (presentation: MimicPresentation): boolean => presentation.element === 'device'
const isVessel = (presentation: MimicPresentation): boolean => presentation.element === 'tank' || presentation.element === 'heat-exchanger'

const aspectFor = (presentation: MimicPresentation) =>
  presentation.element === 'device' || presentation.element === 'bar' ? presentation.aspect
    : presentation.element === 'tank' || presentation.element === 'heat-exchanger' ? presentation.aspect
      : null

// A vessel loops return to (the reactor) is a hub: it takes links from two or more drawn loops on both sides.
const isHub = (graph: CompiledPlantGraph, component: CompiledComponent, drawnLinks: ReadonlySet<number>): boolean => {
  const loopsOf = (indexes: ReadonlyArray<number> | undefined, side: 'from' | 'to') => new Set((indexes ?? [])
    .filter(index => drawnLinks.has(index))
    .map(index => graph.components[side === 'from' ? graph.links[index]!.fromComponentIndex : graph.links[index]!.toComponentIndex]!.metadata?.loopId)
    .filter((loop): loop is string => loop !== undefined))
  return component.metadata?.loopId === undefined
    && loopsOf(graph.incomingLinksByComponent[component.index], 'from').size >= 2
    && loopsOf(graph.outgoingLinksByComponent[component.index], 'to').size >= 2
}

const portDirection = (component: CompiledComponent, port: string): 'in' | 'out' | 'both' => {
  const direction = component.ports[port]?.direction
  return direction === 'bidirectional' ? 'both' : direction === 'out' ? 'out' : 'in'
}

interface Planned {
  readonly graph: DiagramGraph
  readonly items: ReadonlyMap<string, PlannedItem>
  readonly edgeLinks: ReadonlyMap<string, number>
  readonly stubs: ReadonlyMap<string, MimicStub>
  readonly issues: ReadonlyArray<MimicIssue>
}

const plan = (plant: CompiledProcessPlant, scope: MimicScope): Planned => {
  const graph = plant.graph
  const framed = framingRules(plant)
  const issues: MimicIssue[] = []
  const loopOrder = new Map(plantLoops(graph).map((loop, order) => [loop, order]))
  const drawnLinks = new Set(scope.links)

  // Equipment the mimic cannot draw ends the drawing like any other stop.
  const notDrawn = new Set(scope.components.filter(index => presentationFor(graph.components[index]!).element === 'not-drawn'))
  const links = scope.links.filter(index => !notDrawn.has(graph.links[index]!.fromComponentIndex) && !notDrawn.has(graph.links[index]!.toComponentIndex))
  const extraStubs: MimicStub[] = scope.links.flatMap((index): MimicStub[] => {
    const link = graph.links[index]!
    if (notDrawn.has(link.toComponentIndex) && !notDrawn.has(link.fromComponentIndex)) return [{ component: link.fromComponentIndex, port: String(link.fromPortName), direction: 'out' as const, links: [index], others: [{ component: link.toComponentIndex, port: String(link.toPortName) }] }]
    if (notDrawn.has(link.fromComponentIndex) && !notDrawn.has(link.toComponentIndex)) return [{ component: link.toComponentIndex, port: String(link.toPortName), direction: 'in' as const, links: [index], others: [{ component: link.fromComponentIndex, port: String(link.fromPortName) }] }]
    return []
  })

  const items = new Map<string, PlannedItem>()
  const nodes: DiagramNode[] = []
  const edges: DiagramEdge[] = []
  const edgeLinks = new Map<string, number>()
  const stubs = new Map<string, MimicStub>()
  const componentRank = new Map<number, string>()

  const measure = (style: OpenBridgeTextStyle, text: string, owner: string): number => {
    const missing = unmeasurable(style, text)
    if (missing.length > 0) {
      issues.push({ field: '(mimic)', message: `${owner}: "${text}" uses characters the drawing cannot measure (${missing.join('')})` })
      return 0
    }
    return textWidth(style, text)
  }

  const addItem = (planned: PlannedItem, ports: DiagramNode['ports']): void => {
    items.set(planned.id, planned)
    const presentation = planned.presentation
    const vessel = isVessel(presentation) || planned.role === 'hub'
    for (const row of planned.rows) for (const { style, text } of rowTexts(row)) measure(style, text, planned.binding.label)
    const flaps = planned.binding.frames.map(frame => measure('alertLabel', frame.flap, planned.binding.label))
    nodes.push({
      id: planned.id,
      rank: planned.rank,
      role: planned.role,
      cells: vessel ? { width: 2, height: 4 } : { width: 2, height: 2 },
      portInset: vessel ? openBridgeDevice.vessel.inset : 0,
      ports,
      ...(planned.lane === undefined ? {} : { lane: planned.lane }),
      text: {
        lines: [
          { width: measure('tag', planned.binding.label, planned.binding.label), height: openBridgeDevice.tagLine, required: true },
          ...planned.rows.map(row => ({ ...rowSize(row, isDevice(presentation)), required: row.required })),
        ],
      },
      frameable: planned.binding.frames.length > 0,
      ...(flaps.length === 0 ? {} : { flapWidth: Math.max(...flaps) }),
    })
  }

  // Ports each drawn component uses, from its drawn links and stubs.
  const usedPorts = new Map<number, Set<string>>()
  const usePort = (component: number, port: string) => usedPorts.set(component, new Set([...(usedPorts.get(component) ?? []), port]))
  for (const index of links) {
    usePort(graph.links[index]!.fromComponentIndex, String(graph.links[index]!.fromPortName))
    usePort(graph.links[index]!.toComponentIndex, String(graph.links[index]!.toPortName))
  }
  const allStubs = [...scope.stubs, ...extraStubs]
  for (const stub of allStubs) usePort(stub.component, stub.port)

  for (const index of scope.components) {
    if (notDrawn.has(index)) continue
    const component = graph.components[index]!
    const presentation = presentationFor(component)
    const hub = presentation.element !== 'bar' && isHub(graph, component, drawnLinks)
    const role: DiagramNode['role'] = presentation.element === 'bar' ? 'bar' : hub ? 'hub' : 'device'
    const binding = itemBinding(plant, { kind: 'component', component: index }, aspectFor(presentation), framed)
    const ports = [...(usedPorts.get(index) ?? [])].sort()
    const rank = [role, component.kind, component.metadata?.equipmentClass ?? '', component.metadata?.role ?? '', ports.join(','), binding.label].join('|')
    componentRank.set(index, rank)
    const lane = laneOf(component, loopOrder)
    addItem(
      { id: `c${index}`, item: { kind: 'component', component: index }, binding, presentation, rows: itemRows(binding, presentation), role, rank, ...(lane === undefined ? {} : { lane }) },
      ports.map(port => ({ id: port, direction: portDirection(component, port), rank: port })),
    )
  }

  // A drawn link becomes a chain of edges through the devices its host bundles on that port.
  for (const index of links) {
    const link = graph.links[index]!
    const from = graph.components[link.fromComponentIndex]!
    const to = graph.components[link.toComponentIndex]!
    const devicesOn = (component: CompiledComponent, port: string) => component.semantics.embedded.filter(device => String(device.port) === port)
    const chain: Array<{ readonly node: string; readonly inPort: string; readonly outPort: string }> = [
      { node: `c${from.index}`, inPort: '', outPort: String(link.fromPortName) },
      ...[...devicesOn(from, String(link.fromPortName)), ...devicesOn(to, String(link.toPortName))].map(device => {
        const host = devicesOn(from, String(link.fromPortName)).includes(device) ? from : to
        const id = `c${host.index}:${device.id}`
        if (!items.has(id)) {
          const presentation = embeddedPresentation(device)
          const binding = itemBinding(plant, { kind: 'device', component: host.index, device: device.id }, 'position', framed)
          const lane = laneOf(host, loopOrder)
          addItem(
            { id, item: { kind: 'device', component: host.index, device: device.id }, binding, presentation, rows: itemRows(binding, presentation), role: 'device', rank: `${componentRank.get(host.index)}|${device.id}`, ...(lane === undefined ? {} : { lane }) },
            [{ id: 'in', direction: 'in', rank: 'in' }, { id: 'out', direction: 'out', rank: 'out' }],
          )
        }
        return { node: id, inPort: 'in', outPort: 'out' }
      }),
      { node: `c${to.index}`, inPort: String(link.toPortName), outPort: '' },
    ]
    chain.slice(1).forEach((step, at) => {
      const previous = chain[at]!
      const id = `l${index}.${at}`
      edgeLinks.set(id, index)
      edges.push({ id, rank: `${linkCarrier(link)}|${componentRank.get(from.index)}|${link.fromPortName}|${componentRank.get(to.index)}|${link.toPortName}|${at}`, from: { node: previous.node, port: previous.outPort }, to: { node: step.node, port: step.inPort } })
    })
  }

  allStubs.forEach((stub, at) => {
    const id = `s${at}`
    const component = graph.components[stub.component]!
    stubs.set(id, stub)
    const text = stubText(graph, stub)
    const lane = laneOf(component, loopOrder)
    nodes.push({
      id,
      rank: `stub|${componentRank.get(stub.component)}|${stub.port}|${stub.direction}`,
      role: 'stub',
      cells: { width: 1, height: 1 },
      portInset: 0,
      ports: [{ id: 'end', direction: stub.direction === 'out' ? 'in' : 'out', rank: 'end' }],
      ...(lane === undefined ? {} : { lane }),
      text: { lines: [{ width: measure('tag', text, text), height: openBridgeDevice.tagLine, required: true }] },
      frameable: false,
    })
    const edge = { id: `${id}.edge`, rank: `stub|${componentRank.get(stub.component)}|${stub.port}|${stub.direction}` }
    edgeLinks.set(edge.id, stub.links[0]!)
    edges.push(stub.direction === 'out'
      ? { ...edge, from: { node: `c${stub.component}`, port: stub.port }, to: { node: id, port: 'end' } }
      : { ...edge, from: { node: id, port: 'end' }, to: { node: `c${stub.component}`, port: stub.port } })
  })

  return { graph: { nodes, edges }, items, edgeLinks, stubs, issues }
}

const pipeState = (graph: CompiledPlantGraph, link: CompiledProcessLink): MimicPipeState =>
  link.kind === 'electricalPower'
    ? { kind: 'power', energizedPath: linkPowerBinding(graph, link.index).energizedPath }
    : { kind: 'fluid', flow: linkFlowBinding(graph, link.index) }

const statePaths = (state: MimicPipeState): ReadonlyArray<VariablePath> =>
  state.kind === 'fluid' ? [state.flow.flowPath] : state.energizedPath === null ? [] : [state.energizedPath]

const orientationOf = (node: PlacedNode): 'horizontal' | 'vertical' =>
  Object.values(node.ports).some(port => port.face === 'left' || port.face === 'right') ? 'horizontal' : 'vertical'

const assemble = (plant: CompiledProcessPlant, intent: MimicIntent, scope: MimicScope, planned: Planned, layout: Extract<DiagramLayoutResult, { ok: true }>): CompiledMimic => {
  const graph = plant.graph
  const placed = new Map(layout.nodes.map(node => [node.id, node]))
  const items: MimicDrawnItem[] = [...planned.items.values()].map(item => {
    const node = placed.get(item.id)!
    return {
      id: item.id,
      binding: item.binding,
      presentation: item.presentation,
      box: { x: node.x, y: node.y, width: node.width, height: node.height },
      orientation: orientationOf(node),
      text: node.text,
      frame: node.frame,
      // The label is the stack's first line; the rows that fit follow it.
      rows: item.rows.slice(0, Math.max(0, (node.text?.lines ?? 1) - 1)),
    }
  })
  const pipes = layout.edges.filter(edge => !edge.id.startsWith('s')).map(edge => {
    const link = graph.links[planned.edgeLinks.get(edge.id)!]!
    return { id: edge.id, linkId: String(link.id), carrier: linkCarrier(link), points: edge.points, gaps: edge.gaps, state: pipeState(graph, link) }
  })
  const stubEdges = new Map(layout.edges.filter(edge => edge.id.startsWith('s')).map(edge => [edge.id.slice(0, edge.id.indexOf('.')), edge]))
  const stubs = [...planned.stubs].map(([id, stub]) => {
    const edge = stubEdges.get(id)!
    const node = placed.get(id)!
    const end = node.ports.end!
    return {
      id,
      direction: stub.direction,
      end: { x: end.x, y: end.y, face: end.face },
      text: stubText(graph, stub),
      textBox: node.text,
      states: stub.links.map(index => pipeState(graph, graph.links[index]!)),
      edge,
    }
  })
  // A stub's pipe is drawn with the other pipes, styled by its first link (a grouped stub's links share one port).
  const stubPipes = stubs.map(stub => {
    const link = graph.links[planned.stubs.get(stub.id)!.links[0]!]!
    return { id: stub.edge.id, linkId: String(link.id), carrier: linkCarrier(link), points: stub.edge.points, gaps: stub.edge.gaps, state: stub.states[0]! }
  })
  const paths = [...new Set([
    ...items.flatMap(item => {
      const state = item.binding.state
      return [
        ...(state?.state === undefined ? [] : [state.state.path]),
        ...(state?.command === undefined ? [] : [state.command]),
        ...(state?.throughput === undefined ? [] : [state.throughput.path]),
        ...item.rows.flatMap(row => row.kind === 'value' ? [row.path as VariablePath] : []),
      ]
    }),
    ...pipes.flatMap(pipe => statePaths(pipe.state)),
    ...stubs.flatMap(stub => stub.states.flatMap(statePaths)),
  ])]
  return {
    intent,
    layoutVersion: MIMIC_LAYOUT_VERSION,
    width: layout.width,
    height: layout.height,
    items,
    pipes: [...pipes, ...stubPipes],
    stubs: stubs.map(({ edge: _edge, ...stub }) => stub),
    zones: layout.zones.map(zone => ({ ...zone, label: `Loop ${zone.lane}` })),
    paths,
    summary: {
      equipment: items.map(item => ({
        id: item.binding.item.kind === 'component' ? String(graph.components[item.binding.item.component]!.id) : `${graph.components[item.binding.item.component]!.id}.${item.binding.item.device}`,
        label: item.binding.label,
      })),
      stops: stubs.map(stub => `${graph.components[planned.stubs.get(stub.id)!.component]!.metadata?.presentation?.shortLabel ?? graph.components[planned.stubs.get(stub.id)!.component]!.id} ${stub.text}`),
      carriers: scope.carriers,
      unverifiedFlows: [...new Set(pipes.filter(pipe => pipe.state.kind === 'fluid' && pipe.state.flow.fidelity === 'unverified').map(pipe => pipe.linkId))],
      unmeasuredStates: items.filter(item => item.binding.state?.aspect === 'position' && item.binding.state.state === undefined).map(item => item.binding.label),
    },
    hash: `${MIMIC_LAYOUT_VERSION}:${layout.hash}`,
  }
}

// Each orientation the layout tries reports its own size; the closest fit says how far off the drawing is.
const closestSize = (reasons: Extract<DiagramLayoutResult, { ok: false }>['reasons'], budget: MimicBudget) => {
  const overflow = (reason: { readonly width: number; readonly height: number }) => Math.max(reason.width / budget.maxWidth, reason.height / budget.maxHeight)
  const sizes = reasons.filter(reason => reason.kind === 'size')
  return sizes.length === 0 ? undefined : sizes.reduce((best, reason) => overflow(reason) < overflow(best) ? reason : best)
}

const layoutReasons = (result: Extract<DiagramLayoutResult, { ok: false }>, budget: MimicBudget): string => result.reasons.filter(reason => reason.kind !== 'size' || reason === closestSize(result.reasons, budget)).map(reason => {
  if (reason.kind === 'density') {
    const what = { symbols: 'symbols', symbolsPerLane: 'symbols in one loop', sharedSymbols: 'shared symbols outside the loops', lanes: 'loops', crossings: 'crossing pipes', bendsPerEdge: 'bends in one pipe' }[reason.limit]
    return `${reason.count} ${what} (at most ${reason.max} stay legible at a glance)`
  }
  if (reason.kind === 'size') return `the drawing needs ${reason.width} × ${reason.height} px, and this display leaves ${budget.maxWidth} × ${budget.maxHeight}`
  return `the layout could not be verified (${reason.violations.slice(0, 2).map(violation => `${violation.rule}: ${violation.detail}`).join('; ')})`
}).filter((reason, index, all) => all.indexOf(reason) === index).join('; ')

const compileWithin = (plant: CompiledProcessPlant, intent: MimicIntent, budget: MimicBudget): MimicCompileResult | { readonly ok: false; readonly layout: Extract<DiagramLayoutResult, { ok: false }> } => {
  const resolved = resolveMimicScope(plant.graph, intent)
  if (!resolved.ok) return { ok: false, issues: resolved.issues }
  const planned = plan(plant, resolved.scope)
  if (planned.issues.length > 0) return { ok: false, issues: planned.issues }
  const layout = layoutDiagram(planned.graph, profileFor(budget))
  if (!layout.ok) return { ok: false, layout }
  return { ok: true, mimic: assemble(plant, intent, resolved.scope, planned, layout) }
}

// Narrower intents that draw part of the same question; each is compiled, and only those that fit are offered.
const narrower = (plant: CompiledProcessPlant, intent: MimicIntent): ReadonlyArray<MimicIntent> => {
  const resolved = resolveMimicScope(plant.graph, intent)
  if (!resolved.ok) return []
  const drawnLoops = plantLoops(plant.graph).filter(loop => resolved.scope.components.some(index => plant.graph.components[index]!.metadata?.loopId === loop))
  const loopSets = intent.loops === undefined && drawnLoops.length > 1
    ? [drawnLoops.slice(0, 2), ...drawnLoops.map(loop => [loop])]
    : intent.loops !== undefined && intent.loops.length > 1 ? intent.loops.map(loop => [loop]) : []
  const serviceSets = (intent.services ?? []).length > 1 ? intent.services!.map(service => [service]) : []
  return [
    ...loopSets.map(loops => ({ ...intent, loops })),
    ...serviceSets.map(services => ({ ...intent, services })),
  ]
}

const describeChange = (from: MimicIntent, to: MimicIntent): string =>
  to.loops !== from.loops ? `"loops":${JSON.stringify(to.loops)}` : `"services":${JSON.stringify(to.services)}`

export const compileMimic = (plant: CompiledProcessPlant, intent: MimicIntent, budget: MimicBudget): MimicCompileResult => {
  const result = compileWithin(plant, intent, budget)
  if (result.ok || 'issues' in result) return result as MimicCompileResult
  const fixes = narrower(plant, intent)
    .filter(candidate => compileWithin(plant, candidate, budget).ok)
    .slice(0, 3)
    .map(candidate => describeChange(intent, candidate))
  return {
    ok: false,
    issues: [{ field: '(mimic)', message: `${layoutReasons(result.layout, budget)}; ${fixes.length === 0 ? 'name fewer loops, one service, or a route between two items' : `it fits with ${fixes.join(', or ')}`}` }],
  }
}
