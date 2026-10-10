import { describe, expect, test } from 'bun:test'
import type { IsoTimestamp, ObjectId } from '../src/core/model/index.ts'
import { recordingSeriesIdFor } from '../src/core/model/index.ts'
import {
  answerProcessPlantQuery,
  compileProcessPlant,
  createProcessPlantProtectionRunner,
  createProcessPlantRampRunner,
  createProcessPlantRuntime,
  createPwrReferencePlantDefinition,
} from '../src/packs/process-plant/index.ts'
import { createProcessPlantRuntimePerformance, type ProcessPlantRuntimeInstance } from '../src/packs/process-plant/runtime-instance.ts'
import { recordedPlantVariables } from '../src/packs/process-plant/recording.ts'
import { compileOverviewDisplay, overviewDrawingRoom, type CompiledComposedDisplay, type OverviewView } from '../src/packs/process-plant/displays/compose.ts'

// Process display windows as measured on production in Full HD and QHD browsers.
const fullHd: OverviewView = { width: 1896, height: 972 }
const qhd: OverviewView = { width: 2536, height: 1332 }

const plant = (loopCount = 4): ProcessPlantRuntimeInstance => {
  const compiled = compileProcessPlant(createPwrReferencePlantDefinition({ id: 'plant:overview', loopCount }))
  const runtime = createProcessPlantRuntime({ system: compiled })
  return {
    plant: compiled,
    runtime,
    ramps: createProcessPlantRampRunner({ runtime }),
    protection: createProcessPlantProtectionRunner({ system: compiled, protection: compiled.automation }),
    performance: createProcessPlantRuntimePerformance(),
  }
}

describe('the unit overview World generates for a Plant', () => {
  const system = plant()
  const plants = new Map([[system.plant.id, system]])
  const ask = (capabilityId: string, input: unknown) => answerProcessPlantQuery({
    request: { capabilityId, input },
    plants,
    objects: new Map([[system.plant.id as ObjectId, { id: system.plant.id as ObjectId, label: 'Halden Unit 1' }]]),
    simulationTime: '2026-10-09T10:00:00.000Z' as IsoTimestamp,
    recordedSeriesIds: new Set(recordedPlantVariables(system.plant, 'operations').map(variable => recordingSeriesIdFor(system.plant.id, variable.path))),
  })

  test('opens as a view of its own, saying what it shows and the state of every drawn item', () => {
    const result = ask('world.process-plant.display.overview', { plantId: system.plant.id }) as {
      view: { title: string; height: number; state: string }
      shows: ReadonlyArray<string>
      equipment: ReadonlyArray<{ label: string; state: string }>
    }
    expect(result.view.title).toBe('Halden Unit 1 overview')
    expect(JSON.parse(result.view.state)).toEqual({ overview: { plantId: system.plant.id } })
    expect(result.view.height).toBeLessThanOrEqual(960)
    expect(result.shows.join(' ')).toContain('PZR')
    expect(result.equipment.map(item => item.label)).toEqual(expect.arrayContaining(['PZR', 'SG A', 'RCP D', 'Turbine', 'Condenser']))
  })

  test('re-opens from its state as lead values, the principal circuits and the Plant\'s alarms, with no advice', () => {
    const opened = ask('world.process-plant.display.overview', { plantId: system.plant.id }) as { view: { state: string } }
    // A view without its size is refused: an overview is drawn for the window it is shown in.
    expect(() => ask('world.process-plant.display.view', { plantId: system.plant.id, state: opened.view.state })).toThrow('send its size')
    const result = ask('world.process-plant.display.view', { plantId: system.plant.id, state: opened.view.state, size: fullHd }) as {
      kind: string
      plantLabel: string
      display: CompiledComposedDisplay
    }
    expect(result.kind).toBe('overview')
    expect(result.plantLabel).toBe('Halden Unit 1')
    expect(result.display.advice).toBeNull()
    expect(result.display.panels.map(panel => panel.kind)).toEqual(['readouts', 'mimic', 'alarms'])
    const mimic = result.display.panels.find(panel => panel.kind === 'mimic')!
    if (mimic.kind !== 'mimic') throw new Error('expected the mimic')
    expect(mimic.mimic.profile).toBe('overview')
    expect(mimic.mimic.intent).toBeNull()
    // One sample reads everything the overview draws.
    const sample = ask('world.process-plant.display.sample', { plantId: system.plant.id, paths: mimic.mimic.paths, alarms: true }) as { values: ReadonlyArray<unknown> }
    expect(sample.values).toHaveLength(mimic.mimic.paths.length)
  })

  test('a composed display re-opens as advice', () => {
    const composed = ask('world.process-plant.display.compose', {
      plantId: system.plant.id,
      title: 'Pressurizer pressure',
      question: 'Is pressurizer pressure holding?',
      need: 'Decide on spray',
      panels: [{ kind: 'trend', horizon: '10m', signals: [{ ref: 'pressurizer.pressureMPa', role: 'primary' }] }],
    }) as { view: { state: string } }
    const result = ask('world.process-plant.display.view', { plantId: system.plant.id, state: composed.view.state }) as { kind: string; display: CompiledComposedDisplay }
    expect(result.kind).toBe('advice')
    expect(result.display.advice).toEqual({ question: 'Is pressurizer pressure holding?', need: 'Decide on spray' })
  })

  test('is drawn whole for the window it is shown in when it fits: four loops in Full HD, six in QHD', () => {
    const drawn = (system: ProcessPlantRuntimeInstance, view: OverviewView | null) => {
      const result = compileOverviewDisplay(system, new Set(), view)
      if (!result.ok) throw new Error(result.issues.map(issue => issue.message).join('; '))
      const panel = result.display.panels.find(candidate => candidate.kind === 'mimic')!
      if (panel.kind !== 'mimic') throw new Error('expected the mimic')
      return { height: result.display.height, mimic: panel.mimic }
    }
    // Lead values, drawing and alarms all show without scrolling.
    expect(drawn(system, fullHd).height).toBeLessThanOrEqual(fullHd.height)
    const sixLoops = plant(6)
    expect(drawn(sixLoops, qhd).height).toBeLessThanOrEqual(qhd.height)
    // Too small a window draws it as wide as the window, or at its own size, and the view scrolls.
    const cramped = drawn(sixLoops, fullHd)
    expect(cramped.mimic.width > fullHd.width || cramped.height > fullHd.height).toBe(true)
    // With no window (a listing of what it draws) it is drawn at its own size.
    expect(drawn(system, null).mimic.items.length).toBe(drawn(system, fullHd).mimic.items.length)
  })

  test('in a Full HD window four loops draw beside the column of lead values and alarms, the window\'s whole height theirs', () => {
    const column = overviewDrawingRoom(fullHd, 'column', 6)!
    const stacked = overviewDrawingRoom(fullHd, 'stacked', 6)!
    expect(column.maxHeight).toBeGreaterThan(stacked.maxHeight + 200)
    const result = compileOverviewDisplay(system, new Set(), fullHd)
    if (!result.ok) throw new Error(result.issues.map(issue => issue.message).join('; '))
    const panel = result.display.panels.find(candidate => candidate.kind === 'mimic')!
    if (panel.kind !== 'mimic') throw new Error('expected the mimic')
    expect(panel.mimic.width).toBeLessThanOrEqual(column.maxWidth)
    expect(panel.mimic.height).toBeLessThanOrEqual(column.maxHeight)
    expect(panel.mimic.readoutSize).toBe('regular')
  })

  test('an overview state for another Plant is refused', () => {
    expect(() => ask('world.process-plant.display.view', { plantId: system.plant.id, state: JSON.stringify({ overview: { plantId: 'plant:other' } }) }))
      .toThrow(`Display state targets plant:other, not ${system.plant.id}`)
  })
})

