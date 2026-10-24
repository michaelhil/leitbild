import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { IsoTimestamp, OperationalObject, ProcedureId } from '../src/core/model/index.ts'
import { processPlantUnitPackDataSchema, type ProcessPlantUnitProjection, type ProcessPlantUnitSafetyFunction } from '../src/packs/process-plant/model.ts'
import { windowUnit } from '../src/packs/process-plant/ui/displays/window/window-unit.ts'
import { appendPoint, HOLD_GAP_MS } from '../src/packs/process-plant/ui/recorded-sparkline.ts'
import { scenarios } from './fixtures/scenarios.ts'

// A press on a Plant's map icon or rail row opens its overview display (owner, 23 Oct): the small Plant card it
// opened before is gone, and what the card offered stands in the display window, in the Plant's window tools
// (PackUiContribution.windowTools) where the display does not say it itself.

const at = '2026-10-14T09:00:00.000Z' as IsoTimestamp
const unit = scenarios.find(scenario => scenario.id === 'test-plant')?.initialObjects.find(object => object.packId === 'process-plant')
if (unit === undefined) throw new Error('the Plant fixture has no Plant')

const running: ProcessPlantUnitProjection = {
  schemaVersion: 1,
  summary: 'Core thermal power 3400 MW · Electrical output 1162 MW',
  statusTone: 'ready',
  statusLabel: 'Normal',
  activeAlarmCount: 0,
  activeTripCount: 0,
  energy: [],
  fields: [],
  updatedAt: at,
}

const heatSink = (status: ProcessPlantUnitSafetyFunction['status'], procedure?: string): ProcessPlantUnitSafetyFunction => ({
  id: 'heat-sink',
  label: 'Heat sink',
  shortLabel: 'HEAT SINK',
  status,
  ...(procedure === undefined ? {} : { procedure }),
  meaning: 'No steam generator has level on span and feed is below the minimum flow: the secondary heat sink is lost.',
})

const plantWith = (projection: ProcessPlantUnitProjection | undefined): OperationalObject => {
  const data = processPlantUnitPackDataSchema.parse(unit.packData)
  const { projection: _stored, ...rest } = data
  return { ...unit, packData: projection === undefined ? rest : { ...rest, projection } }
}

const operator = { running: [] as ReadonlyArray<ProcedureId>, controller: false }
const controller = { ...operator, controller: true }

describe('what the window\'s Plant tools read from the unit', () => {
  test('a running unit has started, offers no procedure while no safety function calls for one, and the Instructor only to the Run\'s controller', () => {
    expect(windowUnit(plantWith(running), operator)).toEqual({ started: true, notRunning: null, instructor: false })
    expect(windowUnit(plantWith(running), controller)).toEqual({ started: true, notRunning: null, instructor: true })
  })

  test('a unit whose runtime is pending says that it has not started, and nothing its projection would say', () => {
    for (const object of [plantWith(undefined), plantWith({ ...running, summary: 'Process runtime pending', statusTone: 'idle', statusLabel: 'Runtime pending', worstSafetyFunction: heatSink('red', 'FR-H.1') })]) {
      expect(windowUnit(object, controller)).toEqual({ started: false, notRunning: null, instructor: true })
    }
  })

  test('the procedure the most challenged safety function calls for, while no active run on the unit runs it', () => {
    const lost = plantWith({ ...running, worstSafetyFunction: heatSink('red', 'FR-H.1') })
    expect(windowUnit(lost, operator)?.notRunning).toEqual({
      procedureId: 'FR-H.1',
      why: 'Heat sink: RED\nNo steam generator has level on span and feed is below the minimum flow: the secondary heat sink is lost.',
    })
    // Running it is no longer "not running"; a run of it that ended is (the window lists active runs only).
    expect(windowUnit(lost, { ...operator, running: ['FR-H.1', 'E-0'] })?.notRunning).toBeNull()
    expect(windowUnit(lost, { ...operator, running: ['E-0'] })?.notRunning?.procedureId).toBe('FR-H.1')
    expect(windowUnit(plantWith({ ...running, worstSafetyFunction: heatSink('orange', 'FR-H.1') }), operator)?.notRunning?.procedureId).toBe('FR-H.1')
  })

  test('none challenged, one that cannot be judged or is not judged, none declared, or a procedure name the window cannot open: no procedure to offer', () => {
    for (const worst of [heatSink('green'), heatSink('unknown'), heatSink('not-monitored'), undefined, heatSink('orange', 'see the shift supervisor')]) {
      expect(windowUnit(plantWith({ ...running, ...(worst === undefined ? {} : { worstSafetyFunction: worst }) }), operator)?.notRunning).toBeNull()
    }
  })

  test('an object that is no Plant has no unit to read, and so no engineering views or Instructor', () => {
    expect(windowUnit({ ...unit, packData: { type: 'drone' } }, controller)).toBeNull()
  })
})

