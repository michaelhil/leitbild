import { describe, expect, test } from 'bun:test'
import { compileProcessPlant, createProcessPlantRuntime, createPwrReferencePlantDefinition, type VariablePath } from '../src/packs/process-plant/index.ts'
import { componentVariablePath, createBehaviorContext } from '../src/packs/process-plant/runtime/behavior-contract.ts'
import { reactorBehaviorDefinitions } from '../src/packs/process-plant/runtime/behaviors/reactor-behaviors.ts'
import { initialComponentValueFor } from '../src/packs/process-plant/runtime/component-initial-values.ts'
import { createProcessPlantVariableTable } from '../src/packs/process-plant/runtime/variable-table.ts'

const system = compileProcessPlant(createPwrReferencePlantDefinition({ id: 'plant:shutdown-inventory', loopCount: 4 }))
const vessel = system.graph.components.find(component => component.kind === 'reactorVessel')!
const behavior = reactorBehaviorDefinitions.find(row => row.id === 'reactor-vessel-primary-inventory-state')!
const path = (value: string): VariablePath => value as VariablePath
const fixture = () => {
  const runtime = createProcessPlantRuntime({ system })
  const table = createProcessPlantVariableTable(system, initialComponentValueFor, runtime.checkpoint().values)
  for (const link of system.graph.links) for (const name of ['flowKgPerS', 'leakFlowKgPerS']) {
    const key = path(`${link.id}.${name}`)
    if (table.has(key)) table.write(key, 0)
  }
  for (const id of ['A', 'B', 'C', 'D']) table.write(path(`sg${id}.primaryToSecondaryLeakKgPerS`), 0)
  table.write(path('core.vapourGenerationKgPerS'), 0)
  table.write(path('pressurizer.sprayFlowKgPerS'), 0)
  const boron = table.readNumber(path('vessel.boronConcentrationPpm'))
  for (const train of ['a', 'b']) table.write(path(`rhr-injection-valve-${train}-to-cold-leg-${train}.soluteConcentrationPpm`), boron)
  const context = createBehaviorContext({ behaviorId: behavior.id, phase: behavior.phase, dtSeconds: .1, table,
    writablePaths: new Set(behavior.writes.map(local => componentVariablePath(vessel, local))) })
  return { table, context, boron }
}

describe('shutdown cooling crosses the RCS material boundary twice', () => {
  for (const [drawn, returned] of [[100, 100], [100, 0], [0, 100]] as const) test(`${drawn} kg/s withdrawal and ${returned} kg/s return retain their actual net effect`, () => {
    const { table, context, boron } = fixture()
    for (const train of ['a', 'b']) {
      table.write(path(`rcs-to-rhr-shutdown-suction-${train}.flowKgPerS`), drawn / 2)
      table.write(path(`rhr-injection-valve-${train}-to-cold-leg-${train}.flowKgPerS`), returned / 2)
    }
    const inventory = table.readNumber(path('vessel.primaryCoolantInventoryKg'))
    behavior.update({ system, component: vessel, context })
    expect(table.readNumber(path('vessel.shutdownCoolingWithdrawalFlowKgPerS'))).toBe(drawn)
    expect(table.readNumber(path('vessel.netInventoryFlowKgPerS'))).toBe(returned - drawn)
    const surge = table.readNumber(path('vessel.surgeFlowKgPerS'))
    expect(table.readNumber(path('vessel.primaryCoolantInventoryKg')) - inventory + surge * .1).toBeCloseTo((returned - drawn) * .1, 7)
    expect(table.readNumber(path('vessel.primaryInventoryBalanceResidualKg'))).toBeCloseTo(0, 7)
    expect(table.readNumber(path('vessel.boronConcentrationPpm'))).toBeCloseTo(boron, 10)
  })
})
