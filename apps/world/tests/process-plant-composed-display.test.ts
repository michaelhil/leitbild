import { describe, expect, test } from 'bun:test'
import { embeddedViewPublicationSchema } from '@leitbild/contracts'
import type { IsoTimestamp } from '../src/core/model/index.ts'
import {
  answerProcessPlantQuery,
  compileProcessPlant,
  createProcessPlantProtectionRunner,
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
  protection: createProcessPlantProtectionRunner({ system: compiled, protection: compiled.automation }),
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
    expect(String(view.viewType)).toBe('process-plant.display')
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
    ])))).toContain('keep one unit per trend')
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

describe('thresholds drawn on composed trends', () => {
  const panelOf = (signals: ReadonlyArray<{ readonly ref: string; readonly role: string }>) => {
    const composed = ask('world.process-plant.display.compose', composition(signals)) as { view: { state: string } }
    const view = ask('world.process-plant.display.view', { plantId: compiled.id, state: composed.view.state }) as {
      display: { panels: ReadonlyArray<{ thresholds: ReadonlyArray<{ value: number; kind: string; signals: ReadonlyArray<string>; label: string }> }> }
    }
    return view.display.panels[0]!
  }

  test('come from primary signals only', () => {
    const panel = panelOf([{ ref: 'SG-B-LVL-NR', role: 'primary' }, { ref: 'SG-A-LVL-NR', role: 'context' }, { ref: 'SG-C-LVL-NR', role: 'context' }])
    expect(panel.thresholds.map(threshold => [threshold.value, threshold.kind, threshold.signals])).toEqual([
      [20, 'trip', ['SG-B-LVL-NR']],
      [30, 'alarm', ['SG-B-LVL-NR']],
    ])
  })

  test('draw one line per shared set point of several primary signals', () => {
    const panel = panelOf([{ ref: 'SG-A-LVL-NR', role: 'primary' }, { ref: 'SG-B-LVL-NR', role: 'primary' }])
    expect(panel.thresholds.map(threshold => [threshold.value, threshold.signals])).toEqual([
      [20, ['SG-A-LVL-NR', 'SG-B-LVL-NR']],
      [30, ['SG-A-LVL-NR', 'SG-B-LVL-NR']],
    ])
    expect(panel.thresholds[1]!.label).toBe('Steam generator A level low · Steam generator B level low')
  })
})

