import { describe, expect, test } from 'bun:test'
import { embeddedViewPublicationSchema } from '@leitbild/contracts'
import type { IsoTimestamp } from '../src/core/model/index.ts'
import {
  answerProcessPlantQuery,
  compileProcessPlant,
  createProcessPlantRampRunner,
  createProcessPlantRuntime,
  createPwrReferencePlantDefinition,
} from '../src/packs/process-plant/index.ts'
import { createProcessPlantRuntimePerformance, type ProcessPlantRuntimeInstance } from '../src/packs/process-plant/runtime-instance.ts'
import { processPlantCapabilities } from '../src/packs/process-plant/capabilities.ts'
import { icThresholdsForSignal } from '../src/packs/process-plant/displays/ic-thresholds.ts'
import { composedDisplayStateSchema } from '../src/packs/process-plant/displays/composition.ts'
import type { VariablePath } from '../src/packs/process-plant/graph/index.ts'

const compiled = compileProcessPlant(createPwrReferencePlantDefinition({ id: 'plant:composed-display', loopCount: 4 }))
const runtime = createProcessPlantRuntime({ system: compiled })
const plant: ProcessPlantRuntimeInstance = {
  plant: compiled,
  runtime,
  ramps: createProcessPlantRampRunner({ runtime }),
  performance: createProcessPlantRuntimePerformance(),
}
const plants = new Map([[compiled.id, plant]])
const simulationTime = '2026-10-08T21:00:00.000Z' as IsoTimestamp
const ask = (capabilityId: string, input: unknown, at: IsoTimestamp | null = simulationTime) => answerProcessPlantQuery({
  request: { capabilityId, input },
  plants,
  objects: new Map(),
  ...(at === null ? {} : { simulationTime: at }),
})

const composition = (signals: ReadonlyArray<{ readonly ref: string; readonly role: string }>, horizon = '10m') => ({
  plantId: compiled.id,
  title: 'SG B level after feed valve failure',
  question: 'Is SG B level recovering after its feed valve failed?',
  need: 'Decide whether to take manual feed control before AFW actuates',
  panels: [{ kind: 'trend', horizon, signals }],
})

