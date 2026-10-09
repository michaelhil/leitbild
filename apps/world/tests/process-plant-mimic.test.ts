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
import { compileMimic, type MimicBudget } from '../src/packs/process-plant/displays/mimic/compile-mimic.ts'
import { MIMIC_MAX_WIDTH, type CompiledMimic } from '../src/packs/process-plant/displays/mimic/mimic-model.ts'
import type { MimicIntent } from '../src/packs/process-plant/displays/mimic/scope.ts'

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

// The room a mimic-led display leaves beside alarms: 800 px wide, about 620 px tall.
const roomy: MimicBudget = { maxWidth: MIMIC_MAX_WIDTH, maxHeight: 624 }

const generated = (system: ProcessPlantRuntimeInstance, intent: MimicIntent, budget = roomy): CompiledMimic => {
  const result = compileMimic(system.plant, intent, budget)
  if (!result.ok) throw new Error(result.issues.map(issue => issue.message).join('; '))
  return result.mimic
}

// Situations no hand-drawn view ever covered: the drawing comes from the graph.
const situations: ReadonlyArray<[string, MimicIntent]> = [
  ['is the diesel feeding the AFW motor pump', { from: ['dieselGeneratorA'], to: ['auxFeedwaterPumpMotor'] }],
  ['what supplies safety bus A', { to: ['safetyBusA'] }],
  ['the SI lineup to loop C', { services: ['safetyInjection'], loops: ['C'] }],
  ['where letdown goes', { from: ['letdownValve'], services: ['letdown', 'charging'] }],
  ['the pressurizer relief path', { from: ['pressurizer'], to: ['PRT'] }],
  ['all four reactor coolant loops', { services: ['primaryCoolant'] }],
  ['main and auxiliary feed to SG B', { to: ['sgB'], services: ['feedwater', 'auxFeedwater'] }],
  ['auxiliary feedwater to every SG', { services: ['auxFeedwater'] }],
]

