import { describe, expect, test } from 'bun:test'
import type { IsoTimestamp } from '../src/core/model/index.ts'
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
import { compileMimic } from '../src/packs/process-plant/displays/mimic/compile-mimic.ts'
import type { CompiledMimic } from '../src/packs/process-plant/displays/mimic/mimic-model.ts'

const plantWithLoops = (loopCount: number): ProcessPlantRuntimeInstance => {
  const compiled = compileProcessPlant(createPwrReferencePlantDefinition({ id: `plant:mimic-${loopCount}`, loopCount }))
  const runtime = createProcessPlantRuntime({ system: compiled })
  return {
    plant: compiled,
    runtime,
    ramps: createProcessPlantRampRunner({ runtime }),
    protection: createProcessPlantProtectionRunner({ system: compiled, protection: compiled.automation }),
    performance: createProcessPlantRuntimePerformance(),
  }
}

const compiled = (system: ProcessPlantRuntimeInstance, loops?: ReadonlyArray<string>): CompiledMimic => {
  const result = compileMimic(system, { view: 'feed-to-sg', ...(loops === undefined ? {} : { loops }) })
  if (!result.ok) throw new Error(result.issues.join('; '))
  return result.mimic
}

// Layout checks every reviewed view must pass at every loop count.
const layoutProblems = (mimic: CompiledMimic): ReadonlyArray<string> => {
  const problems: string[] = []
  const inside = (x: number, y: number): boolean => x >= 0 && x <= mimic.width && y >= 0 && y <= mimic.height
  const symbols = mimic.nodes.filter(node => node.symbol !== 'header')
  for (const node of mimic.nodes) {
    if (!inside(node.x, node.y) || !inside(node.x + node.width, node.y + node.height)) problems.push(`${node.id} outside the drawing`)
    if (node.x % 2 !== 0 || node.y % 2 !== 0) problems.push(`${node.id} off the grid`)
  }
  symbols.forEach((node, index) => symbols.slice(index + 1).forEach(other => {
    const overlap = node.x < other.x + other.width && other.x < node.x + node.width && node.y < other.y + other.height && other.y < node.y + node.height
    if (overlap) problems.push(`${node.id} overlaps ${other.id}`)
  }))
  for (const pipe of mimic.pipes) {
    pipe.points.forEach(([x, y], index) => {
      if (!inside(x, y)) problems.push(`${pipe.id} leaves the drawing`)
      const previous = pipe.points[index - 1]
      if (previous !== undefined && previous[0] !== x && previous[1] !== y) problems.push(`${pipe.id} has a diagonal segment`)
    })
  }
  return problems
}

describe('feed-to-SG mimic view', () => {
  for (const loopCount of [2, 4, 6]) {
    test(`draws every loop of a ${loopCount}-loop plant within its box, on the grid, without overlaps or diagonal pipes`, () => {
      const system = plantWithLoops(loopCount)
      const mimic = compiled(system)
      expect(mimic.loops).toHaveLength(loopCount)
      expect(mimic.nodes.filter(node => node.symbol === 'steam-generator')).toHaveLength(loopCount)
      expect(layoutProblems(mimic)).toEqual([])
    })
  }

  test('never draws a writable command as equipment state', () => {
    const system = plantWithLoops(4)
    const mimic = compiled(system)
    const writable = (path: string): boolean => system.plant.graph.signalBindingByPath.get(path as never)!.writable
    for (const node of mimic.nodes) {
      if (node.state.kind === 'pump') {
        expect(writable(node.state.speedPath)).toBe(false)
        // The run command only annotates a mismatch; it is the writable one.
        expect(writable(node.state.commandPath)).toBe(true)
      }
      if (node.state.kind === 'valve') expect(writable(node.state.positionPath)).toBe(false)
      if (node.state.kind === 'level') expect(writable(node.state.levelPath)).toBe(false)
      for (const value of node.values) expect(writable(value.path)).toBe(false)
    }
    for (const pipe of mimic.pipes) expect(writable(pipe.flowPath)).toBe(false)
  })

  test('draws only the chosen loops, and rejects loops the plant does not have', () => {
    const system = plantWithLoops(4)
    const mimic = compiled(system, ['B'])
    expect(mimic.nodes.filter(node => node.symbol === 'steam-generator').map(node => node.label)).toEqual(['SG B'])
    const unknown = compileMimic(system, { view: 'feed-to-sg', loops: ['E'] })
    expect(unknown).toEqual({ ok: false, issues: ['loops E do not exist in plant:mimic-4; it has loops A, B, C, D'] })
  })

  test('frames equipment with the alarm and trip rules acting on it', () => {
    const mimic = compiled(plantWithLoops(4))
    const sgB = mimic.nodes.find(node => node.id === 'sg-b')!
    expect(sgB.ruleIds).toEqual(expect.arrayContaining(['sg-b-level-low', 'sg-b-level-low-low-afw-actuation']))
    expect(sgB.ruleIds.some(ruleId => ruleId.startsWith('sg-a-'))).toBe(false)
  })

  test('is unavailable, explicitly, for a Plant model without reviewed views', () => {
    const system = plantWithLoops(4)
    const other = { ...system, plant: { ...system.plant, modelRef: 'process-plant.other' } } as ProcessPlantRuntimeInstance
    expect(compileMimic(other, { view: 'feed-to-sg' })).toEqual({ ok: false, issues: ['mimic panels are not available for Plant model process-plant.other'] })
  })
})

