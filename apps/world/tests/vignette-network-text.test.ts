import { newWorkspaceId } from '@leitbild/contracts'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWorldApplicationAssembly } from '../src/app-assembly.ts'
import { displayRunOf } from '../src/core/api/display-capabilities.ts'
import type { ActorId, IsoTimestamp, ObjectId } from '../src/core/model/index.ts'
import { scenarioAuthoringCatalogFor } from '../src/core/scenarios/authoring.ts'
import { compileScenarioDefinition } from '../src/core/scenarios/compiler.ts'
import { createScenarioRuntimeResolver } from '../src/core/scenarios/runtime-resolver.ts'
import { createSimulationRunRegistry, type SimulationRunRegistry } from '../src/core/simulation-runs/registry.ts'
import { composeDefault } from '../src/features/displays/compose/compose.ts'
import type { VignetteSection } from '../src/features/displays/compose/model.ts'
import { compileVignette, sampleVignette, type ViewRun } from '../src/features/displays/compose/view.ts'
import { NETWORK, NETWORK_SEPARATOR } from '../src/features/displays/topology/network-room.ts'
import { FLOW_TEXT, textWidth } from '../src/features/displays/topology/text.ts'
import { wholeWordsWithin } from '../src/packs/electric-grid/observation/declarations.ts'
import { createDirectRoutingAdapter } from '../src/routing/direct-adapter.ts'
import { builtinScenarioDefinitions } from '../src/scenarios/definitions.ts'
import { networkDrawing, type NetworkDrawing } from '../src/ui/embed/vignette/network.ts'
import { guardPlantTests } from './plant-hang-guard.ts'

guardPlantTests()

// A network drawing's words as a person sees them (R3 eval of the grid overview: "Follo - Tegneby / Syllin" cut,
// "Sylling trafostasjon 420/…" cut, "Tegneby koblingsstasjon 420 kV" on its bar), on the grid's own defaults as the
// display window composes them (its overview, a bus's and a line's): every name and reading whole, in the room the
// composer measured for it in Noto Sans, and clear of the bars, the symbols, the lines and each other.

type Topology = Extract<VignetteSection, { kind: 'topology' }>
type Rect = { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
const routing = createDirectRoutingAdapter()
const assembly = createWorldApplicationAssembly({ routing })
const person = { id: 'actor:human:network-text' as ActorId, label: 'Network text', role: 'operator' as const }
const GRID = 'grid:halden-four-unit' as ObjectId
let registry: SimulationRunRegistry
let dataDir: string
let run: ViewRun
const drawn = new Map<string, { readonly section: Topology; readonly drawing: NetworkDrawing }>()

/** A default's network drawing as the window draws it, from its first sample. */
const drawingOf = async (subject: string): Promise<{ readonly section: Topology; readonly drawing: NetworkDrawing }> => {
  const outcome = await composeDefault(run, subject)
  if (!outcome.ok) throw new Error(`${subject}: ${JSON.stringify(outcome.issues)}`)
  const view = await compileVignette(run, outcome.state)
  const section = view.sections.find((entry): entry is Topology => entry.kind === 'topology' && entry.family === 'network')
  if (section === undefined) throw new Error(`${subject}: no network drawing (${view.sections.map(entry => entry.kind).join(', ')})`)
  const sample = await sampleVignette(run, outcome.state)
  return { section, drawing: networkDrawing(section, sample.observations) }
}

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'leitbild-network-text-'))
  registry = createSimulationRunRegistry({
    dataDir, workspaceId: newWorkspaceId(), scenarioDefinitions: builtinScenarioDefinitions,
    compileScenarioDefinition: source => compileScenarioDefinition(source, assembly.packs, { routing }),
    scenarioAuthoringCatalog: scenarioAuthoringCatalogFor(assembly.packs), runtimeAdapters: assembly.runtimeAdapters,
    scenarioRuntimeResolver: createScenarioRuntimeResolver({ packs: assembly.packs }), idleRuntimeCloseTimer: () => () => {},
  })
  const runtime = await registry.create({ scenarioId: 'halden-power-complex' })
  await runtime.setClock({ paused: true })
  await runtime.runMaximumPace(new Date(Date.parse(runtime.snapshot().clock!.currentTime) + 10_000).toISOString() as IsoTimestamp, { shouldStop: () => false })
  run = await displayRunOf(registry, runtime, person, new Set())
  // The grid's overview, then a bus and a line it draws, each opened as its element's default.
  const overview = await drawingOf(GRID)
  drawn.set('overview', overview)
  const element = (cls: string) => overview.section.nodes.find(node => node.class === cls && node.element !== undefined && node.bindings.length > 0)?.element
  for (const [name, cls] of [['bus', 'bus'], ['line', 'transfer']] as const) {
    const id = element(cls)
    if (id === undefined) throw new Error(`the grid overview draws no ${cls}`)
    drawn.set(name, await drawingOf(`${GRID}#${id}`))
  }
}, 240_000)
afterAll(async () => { await registry.shutdown(); await rm(dataDir, { recursive: true, force: true }) })