const rejectionOf = (run: () => unknown): string => {
  try {
    run()
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  throw new Error('expected the composition to be rejected')
}

describe('I&C thresholds for composed displays', () => {
  test('come from single-comparison rules on the exact signal, with qualified modes kept', () => {
    const pressure = compiled.graph.signalBindingByTagId.get('PT-455' as never)!.path
    const { thresholds } = icThresholdsForSignal(compiled, pressure)
    expect(thresholds.map(threshold => [threshold.value, threshold.kind, threshold.modeLabel ?? null])).toEqual([
      [13.8, 'trip', 'power operation'],
      [14.8, 'alarm', null],
      [15.35, 'control', null],
      [15.65, 'control', null],
      [15.85, 'control', null],
      [16, 'alarm', null],
      [16.18, 'trip', null],
      [16.35, 'trip', 'power operation'],
    ])
  })

  test('list combined-condition rules instead of drawing them', () => {
    const flow = compiled.graph.signalBindingByTagId.get('RCP-A-FLOW' as never)!.path
    const result = icThresholdsForSignal(compiled, flow)
    expect(result.thresholds.map(threshold => threshold.value)).toEqual([2500])
    expect(result.combinedRules.map(rule => rule.ruleId)).toContain('reactor-low-rcp-flow-trip')
  })
})

describe('world.process-plant.display.compose', () => {
  test('returns a view publication, what it shows and the issue time without storing anything', () => {
    const before = runtime.checkpoint()
    const result = ask('world.process-plant.display.compose', composition([
      { ref: 'SG-B-LVL-NR', role: 'primary' },
      { ref: 'SG-A-LVL-NR', role: 'context' },
    ])) as { view: unknown; shows: ReadonlyArray<string>; warnings: ReadonlyArray<string>; issuedAt: string }
    const view = embeddedViewPublicationSchema.parse(result.view)
    expect(view.viewType).toBe('process-plant.display')
    expect(result.issuedAt).toBe(simulationTime)
    const state = composedDisplayStateSchema.parse(JSON.parse(view.state))
    expect(state).toMatchObject({ issuedAt: simulationTime, modelDigest: compiled.modelDigest })
    expect(result.shows.join('\n')).toContain('Steam generator B level low, below 30 percent')
    expect(result.shows.join('\n')).toContain('Steam generator B low-low level, below 20 percent')
    expect(runtime.checkpoint()).toEqual(before)
  })

  test('rejects every issue at once with did-you-mean suggestions and never repairs', () => {
    const message = rejectionOf(() => ask('world.process-plant.display.compose', composition([
      { ref: 'SG-B-LEVEL-NR', role: 'context' },
      { ref: 'PT-455', role: 'context' },
    ])))
    expect(message).toContain('Display composition rejected (2 issues)')
    expect(message).toContain('panels.0.signals.0.ref: unknown signal "SG-B-LEVEL-NR"')
    expect(message).toContain('Did you mean: SG-B-LVL-NR')
    expect(message).toContain('at least one signal with role "primary"')
  })

  test('rejects state signals and mixed units on one axis', () => {
    expect(rejectionOf(() => ask('world.process-plant.display.compose', composition([
      { ref: 'RCP-A-RUN', role: 'primary' },
    ])))).toContain('is a boolean state signal')
    expect(rejectionOf(() => ask('world.process-plant.display.compose', composition([
      { ref: 'PT-455', role: 'primary' },
      { ref: 'PZR-LVL', role: 'context' },
    ])))).toContain('keep signals of one unit in the trend')
  })

  test('rejects fields outside the composition vocabulary', () => {
    expect(rejectionOf(() => ask('world.process-plant.display.compose', composition([{ ref: 'PT-455', role: 'primary' }], '5m')))).toContain('panels.0.horizon')
    expect(rejectionOf(() => ask('world.process-plant.display.compose', {
      ...composition([{ ref: 'PT-455', role: 'primary' }]),
      limits: { low: 14 },
    }))).toContain('limits')
  })

  test('requires the Simulation Run time of the answering runtime', () => {
    expect(rejectionOf(() => ask('world.process-plant.display.compose', composition([{ ref: 'PT-455', role: 'primary' }]), null)))
      .toContain('requires the Simulation Run time')
  })
})

describe('world.process-plant.display.view and sample', () => {
  const composed = ask('world.process-plant.display.compose', composition([
    { ref: 'PT-455', role: 'primary' },
  ], '2m')) as { view: { state: string } }

  test('view recompiles the composed state for rendering', () => {
    const later = '2026-10-08T21:05:00.000Z' as IsoTimestamp
    const view = ask('world.process-plant.display.view', { plantId: compiled.id, state: composed.view.state }, later) as {
      issuedAt: string
      simulationTime: string
      modelChanged: boolean
      display: { panels: ReadonlyArray<{ horizonMs: number; unit: string; pens: ReadonlyArray<{ path: string; seriesId: string; thresholds: ReadonlyArray<unknown> }> }> }
    }
    expect(view).toMatchObject({ issuedAt: simulationTime, simulationTime: later, modelChanged: false })
    expect(view.display.panels[0]).toMatchObject({ horizonMs: 120_000, unit: 'MPa' })
    expect(view.display.panels[0]!.pens[0]!.seriesId).toStartWith('series:')
    expect(view.display.panels[0]!.pens[0]!.thresholds.length).toBe(8)
  })

  test('view refuses unsupported formats and another Plant', () => {
    expect(rejectionOf(() => ask('world.process-plant.display.view', { plantId: compiled.id, state: '{"composition":{}}' }))).toContain('Unsupported display format')
    const foreign = JSON.stringify({ ...JSON.parse(composed.view.state), composition: { ...JSON.parse(composed.view.state).composition, plantId: 'plant:other' } })
    expect(rejectionOf(() => ask('world.process-plant.display.view', { plantId: compiled.id, state: foreign }))).toContain('targets plant:other')
  })

  test('sample reads current values at the Run time and refuses unknown paths', () => {
    const pressure = compiled.graph.signalBindingByTagId.get('PT-455' as never)!.path
    const sample = ask('world.process-plant.display.sample', { plantId: compiled.id, paths: [pressure] }) as {
      simulationTime: string
      values: ReadonlyArray<{ path: string; value: unknown; quality: string }>
    }
    expect(sample.simulationTime).toBe(simulationTime)
    expect(sample.values[0]).toMatchObject({ path: pressure, quality: 'good' })
    expect(typeof sample.values[0]!.value).toBe('number')
    expect(rejectionOf(() => ask('world.process-plant.display.sample', { plantId: compiled.id, paths: ['nowhere.value' as VariablePath] }))).toContain('signal path not found')
  })
})

test('composed display operations are published read-only Capabilities', () => {
  const ids = ['world.process-plant.display.compose', 'world.process-plant.display.view', 'world.process-plant.display.sample']
  for (const id of ids) {
    const capability = processPlantCapabilities.find(candidate => candidate.id === id)
    expect(capability?.kind).toBe('query')
  }
})