describe('mimic panels in composed displays', () => {
  const system = plantWithLoops(4)
  const plants = new Map([[system.plant.id, system]])
  const recordedSeriesIds = new Set(recordedPlantVariables(system.plant, 'operations').map(variable => recordingSeriesIdFor(system.plant.id, variable.path)))
  const ask = (capabilityId: string, input: unknown) => answerProcessPlantQuery({
    request: { capabilityId, input },
    plants,
    objects: new Map(),
    simulationTime: '2026-10-09T10:00:00.000Z' as IsoTimestamp,
    recordedSeriesIds,
  })
  const display = (panels: ReadonlyArray<unknown>) => ({
    plantId: system.plant.id,
    title: 'Feed to SG B',
    question: 'Is feedwater reaching SG B?',
    need: 'Decide whether to take manual feed control',
    panels,
  })
  const rejection = (input: unknown): string => {
    try {
      ask('world.process-plant.display.compose', input)
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
    throw new Error('expected a rejection')
  }

  test('compose a mimic alone, and say what it draws', () => {
    const result = ask('world.process-plant.display.compose', display([{ kind: 'mimic', view: 'feed-to-sg', loops: ['B'] }])) as { shows: ReadonlyArray<string>; view: { height: number } }
    expect(result.shows[0]).toStartWith('Live equipment mimic of main feedwater')
    expect(result.shows[0]).toContain('loops B')
    expect(result.view.height).toBeLessThanOrEqual(640)
  })

  // The skill's size rule: next to a mimic, a one-measurement trend and alarms, or a two-measurement trend.
  test('fit a mimic beside the trends the skill allows, and reject more', () => {
    const mimic = { kind: 'mimic', view: 'feed-to-sg' }
    const oneMeasurement = { kind: 'trend', horizon: '10m', signals: [{ ref: 'SG-B-LVL-NR', role: 'primary' }, { ref: 'SG-A-LVL-NR', role: 'context' }] }
    const twoMeasurements = { kind: 'trend', horizon: '10m', signals: [{ ref: 'SG-B-LVL-NR', role: 'primary' }, { ref: 'SG-B-PRESS', role: 'context' }] }
    const withAlarms = ask('world.process-plant.display.compose', display([mimic, oneMeasurement, { kind: 'alarms', scope: 'related' }])) as { view: { height: number } }
    expect(withAlarms.view.height).toBeLessThanOrEqual(640)
    const twoStrips = ask('world.process-plant.display.compose', display([mimic, twoMeasurements])) as { view: { height: number } }
    expect(twoStrips.view.height).toBeLessThanOrEqual(640)
    expect(rejection(display([mimic, twoMeasurements, { kind: 'alarms', scope: 'related' }]))).toContain('without panels.2 (alarms)')
  })

  test('relate the alarms panel to the drawn equipment, and allow one mimic', () => {
    const result = ask('world.process-plant.display.view', {
      plantId: system.plant.id,
      state: JSON.stringify({
        composition: display([{ kind: 'mimic', view: 'feed-to-sg', loops: ['B'] }, { kind: 'alarms', scope: 'related' }]),
        issuedAt: '2026-10-09T10:00:00.000Z',
        modelDigest: system.plant.modelDigest,
      }),
    }) as { display: { panels: ReadonlyArray<{ kind: string; ruleIds?: ReadonlyArray<string> }> } }
    expect(result.display.panels[1]!.ruleIds).toEqual(expect.arrayContaining(['sg-b-level-low']))
    expect(rejection(display([{ kind: 'mimic', view: 'feed-to-sg' }, { kind: 'mimic', view: 'feed-to-sg', loops: ['A'] }]))).toContain('use at most one mimic panel')
  })

  test('sample every live value a six-loop mimic draws in one call', () => {
    const six = plantWithLoops(6)
    const mimic = compiled(six)
    const sample = answerProcessPlantQuery({
      request: { capabilityId: 'world.process-plant.display.sample', input: { plantId: six.plant.id, paths: mimic.paths } },
      plants: new Map([[six.plant.id, six]]),
      objects: new Map(),
      simulationTime: '2026-10-09T10:00:00.000Z' as IsoTimestamp,
      recordedSeriesIds: new Set(),
    }) as { values: ReadonlyArray<unknown> }
    expect(sample.values).toHaveLength(mimic.paths.length)
  })
})