/** A row's words as set: each part in its style, separators between them, at the row's start or end. */
const inked = (row: NetworkDrawing['texts'][number]['rows'][number]): Rect => {
  const width = row.parts.reduce((sum, part, at) => sum + textWidth(part.text, part.style) + (at === 0 ? 0 : textWidth(NETWORK_SEPARATOR, 'name')), 0)
  const height = Math.max(...row.parts.map(part => FLOW_TEXT[part.style].line))
  return { x: row.align === 'end' ? row.x + row.width - width : row.x, y: row.y + (row.height - height) / 2, width, height }
}
const meets = (a: Rect, b: Rect): boolean => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height

describe('the Grid\'s names (§2 rule 2)', () => {
  test('a name past its room keeps its whole names and counts the rest, else the whole words that fit before an ellipsis, never part of a word', () => {
    const long = 'Hungeren - Charlottenlund / Hungeren - Charlottenlund - Kvaløya'
    expect(wholeWordsWithin(long, 52)).toBe('Hungeren - Charlottenlund +1')
    // R3 final pass: a branch of several circuits never ends inside a circuit's name.
    expect(wholeWordsWithin('Mjøndalen - Langum / Mjøndalen - Langum / Sundhaug - Mjøndalen / Langum - Sundhaug', 52)).toBe('Mjøndalen - Langum / Mjøndalen - Langum +2')
    expect(wholeWordsWithin('Hungeren - Charlottenlund - Kvaløya - Tromsø - Skaidi - Hammerfest', 52)).toBe('Hungeren - Charlottenlund - Kvaløya - Tromsø…')
    expect(wholeWordsWithin('Sylling trafostasjon 420/300 kV', 52)).toBe('Sylling trafostasjon 420/300 kV')
    expect(wholeWordsWithin('Supercalifragilistic', 8)).toBe('Superca…')
    // Every name the drawings write that the Pack shortened ends on a whole word of what it names.
    for (const [, { section }] of drawn) for (const node of section.nodes) {
      const name = node.shortLabel ?? node.label
      if (name.endsWith('…') && node.class !== 'stop') expect({ id: node.id, whole: /[\p{L}\p{N})]…$/u.test(name) }).toEqual({ id: node.id, whole: true })
    }
  })
})

describe('a network drawing\'s words (R3, W6.5 for the grid)', () => {
  test('every name and reading is whole: no name shortened, every stop naming what lies beyond whole, every bus named in its bar or beside it', () => {
    for (const [name, { section, drawing }] of drawn) {
      const nodes = new Map(section.nodes.map(node => [node.id, node]))
      for (const text of drawing.texts) {
        const node = nodes.get(text.id)!
        const written = text.rows.flatMap(row => row.parts.filter(part => part.kind === 'name').map(part => part.text))
        expect({ name, id: text.id, written }).toEqual({ name, id: text.id, written: [node.shortLabel ?? node.label] })
      }
      expect(drawing.buses.filter(bus => bus.label === '' && !drawing.texts.some(text => text.id === bus.id)).map(bus => `${name}: ${bus.id}`)).toEqual([])
      expect(drawing.buses.filter(bus => bus.label !== '' && bus.label !== (nodes.get(bus.id)!.shortLabel ?? nodes.get(bus.id)!.label)).map(bus => `${name}: ${bus.id}`)).toEqual([])
    }
  })

  test('each row fits the room the composer measured for it, and a bar holds the name it carries', () => {
    for (const [name, { drawing }] of drawn) {
      const over = drawing.texts.flatMap(text => text.rows.filter(row => inked(row).width > row.width + 0.5).map(row => `${name}: ${text.id} needs ${inked(row).width} px of ${row.width}`))
      expect(over).toEqual([])
      expect(drawing.buses.filter(bus => bus.label !== '' && textWidth(bus.label, 'busLabel') > bus.width - 8).map(bus => `${name}: ${bus.id}`)).toEqual([])
    }
  })

  test('no words stand on a bar, a symbol, a line or other words', () => {
    for (const [name, { drawing }] of drawn) {
      const rows = drawing.texts.flatMap(text => text.rows.map(row => ({ id: text.id, ...inked(row) })))
      const bars = drawing.buses.map(bus => ({ id: bus.id, x: bus.x, y: bus.y, width: bus.width, height: bus.height + (bus.tone === null ? 0 : 4) }))
      const symbols = drawing.devices.map(device => ({ id: device.id, x: device.x - NETWORK.symbol / 2, y: device.y - NETWORK.symbol / 2, width: NETWORK.symbol, height: NETWORK.symbol }))
      // A line as the band its small pipe takes.
      const lines = drawing.segments.flatMap(segment => (segment.kind !== 'straight' ? []
        : [{ id: segment.connectionId, x: Math.min(segment.x1, segment.x2) - 2, y: Math.min(segment.y1, segment.y2) - 2, width: Math.abs(segment.x2 - segment.x1) + 4, height: Math.abs(segment.y2 - segment.y1) + 4 }]))
      const against = rows.flatMap((row, at) => [
        ...bars.filter(bar => meets(row, bar)).map(bar => `${name}: ${row.id}'s words on ${bar.id}'s bar`),
        ...symbols.filter(symbol => meets(row, symbol)).map(symbol => `${name}: ${row.id}'s words on ${symbol.id}'s symbol`),
        ...lines.filter(line => meets(row, line)).map(line => `${name}: ${row.id}'s words on line ${line.id}`),
        ...rows.slice(at + 1).filter(other => meets(row, other)).map(other => `${name}: ${row.id}'s words on ${other.id}'s`),
      ])
      expect(against).toEqual([])
    }
  })
})