describe('equipment opened from the unit overview', () => {
  const system = plant()
  const plants = new Map([[system.plant.id, system]])
  const ask = (capabilityId: string, input: unknown) => answerProcessPlantQuery({
    request: { capabilityId, input },
    plants,
    objects: new Map(),
    simulationTime: '2026-10-09T10:00:00.000Z' as IsoTimestamp,
    recordedSeriesIds: new Set(),
  })
  const detailState = (components: ReadonlyArray<string>) => JSON.stringify({ detail: { plantId: system.plant.id, components } })

  test('every drawn item names the components it opens: a group its members, other equipment itself', () => {
    const result = compileOverviewDisplay(system, new Set(), fullHd)
    if (!result.ok) throw new Error(result.issues.map(issue => issue.message).join('; '))
    const panel = result.display.panels.find(candidate => candidate.kind === 'mimic')!
    if (panel.kind !== 'mimic') throw new Error('expected the mimic')
    const opens = new Map(panel.mimic.items.map(item => [item.binding.label, item.components]))
    expect(opens.get('MFW A/B')).toEqual(['mainFeedwaterPumpA', 'mainFeedwaterPumpB'])
    expect(opens.get('SG B')).toEqual(['sgB'])
    expect(panel.mimic.items.every(item => item.components.length > 0)).toBe(true)
  })

  test('opens as what feeds it and where its outflow goes, its own values first and the alarms of what is drawn', () => {
    expect(() => ask('world.process-plant.display.view', { plantId: system.plant.id, state: detailState(['sgB']) })).toThrow('send its size')
    const result = ask('world.process-plant.display.view', { plantId: system.plant.id, state: detailState(['sgB']), size: fullHd }) as {
      kind: string
      display: CompiledComposedDisplay
    }
    expect(result.kind).toBe('detail')
    expect(result.display.title).toBe('Steam Generator B')
    expect(result.display.advice).toBeNull()
    expect(result.display.height).toBeLessThanOrEqual(fullHd.height)
    expect(result.display.panels.map(panel => panel.kind)).toEqual(['readouts', 'mimic', 'alarms'])
    const [readouts, mimic, alarms] = result.display.panels
    if (readouts?.kind !== 'readouts' || mimic?.kind !== 'mimic' || alarms?.kind !== 'alarms') throw new Error('expected readouts, a mimic and alarms')
    // Its own signals lead, the ones its I&C rules judge first.
    expect(readouts.pens.every(pen => String(pen.path).startsWith('sgB.'))).toBe(true)
    expect(readouts.pens[0]!.thresholds.length).toBeGreaterThan(0)
    // Narrowed to its loop: both sides of the steam generator, the shared headers beyond as stops, every valve named.
    expect(mimic.mimic.profile).toBe('detail')
    expect(mimic.mimic.items.some(item => item.marker)).toBe(false)
    const labels = mimic.mimic.items.map(item => item.binding.label)
    expect(labels).toEqual(expect.arrayContaining(['SG B', 'RCP B', 'FCV B', 'MSIV B']))
    expect(labels).not.toContain('SG A')
    expect(mimic.mimic.stubs.map(stub => stub.text)).toContain('to Steam header inlet B')
    expect(alarms.scope).toBe('related')
    expect(alarms.ruleIds.length).toBeGreaterThan(0)
  })

  test('equipment the Plant does not have is refused', () => {
    expect(() => ask('world.process-plant.display.view', { plantId: system.plant.id, state: detailState(['nope']), size: fullHd })).toThrow(new RegExp(`^${system.plant.id} has no component nope$`))
  })
})
