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
import { composeDefault, composeVignette } from '../src/features/displays/compose/compose.ts'
import { declarationOf } from '../src/features/displays/compose/declared.ts'
import { DRAWING_SCALE_FLOOR, drawingScale, FRAME_ROWS, VIGNETTE_MAX_ROWS, type VignetteSection } from '../src/features/displays/compose/model.ts'
import { displaySpecSchema } from '../src/core/observation/spec.ts'
import { compileVignette, type ViewRun } from '../src/features/displays/compose/view.ts'
import { createDirectRoutingAdapter } from '../src/routing/direct-adapter.ts'
import { builtinScenarioDefinitions } from '../src/scenarios/definitions.ts'
import { DRAWING_TEXT_PX, TEXT_FLOOR_PX, VIGNETTE_ROW_PX } from '../src/ui/embed/vignette/grid.ts'
import { guardPlantTests } from './plant-hang-guard.ts'

guardPlantTests()

// A drawing taller than its frame is never shrunk by rows below its text floor (R3 eval: the Tokke koblingsstasjon
// 300 kV detail of the Halden connection drawn at 65 %, its text 7.8 px). The composer scales a tall drawing to its rows
// only down to the floor (12 px text at 11 px); rows that do not hold it there show it at the floor, scrolling within
// them, and its card says so. On the Runs' own scenario, as the display window composes every default. In a window
// a drawing taller than the stack leaves stands beside a column of the other views (Q20), a network drawing as a flow
// drawing does: its rows are the frame's less its own, not what its values and alerts leave under them.

type Topology = Extract<VignetteSection, { kind: 'topology' }>
const routing = createDirectRoutingAdapter()
const assembly = createWorldApplicationAssembly({ routing })
const person = { id: 'actor:human:drawing-floor' as ActorId, label: 'Drawing floor', role: 'operator' as const }
const GRID = 'grid:halden-four-unit' as ObjectId
const UNIT = 'plant:halden-1' as ObjectId
const FLOOR = TEXT_FLOOR_PX / DRAWING_TEXT_PX
/** Tokke koblingsstasjon 300 kV (37 grid rows), Dagali trafostasjon 420 kV (47) and the line Ertsmyra - Kvinesdal 1 (41): each under 15 rows of values. */
const TALL = ['bus:osm-relation-7883882@300', 'bus:osm-relation-7847764@420', 'branch:osm-122f7f1419547b5f'] as const
/** Of those, the two the frame's whole height beside their column holds only at their floor, the line whole and the station scrolling. */
const TALLEST = TALL.slice(1)
let registry: SimulationRunRegistry
let dataDir: string
let run: ViewRun

/**
 * A default as the window composes it: its drawing as compiled, the rows the vignette takes, whether the drawing stands
 * beside a column of the other views and the rows that column takes, and what its card says of its layout.
 */
const composed = async (subject: string): Promise<{ readonly section: Topology | undefined; readonly rows: number; readonly beside: boolean; readonly column: number; readonly layout: ReadonlyArray<string> }> => {
  const outcome = await composeDefault(run, subject)
  if (!outcome.ok) throw new Error(`${subject}: ${JSON.stringify(outcome.issues)}`)
  const view = await compileVignette(run, outcome.state)
  const section = view.sections.find((entry): entry is Topology => entry.kind === 'topology')
  const column = outcome.state.views.reduce((sum, entry) => sum + (entry.kind === 'topology' ? 0 : entry.rows), 0)
  return { section, rows: outcome.rows, beside: outcome.state.beside === true, column, layout: outcome.card.adjusted.filter(entry => entry.kind === 'layout').map(entry => entry.text) }
}

/** The rows a drawing's layout reaches into, and its attribution's. */
const natural = (section: Topology): number => Math.ceil(section.layout.height) + 1

