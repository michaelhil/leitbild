import { describe, expect, test } from 'bun:test'
import { compileProcessPlant, compileResolvedProcessPlant, createProcessPlantRuntime, createPwrReferencePlantDefinition } from '../src/packs/process-plant/index.ts'
import type { ProcessPlantIcStatusTreeNode, ProcessPlantRuntime } from '../src/packs/process-plant/runtime/index.ts'
import { processPlantAutomationDigest } from '../src/packs/process-plant/evidence-frame.ts'
import { evaluateSafetyFunction } from '../src/packs/process-plant/safety-functions.ts'

const plant = compileProcessPlant(createPwrReferencePlantDefinition({ id: 'plant:pressure-screen-guidance', loopCount: 4 }))
const heatSink = plant.automation.safetyFunctions.find(row => row.id === 'heat-sink')!
const initial = createProcessPlantRuntime({ system: plant })

// Controlled readings test the declared screen and guidance, not pressure
// dynamics or receiving-procedure qualification. The actual four-unit trip
// acquisition is a separate native World experiment.
const assess = (pressure: number, overrides: Readonly<Record<string, number>> = {}) => {
  const values = { 'sgA.pressureMPa': pressure, ...overrides }
  const runtime: ProcessPlantRuntime = { ...initial, readVariableSnapshot: path => {
    const value = values[String(path) as keyof typeof values]
    const snapshot = initial.readVariableSnapshot(path)
    return value === undefined ? snapshot : { ...snapshot, value }
  } }
  return evaluateSafetyFunction({ system: plant, runtime, safetyFunction: heatSink })
}

describe('current high-pressure heat-sink guidance', () => {
  test('the unchanged 8.1 to below 8.27 MPa yellow screen asks E-0 for achieved release and fresh response', () => {
    for (const pressure of [8.1, 8.156840805586837, 8.269]) {
      const result = assess(pressure)
      expect(result).toMatchObject({ status: 'yellow', procedure: 'E-0' })
      expect(result.meaning).toContain('8.1 MPa high-pressure screen')
      expect(result.meaning).toContain('achieved steam release')
      expect(result.meaning).toContain('fresh pressure response')
      expect(result.meaning).toContain('does not diagnose condenser loss or persistent heat-sink failure')
      expect(result.path.at(-1)?.comparisons[0]).toMatchObject({ operator: '<', threshold: 8.1, answer: 'no' })
    }
  })

  test('normal, safety-pressure and level-priority boundaries keep their declared statuses and destinations', () => {
    expect(assess(8.099)).toMatchObject({ status: 'green' })
    expect(assess(8.27)).toMatchObject({ status: 'orange', procedure: 'FR-H.2' })
    expect(assess(8.3)).toMatchObject({ status: 'orange', procedure: 'FR-H.2' })
    expect(assess(8.15, { 'sgA.levelPercent': 82 })).toMatchObject({ status: 'yellow', procedure: 'FR-H.3' })
    expect(assess(7.5, { 'sgA.levelPercent': 9 })).toMatchObject({ status: 'yellow', procedure: 'FR-H.5' })
    const dryAndUnfed = Object.fromEntries(['A', 'B', 'C', 'D'].flatMap(loop => [[`sg${loop}.levelPercent`, 9], [`sg${loop}.feedwaterFlowKgPerS`, 0]]))
    expect(assess(7.5, dryAndUnfed)).toMatchObject({ status: 'red', procedure: 'FR-H.1' })
  })

  test('the complete immutable automation identity changes honestly while its graph/model and control rules do not', () => {
    let restoredLeaves = 0
    const priorGuidance = (node: ProcessPlantIcStatusTreeNode): ProcessPlantIcStatusTreeNode => {
      if ('status' in node) {
        if (node.procedure !== 'E-0' || !node.meaning.includes('high-pressure screen')) return node
        restoredLeaves++
        return { ...node, procedure: 'FR-H.4', meaning: 'A steam generator is above its relief valves\' pressure: normal steam release is not holding it.' }
      }
      return { ...node, yes: priorGuidance(node.yes), no: priorGuidance(node.no) }
    }
    const priorAutomation = { ...plant.automation, safetyFunctions: plant.automation.safetyFunctions.map(row => row.id === 'heat-sink' ? { ...row, tree: priorGuidance(row.tree) } : row) }
    expect(restoredLeaves).toBeGreaterThan(0)
    // Reconstruct the actual prior definition, including every predicate and
    // control rule, rather than excluding guidance from the evidence hash.
    expect(processPlantAutomationDigest(priorAutomation)).toBe('51ba771b09e0ebad4282fd98b4f06968fde83b19f2907bfadc96835ad9b0c0fa')
    expect(processPlantAutomationDigest(plant.automation)).not.toBe(processPlantAutomationDigest(priorAutomation))
    const prior = compileResolvedProcessPlant({ id: plant.id, modelRef: plant.modelRef, operatingPointRef: plant.operatingPointRef,
      automationRef: plant.automationRef, graph: plant.sourceGraph, automationForGraph: () => priorAutomation })
    expect(prior.modelDigest).toBe(plant.modelDigest)
    expect(prior.sourceGraph).toEqual(plant.sourceGraph)
    expect(prior.automation.rules).toEqual(plant.automation.rules)
  })
})
