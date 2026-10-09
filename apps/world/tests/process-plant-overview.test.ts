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
import { compileOverviewDisplay, overviewDrawingRoom, UNIT_OVERVIEW_SCREENS, type CompiledComposedDisplay } from '../src/packs/process-plant/displays/compose.ts'

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
    const result = ask('world.process-plant.display.view', { plantId: system.plant.id, state: opened.view.state }) as {
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

  test('is drawn for the smallest screen its Plant fits whole at 1:1: four loops on Full HD, six on QHD', () => {
    const fitted = (system: ProcessPlantRuntimeInstance) => {
      const result = compileOverviewDisplay(system, new Set())
      if (!result.ok) throw new Error(result.issues.map(issue => issue.message).join('; '))
      const panel = result.display.panels.find(candidate => candidate.kind === 'mimic')!
      if (panel.kind !== 'mimic') throw new Error('expected the mimic')
      const readouts = result.display.panels.find(candidate => candidate.kind === 'readouts')
      const values = readouts?.kind === 'readouts' ? readouts.pens.length : 0
      const screen = UNIT_OVERVIEW_SCREENS.findIndex(candidate => (['column', 'stacked'] as const).some(arrangement => {
        const room = overviewDrawingRoom(candidate, arrangement, values)
        return room !== null && panel.mimic.width <= room.maxWidth && panel.mimic.height <= room.maxHeight
      }))
      // Lead values, drawing and alarms all show on that screen without scrolling.
      expect(result.display.height).toBeLessThanOrEqual(UNIT_OVERVIEW_SCREENS[screen]!.height)
      return screen
    }
    expect(fitted(system)).toBe(0)
    expect(fitted(plant(6))).toBe(1)
  })

  test('on a Full HD screen four loops draw beside the column of lead values and alarms, the window\'s whole height theirs', () => {
    const fullHd = UNIT_OVERVIEW_SCREENS[0]
    const column = overviewDrawingRoom(fullHd, 'column', 6)!
    const stacked = overviewDrawingRoom(fullHd, 'stacked', 6)!
    expect(column.maxHeight).toBeGreaterThan(stacked.maxHeight + 200)
    const result = compileOverviewDisplay(system, new Set())
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