/** How a drawing stands in its rows: its text on screen at its scale, and whether it is taller than its rows there. */
const standing = (section: Topology) => {
  const scale = drawingScale(section)
  return { text: DRAWING_TEXT_PX * scale, scrolls: section.layout.height * VIGNETTE_ROW_PX * scale > (section.rows - 1) * VIGNETTE_ROW_PX + 0.5 }
}

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'leitbild-drawing-floor-'))
  registry = createSimulationRunRegistry({
    dataDir, workspaceId: newWorkspaceId(), scenarioDefinitions: builtinScenarioDefinitions,
    compileScenarioDefinition: source => compileScenarioDefinition(source, assembly.packs, { routing }),
    scenarioAuthoringCatalog: scenarioAuthoringCatalogFor(assembly.packs), runtimeAdapters: assembly.runtimeAdapters,
    scenarioRuntimeResolver: createScenarioRuntimeResolver({ packs: assembly.packs }), idleRuntimeCloseTimer: () => () => {},
  })
  const runtime = await registry.create({ scenarioId: 'halden-offsite-power-restoration' })
  await runtime.setClock({ paused: true })
  await runtime.runMaximumPace(new Date(Date.parse(runtime.snapshot().clock!.currentTime) + 10_000).toISOString() as IsoTimestamp, { shouldStop: () => false })
  run = await displayRunOf(registry, runtime, person, new Set())
}, 240_000)
afterAll(async () => { await registry.shutdown(); await rm(dataDir, { recursive: true, force: true }) })

describe('a drawing taller than its frame (R3 eval)', () => {
  test('the tallest the grid draws stand at the text floor in the whole frame beside their column; the taller scrolls within it, and the card says which', async () => {
    // The composer's floor is the renderer's: 12 px text at 11 px.
    expect(DRAWING_SCALE_FLOOR).toBe(FLOOR)
    // Dagali trafostasjon 420 kV, 47 grid rows, scrolls; Ertsmyra - Kvinesdal 1, 40.3, stands whole at the floor in 37.
    for (const [element, scrolls] of [[TALLEST[0], true], [TALLEST[1], false]] as const) {
      const { section, rows, beside, column, layout } = await composed(`${GRID}#${element}`)
      expect(section).toBeDefined()
      expect({ element, scale: drawingScale(section!), ...standing(section!) }).toEqual({ element, scale: FLOOR, text: TEXT_FLOOR_PX, scrolls })
      // Beside its values and alerts it takes every row the frame leaves, and the column's alerts fill as many.
      expect({ element, beside, drawing: section!.rows, column, rows }).toEqual({ element, beside: true, drawing: VIGNETTE_MAX_ROWS - FRAME_ROWS, column: VIGNETTE_MAX_ROWS - FRAME_ROWS, rows: VIGNETTE_MAX_ROWS })
      // In view: its rows but the attribution's, of its height at the floor, as the renderer scrolls it.
      const inView = Math.floor(100 * (section!.rows - 1) / (section!.layout.height * FLOOR))
      expect(layout).toContain(scrolls ? `drawing scaled to 92 %, its text floor, and scrolls: ${inView} % of its height in view` : 'drawing scaled to 92 % to fit')
    }
  })

  test('no default of an element the grid\'s overview or its tall details draw, nor of a unit\'s, draws its text below the floor; whichever scrolls, its card says so', async () => {
    const drawings = await Promise.all([GRID, ...TALL.map(element => `${GRID}#${element}`)].map(async subject => (await composed(subject)).section!))
    const drawnElements = [...new Set(drawings.flatMap(drawing => drawing.nodes.flatMap(node => node.element === undefined ? [] : [node.element])))]
    const unit = (await declarationOf(run, UNIT))!.elements.map(element => element.id)
    expect(drawnElements.length).toBeGreaterThan(40)
    expect(unit.length).toBeGreaterThan(50)
    const below: string[] = []
    const unsaid: string[] = []
    for (const subject of [GRID, UNIT, ...drawnElements.map(id => `${GRID}#${id}`), ...unit.map(id => `${UNIT}#${id}`)]) {
      const { section, layout } = await composed(subject)
      if (section === undefined) continue
      const { text, scrolls } = standing(section)
      if (text < TEXT_FLOOR_PX - 1e-9) below.push(`${subject}: ${text.toFixed(1)} px`)
      if (scrolls && !layout.some(line => line.includes('its text floor, and scrolls'))) unsaid.push(subject)
    }
    expect(below).toEqual([])
    expect(unsaid).toEqual([])
  })
})