const source = (path: string): string => readFileSync(join(import.meta.dir, '..', 'src', path), 'utf8')
const markupOf = (file: string): string => file.slice(file.lastIndexOf('</script>'))

describe('the Plant\'s window tools offer what the card offered, each by the card\'s rule', () => {
  const tools = source('packs/process-plant/ui/displays/WindowTools.svelte')

  test('the engineering views only for a Plant, the Plant catalog always, the Assistant where the Host offers it, the Instructor only where it is offered', () => {
    const engineering = tools.slice(tools.indexOf('{#snippet engineeringItems'), tools.indexOf('{/snippet}', tools.indexOf('{#snippet engineeringItems')))
    const plantOnly = engineering.slice(engineering.indexOf('{#if isPlant}'), engineering.indexOf('{/if}'))
    for (const view of ['Component graph', 'Plant specification', 'Model credibility']) expect(plantOnly).toContain(`<span>${view}</span>`)
    expect(engineering.slice(engineering.indexOf('{/if}'))).toContain('<span>Plant catalog</span>')
    expect(tools).toMatch(/const isPlant = \$derived\(unit !== null\)/)
    expect(tools).toMatch(/const instructorOffered = \$derived\(unit\?\.instructor === true\)/)
    expect(tools).toMatch(/const unit = \$derived\(windowUnit\(object, \{ running: runningProcedures, controller \}\)\)/)
    // Every Assistant button stands under the Host's offer (in the header with room, else in a menu), every Instructor menu under its offer.
    expect(tools.match(/<Sparkles/g)).toHaveLength(3)
    expect(tools.match(/\{#if openAssistant !== null( && room === '(wide|short)')?\}\s*<button((?!\{\/if\})[\s\S])*?<Sparkles/g)).toHaveLength(3)
    expect(tools).toMatch(/\{#if instructorOffered\}\s*<div class="menu-label">Instructor<\/div>/)
    expect(tools).toMatch(/\{#if !folded && instructorOffered\}/)
  })

  test('the not-started chip, the proposals and the procedure a safety function calls for stay in the header; folded, every tool is a More menu item', () => {
    const header = markupOf(tools)
    const chips = header.slice(header.indexOf('<div class="display-window-plant"'), header.indexOf('{#if !folded}'))
    expect(chips).toContain('Not started')
    expect(chips).toContain('<ProposalsChip')
    // The procedure a safety function calls for stands in the header while there is room, else first in the window's More.
    expect(chips).toMatch(/\{#if unit\?\.notRunning && !folded\}/)
    expect(chips).toMatch(/onclick=\{\(\) => openProcedure\(called\.procedureId\)\}/)
    expect(tools).toMatch(/const folded = \$derived\(room === 'folded'\)/)
    expect(tools).toMatch(/menu\(folded \? foldedTools : null\)/)
    // Short of room, the Instructor's label gives way to its icon; the menu keeps its name.
    expect(tools).toMatch(/\{#if room === 'wide'\}<span>Instructor<\/span>\{\/if\}/)
    const folded = tools.slice(tools.indexOf('{#snippet foldedTools'), tools.indexOf('{/snippet}', tools.indexOf('{#snippet foldedTools')))
    for (const item of ['Operations log', '<span>Assistant</span>', '{@render engineeringItems(done, undefined)}', '{@render instructorItem(done, undefined)}']) expect(folded).toContain(item)
    expect(folded.indexOf('{#if unit?.notRunning}')).toBeLessThan(folded.indexOf('Operations log'))
    expect(folded).toMatch(/onclick=\{\(\) => \{ done\(\); openProcedure\(called\.procedureId\) \}\}/)
  })

  test('the window passes them the screen\'s controller role, the Host\'s Assistant, the active procedures and its narrow widths, and lists their items in its More menu', () => {
    const window = source('ui/process-display/DisplayWindow.svelte')
    expect(window).toMatch(/const toolsRoom = \$derived<PackWindowToolsProps\['room'\]>\(tier === 'wide' \? 'wide' : tier === 'medium' \? 'short' : 'folded'\)/)
    for (const prop of ['{controller}', '{openAssistant}', 'runningProcedures={procedureSummaries.active.map(summary => summary.procedureId)}', 'openProcedure={openProcedures}', 'room={toolsRoom}']) expect(window).toContain(prop)
    const more = window.slice(window.indexOf("{:else if popover === 'more'}"))
    expect(more).toMatch(/\{#if toolsMenu !== null\}\s*\{@render toolsMenu\(\(\) => closePopover\(true\)\)\}/)
    const route = source('ui/routes/ControlSurfaceRoute.svelte')
    expect(route).toContain('controller={controllerControls}')
    expect(route).toContain('openAssistant={runAssistantOffered && simulationRunId !== null ? openRunAssistant : null}')
  })
})

describe('a press on a Plant opens its overview display', () => {
  const route = source('ui/routes/ControlSurfaceRoute.svelte')

  test('a press its Pack opens a display for opens it, unless a placement or an assignment has the map; the map\'s disk takes the same presses', () => {
    expect(route).toMatch(/const opensDisplay = \(object: OperationalObject\): boolean => activePack\?\.packForObject\(object\)\.ui\?\.displayOnPress === true/)
    expect(route).toMatch(/if \(route\.kind === 'display'\) \{[^}]*if \(placementMode === null && mapAssignment === null\) openDisplayFromPress\(route\.objectId\)/)
    expect(route).toContain('takesDiskClicks={opensDisplay}')
    expect(route).toMatch(/opensDisplay \}\)/)
    // On close the window gives focus back to the rail row the press came from, else to the map.
    const open = route.slice(route.indexOf('const openDisplayFromPress'), route.indexOf('const selectObject'))
    expect(open).toContain(".closest('.control-rail')")
    expect(open).toContain(".maplibregl-canvas')?.focus({ preventScroll: true })")
    expect(open).toContain('openProcessDisplay(object)')
  })

  test('the card, its view model, its trends, its map anchor, its route state and its rail props are gone', () => {
    for (const path of ['packs/process-plant/ui/PlantCard.svelte', 'packs/process-plant/ui/plant-card.ts', 'packs/process-plant/ui/plant-card-trends.ts', 'packs/process-plant/ui/plant-card-sparkline.ts', 'ui/map/object-card-anchor.ts']) {
      expect(existsSync(join(import.meta.dir, '..', 'src', path))).toBe(false)
    }
    const files = (dir: string): ReadonlyArray<string> => readdirSync(dir).flatMap(name => {
      const path = join(dir, name)
      if (name === 'dist' || name === 'node_modules') return []
      return statSync(path).isDirectory() ? files(path) : /\.(ts|svelte)$/.test(name) ? [path] : []
    })
    const naming = files(join(import.meta.dir, '..', 'src')).filter(path => /PlantCard|plantCard|plant-card|object-card-anchor|cardObjectId|onCardFrame|opensCard|MapCardFrame/.test(readFileSync(path, 'utf8')))
    expect(naming).toEqual([])
  })
})

describe('a recorded value\'s line keeps what its window can still reach', () => {
  test('points stay ordered, a newer point replaces any at or after its time, and those whose hold ends before the window leave it', () => {
    const points = [{ t: 0, v: 1 }, { t: 60_000, v: 2 }, { t: 120_000, v: 3 }]
    expect(appendPoint(points, { t: 120_000, v: 4 }, 0)).toEqual([{ t: 0, v: 1 }, { t: 60_000, v: 2 }, { t: 120_000, v: 4 }])
    expect(appendPoint(points, { t: 200_000, v: 5 }, 60_000 + HOLD_GAP_MS)).toEqual([{ t: 60_000, v: 2 }, { t: 120_000, v: 3 }, { t: 200_000, v: 5 }])
  })
})
