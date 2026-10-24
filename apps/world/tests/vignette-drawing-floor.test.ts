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
import { declarationOf } from '../src/features/displays/compose/declared.ts'
import { DRAWING_SCALE_FLOOR, drawingScale, VIGNETTE_MAX_ROWS, type VignetteSection } from '../src/features/displays/compose/model.ts'
import { compileVignette, type ViewRun } from '../src/features/displays/compose/view.ts'
import { createDirectRoutingAdapter } from '../src/routing/direct-adapter.ts'
import { builtinScenarioDefinitions } from '../src/scenarios/definitions.ts'
import { DRAWING_TEXT_PX, TEXT_FLOOR_PX, VIGNETTE_ROW_PX } from '../src/ui/embed/vignette/grid.ts'
import { guardPlantTests } from './plant-hang-guard.ts'

guardPlantTests()

// A drawing taller than its frame is never shrunk by rows below its text floor (R3 eval: the Tokke koblingsstasjon
// 300 kV detail of the Halden connection drawn at 65 %, its text 7.8 px). The composer scales a tall drawing to its rows
// only down to the floor (12 px text at 11 px); rows that do not hold it there show it at the floor, scrolling within
// them, and its card says so. On the Runs' own scenario, as the display window composes every default.

type Topology = Extract<VignetteSection, { kind: 'topology' }>
const routing = createDirectRoutingAdapter()
const assembly = createWorldApplicationAssembly({ routing })
const person = { id: 'actor:human:drawing-floor' as ActorId, label: 'Drawing floor', role: 'operator' as const }
const GRID = 'grid:halden-four-unit' as ObjectId
const UNIT = 'plant:halden-1' as ObjectId
const FLOOR = TEXT_FLOOR_PX / DRAWING_TEXT_PX
/** Tokke koblingsstasjon 300 kV (37 grid rows), Dagali trafostasjon 420 kV (47) and the line Ertsmyra - Kvinesdal 1 (41): each under 15 rows of values. */
const TALL = ['bus:osm-relation-7883882@300', 'bus:osm-relation-7847764@420', 'branch:osm-122f7f1419547b5f'] as const
let registry: SimulationRunRegistry
let dataDir: string
let run: ViewRun

/** A default as the window composes it: its drawing as compiled, the rows the vignette takes and what its card says of its layout. */
const composed = async (subject: string): Promise<{ readonly section: Topology | undefined; readonly rows: number; readonly layout: ReadonlyArray<string> }> => {
  const outcome = await composeDefault(run, subject)
  if (!outcome.ok) throw new Error(`${subject}: ${JSON.stringify(outcome.issues)}`)
  const view = await compileVignette(run, outcome.state)
  const section = view.sections.find((entry): entry is Topology => entry.kind === 'topology')
  return { section, rows: outcome.rows, layout: outcome.card.adjusted.filter(entry => entry.kind === 'layout').map(entry => entry.text) }
}

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
  test('the Tokke switchyard\'s detail, and the tallest the grid draws, stand at the text floor in the rows left, scrolling within them; the card says so', async () => {
    // The composer's floor is the renderer's: 12 px text at 11 px.
    expect(DRAWING_SCALE_FLOOR).toBe(FLOOR)
    for (const element of TALL) {
      const { section, rows, layout } = await composed(`${GRID}#${element}`)
      expect(section).toBeDefined()
      expect({ element, scale: drawingScale(section!), ...standing(section!) }).toEqual({ element, scale: FLOOR, text: TEXT_FLOOR_PX, scrolls: true })
      // In view: its rows but the attribution's, of its height at the floor.
      const inView = Math.floor(100 * (section!.rows - 1) / ((Math.ceil(section!.layout.height)) * FLOOR))
      expect(layout).toContain(`drawing scaled to 92 %, its text floor, and scrolls: ${inView} % of its height in view`)
      expect(rows).toBeLessThanOrEqual(VIGNETTE_MAX_ROWS)
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