describe('a network drawing beside its column in a window (Q20)', () => {
  test('the Tokke switchyard\'s detail, which scrolled at its floor in the rows its values and alerts left, stands beside them whole', async () => {
    const { section, rows, beside, column, layout } = await composed(`${GRID}#${TALL[0]}`)
    expect(section!.family).toBe('network')
    // 37 grid rows and its attribution's: more than the stack leaves under 15 rows of values and alerts, all the frame leaves beside them.
    expect(natural(section!)).toBe(VIGNETTE_MAX_ROWS - FRAME_ROWS)
    expect({ beside, drawing: section!.rows, scale: drawingScale(section!), ...standing(section!), column, rows }).toEqual({
      beside: true, drawing: natural(section!), scale: 1, text: DRAWING_TEXT_PX, scrolls: false, column: natural(section!), rows: VIGNETTE_MAX_ROWS,
    })
    expect(layout.filter(line => line.startsWith('drawing scaled'))).toEqual([])
  })

  test('in a chat the same detail stacks under its values and alerts, in the rows they leave it (W7.3)', async () => {
    const outcome = await composeVignette(run, displaySpecSchema.parse({ title: 'Tokke', question: 'What is around Tokke?', subjects: [`${GRID}#${TALL[0]}`], views: [] }))
    if (!outcome.ok) throw new Error(JSON.stringify(outcome.issues))
    const drawing = outcome.state.views.find(view => view.kind === 'topology')!
    const column = outcome.state.views.reduce((sum, view) => sum + (view === drawing ? 0 : view.rows), 0)
    expect(outcome.state.beside).toBeUndefined()
    // The frame, the answer's notice line, the column, then the drawing in what is left of 40 rows.
    expect(outcome.rows).toBe(VIGNETTE_MAX_ROWS)
    expect(drawing.rows).toBe(VIGNETTE_MAX_ROWS - FRAME_ROWS - 1 - column)
    expect(drawing.rows).toBeLessThan(VIGNETTE_MAX_ROWS - FRAME_ROWS)
  })

  test('every default the grid\'s overview or its tall details draw, and a unit\'s, either stacks with its drawing whole or stands it beside its column; only a drawing the whole frame does not hold scrolls', async () => {
    const drawings = await Promise.all([GRID, ...TALL.map(element => `${GRID}#${element}`)].map(async subject => (await composed(subject)).section!))
    const drawnElements = [...new Set(drawings.flatMap(drawing => drawing.nodes.flatMap(node => node.element === undefined ? [] : [node.element])))]
    const unit = (await declarationOf(run, UNIT))!.elements.map(element => element.id)
    const cut: string[] = []
    const scrolling: string[] = []
    let besides = 0
    for (const subject of [GRID, UNIT, ...drawnElements.map(id => `${GRID}#${id}`), ...unit.map(id => `${UNIT}#${id}`)]) {
      const { section, rows, beside, column } = await composed(subject)
      if (section === undefined) continue
      if (beside) besides += 1
      // Stacked, the frame holds every view and the whole drawing; beside, a drawing gives rows only where it takes all
      // the frame leaves, no fewer than its column.
      if (!beside && section.rows !== natural(section)) cut.push(`${subject}: stacked in ${section.rows} of ${natural(section)} rows`)
      if (beside && section.rows < natural(section) && !(rows === VIGNETTE_MAX_ROWS && section.rows >= column)) cut.push(`${subject}: ${section.rows} of ${natural(section)} rows beside a column of ${column}`)
      if (standing(section).scrolls && !(beside && rows === VIGNETTE_MAX_ROWS)) scrolling.push(`${subject}: scrolls in ${section.rows} rows of ${rows}`)
    }
    expect(cut).toEqual([])
    expect(scrolling).toEqual([])
    expect(besides).toBeGreaterThan(TALL.length)
  })
})