describe('generated equipment mimics', () => {
  const system = plantWithLoops(4)

  for (const [question, intent] of situations) {
    test(`draws ${question} from the Plant graph, within the box, verified`, () => {
      const mimic = generated(system, intent)
      expect(mimic.width).toBeLessThanOrEqual(roomy.maxWidth)
      expect(mimic.height).toBeLessThanOrEqual(roomy.maxHeight)
      expect(mimic.items.length).toBeGreaterThan(1)
      // Every drawn pipe is orthogonal.
      for (const pipe of mimic.pipes) {
        pipe.points.slice(1).forEach(([x, y], at) => {
          const [px, py] = pipe.points[at]!
          expect(px === x || py === y).toBe(true)
        })
      }
    })
  }

  test('never draws a command, a fault knob or a diagnostic as equipment state', () => {
    const graph = system.plant.graph
    for (const [, intent] of situations) {
      for (const item of generated(system, intent).items) {
        const state = item.binding.state
        for (const path of [state?.state?.path, state?.throughput?.path].filter(path => path !== undefined)) {
          const binding = graph.signalBindingByPath.get(path!)!
          expect(!binding.writable || binding.actuation === 'boundary').toBe(true)
        }
        if (state?.command !== undefined) expect(graph.signalBindingByPath.get(state.command)!.actuation).toBe('command')
      }
    }
  })

  test('the PORV the model bundles in the pressurizer is drawn on the relief line, judged by its flow', () => {
    const mimic = generated(system, { from: ['pressurizer'], to: ['PRT'] })
    expect(mimic.items.map(item => item.binding.label).sort()).toEqual(['PORV', 'PRT', 'PZR'])
    const porv = mimic.items.find(item => item.binding.label === 'PORV')!
    expect(porv.presentation).toEqual({ element: 'device', icon: 'valve-digital', aspect: 'position' })
    expect(porv.rows.map(row => row.kind)).toEqual(['state', 'throughput', 'mismatch'])
    expect(mimic.summary.unmeasuredStates).toEqual(['PORV'])
  })

  test('the same intent on the same model draws the same mimic', () => {
    const intent = { to: ['safetyBusA'] }
    expect(generated(system, intent).hash).toBe(generated(system, intent).hash)
    expect(JSON.stringify(generated(system, intent))).toBe(JSON.stringify(generated(system, intent)))
  })

  test('a scope too large to read at a glance is refused with narrower intents that fit', () => {
    const result = compileMimic(system.plant, { services: ['primaryInjection'] }, { maxWidth: 600, maxHeight: 400 })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.issues[0]!.message).toMatch(/it fits with "loops":\["A"/)
  })

  test('names that do not resolve come back with suggestions', () => {
    const result = compileMimic(system.plant, { to: ['SG-B'], services: ['feedwater'] }, roomy)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.issues[0]!.didYouMean![0]).toStartWith('sgB (Steam Generator B, SG B)')
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
    title: 'Safety bus A supply',
    question: 'What supplies safety bus A now?',
    need: 'Decide whether to start the diesel',
    panels,
  })

  test('compose a mimic alone and say what it draws and where it stops', () => {
    const result = ask('world.process-plant.display.compose', display([{ kind: 'mimic', to: ['safetyBusA'] }])) as { shows: ReadonlyArray<string>; view: { height: number } }
    expect(result.shows[0]).toStartWith('Live equipment mimic generated from the Plant model (electricalPower)')
    expect(result.shows[0]).toContain('Bus A (safetyBusA)')
    expect(result.shows[1]).toStartWith('The drawing stops at:')
    expect(result.view.height).toBeLessThanOrEqual(900)
  })

  test('a mimic leads its display: with a trend and alarms the display may take up to 900 px', () => {
    const trend = { kind: 'trend', horizon: '10m', signals: [{ ref: 'SG-B-LVL-NR', role: 'primary' }] }
    const result = ask('world.process-plant.display.compose', display([{ kind: 'mimic', to: ['safetyBusA'] }, trend, { kind: 'alarms', scope: 'related' }])) as { view: { height: number } }
    expect(result.view.height).toBeGreaterThan(660)
    expect(result.view.height).toBeLessThanOrEqual(900)
  })

  test('a stored display re-opens with its drawing, and relates its alarms to the drawn equipment', () => {
    const composed = ask('world.process-plant.display.compose', display([{ kind: 'mimic', from: ['pressurizer'], to: ['PRT'] }, { kind: 'alarms', scope: 'related' }])) as { view: { state: string }; equipment: ReadonlyArray<{ id: string; label: string; state: string }> }
    expect(composed.equipment.map(item => item.label)).toEqual(['PZR', 'PRT', 'PORV'])
    expect(composed.equipment.find(item => item.label === 'PORV')!.state).toBe('position not measured; no flow')
    const result = ask('world.process-plant.display.view', { plantId: system.plant.id, state: composed.view.state }) as {
      drawingChanged: boolean
      display: { panels: ReadonlyArray<{ kind: string; ruleIds?: ReadonlyArray<string> }> }
    }
    expect(result.drawingChanged).toBe(false)
    expect(result.display.panels[1]!.ruleIds).toEqual(expect.arrayContaining(['pzr-relief-flow-high', 'pzr-pressure-low']))
  })

  test('sample every live value a mimic draws in one call', () => {
    const mimic = generated(system, { to: ['safetyBusA'] })
    const sample = answerProcessPlantQuery({
      request: { capabilityId: 'world.process-plant.display.sample', input: { plantId: system.plant.id, paths: mimic.paths } },
      plants,
      objects: new Map(),
      simulationTime: '2026-10-09T10:00:00.000Z' as IsoTimestamp,
      recordedSeriesIds: new Set(),
    }) as { values: ReadonlyArray<unknown> }
    expect(sample.values).toHaveLength(mimic.paths.length)
  })
})