describe('composed display panels', () => {
  const display = (panels: ReadonlyArray<unknown>) => ({ ...composition([]), panels })
  const composeView = (panels: ReadonlyArray<unknown>) => {
    const composed = ask('world.process-plant.display.compose', display(panels)) as { view: { state: string; height: number }; shows: ReadonlyArray<string> }
    const view = ask('world.process-plant.display.view', { plantId: compiled.id, state: composed.view.state }) as { display: { height: number; panels: ReadonlyArray<Record<string, unknown>> } }
    return { composed, view }
  }

  test('stack trends of different units on one time axis and size the card for them', () => {
    const { composed, view } = composeView([
      { kind: 'trend', horizon: '10m', signals: [{ ref: 'SG-B-LVL-NR', role: 'primary' }] },
      { kind: 'trend', horizon: '10m', signals: [{ ref: 'sgB.feedwaterFlowKgPerS', role: 'counter-evidence' }] },
    ])
    expect(view.display.panels.map(panel => [panel.kind, panel.unit])).toEqual([['trend', 'percent'], ['trend', 'kg/s']])
    expect(composed.view.height).toBe(124 + 192 + 6 + 192)
  })

  test('fit two stacked trends with readouts and related alarms in one chat view', () => {
    const { composed } = composeView([
      { kind: 'trend', horizon: '30m', signals: [{ ref: 'SG-B-LVL-NR', role: 'primary' }, { ref: 'SG-A-LVL-NR', role: 'context' }] },
      { kind: 'trend', horizon: '30m', signals: [{ ref: 'sgB.feedwaterFlowKgPerS', role: 'counter-evidence' }] },
      { kind: 'readouts', signals: [{ ref: 'SG-B-PRESS', role: 'context' }, { ref: 'RCP-B-RUN', role: 'context' }, { ref: 'SG-B-N16', role: 'context' }] },
      { kind: 'alarms', scope: 'related' },
    ])
    expect(composed.view.height).toBeLessThanOrEqual(720)
  })

  test('reject stacked trends with different horizons, a lone alarms panel and oversized displays', () => {
    expect(rejectionOf(() => ask('world.process-plant.display.compose', display([
      { kind: 'trend', horizon: '10m', signals: [{ ref: 'PT-455', role: 'primary' }] },
      { kind: 'trend', horizon: '2m', signals: [{ ref: 'PZR-LVL', role: 'context' }] },
    ])))).toContain('same horizon')
    expect(rejectionOf(() => ask('world.process-plant.display.compose', display([{ kind: 'alarms', scope: 'plant' }]))))
      .toContain('an alarms panel accompanies signal panels')
    const six = ['A', 'B', 'C', 'D'].map(loop => ({ ref: `RCP-${loop}-FLOW`, role: 'context' }))
    expect(rejectionOf(() => ask('world.process-plant.display.compose', display([
      { kind: 'trend', horizon: '10m', signals: [{ ref: 'PT-455', role: 'primary' }] },
      { kind: 'trend', horizon: '10m', signals: [{ ref: 'PZR-LVL', role: 'context' }] },
      { kind: 'comparison', signals: six },
      { kind: 'readouts', signals: [...six, { ref: 'TAVG', role: 'context' }, { ref: 'SUB-MARGIN', role: 'context' }] },
    ])))).toContain('chat views allow 720 (panels.0 trend 192 px')
    expect(rejectionOf(() => ask('world.process-plant.display.compose', display([
      { kind: 'trend', horizon: '10m', signals: [{ ref: 'SG-B-LVL-NR', role: 'primary' }] },
      { kind: 'readouts', signals: [{ ref: 'SG-B-LVL-NR', role: 'primary' }] },
    ])))).toContain('"SG-B-LVL-NR" is already shown in panels.0; show each signal in one panel only')
  })

  test('compare parallel loops of one unit with primary thresholds', () => {
    const { view } = composeView([{ kind: 'comparison', signals: ['A', 'B', 'C', 'D'].map(loop => ({ ref: `RCP-${loop}-FLOW`, role: loop === 'B' ? 'primary' : 'context' })) }])
    const panel = view.display.panels[0] as { kind: string; unit: string; pens: unknown[]; thresholds: Array<{ value: number; signals: string[] }> }
    expect([panel.kind, panel.unit, panel.pens.length]).toEqual(['comparison', 'kg/s', 4])
    expect(panel.thresholds.map(threshold => [threshold.value, threshold.signals])).toEqual([[2500, ['RCP-B-FLOW']]])
    expect(rejectionOf(() => ask('world.process-plant.display.compose', display([
      { kind: 'comparison', signals: [{ ref: 'RCP-A-FLOW', role: 'primary' }, { ref: 'PT-455', role: 'context' }] },
    ])))).toContain('keep one unit per comparison')
  })

  test('show on/off states as readouts but never as trends', () => {
    const { view } = composeView([{ kind: 'readouts', signals: [{ ref: 'RCP-A-RUN', role: 'primary' }, { ref: 'PT-455', role: 'context' }] }])
    const panel = view.display.panels[0] as { pens: Array<{ valueKind: string }> }
    expect(panel.pens.map(pen => pen.valueKind)).toEqual(['boolean', 'number'])
    expect(rejectionOf(() => ask('world.process-plant.display.compose', display([
      { kind: 'trend', horizon: '2m', signals: [{ ref: 'RCP-A-RUN', role: 'primary' }] },
    ])))).toContain('use a readouts panel for states')
  })

  test('relate an alarms panel to the I&C rules acting on the displayed signals', () => {
    const { composed, view } = composeView([
      { kind: 'trend', horizon: '10m', signals: [{ ref: 'SG-B-LVL-NR', role: 'primary' }] },
      { kind: 'alarms', scope: 'related' },
    ])
    const alarms = view.display.panels[1] as { kind: string; ruleIds: string[] }
    expect(alarms.ruleIds).toEqual(['sg-b-feedwater-low', 'sg-b-level-low', 'sg-b-level-low-low-afw-actuation'])
    expect(composed.shows.at(-1)).toContain('3 I&C rules acting on the displayed signals')
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
    expect(view).toMatchObject({ plantLabel: null, issuedAt: simulationTime, simulationTime: later, modelChanged: false })
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
    const withAlarms = ask('world.process-plant.display.sample', { plantId: compiled.id, paths: [pressure], alarms: true })
    expect(withAlarms).toMatchObject({ alarms: [], plantElapsedMs: 0 })
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
