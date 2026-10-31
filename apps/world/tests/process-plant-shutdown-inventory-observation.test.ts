import { describe, expect, test } from 'bun:test'
import { compileProcessPlant, createProcessPlantRuntime, createPwrReferencePlantDefinition, type VariablePath } from '../src/packs/process-plant/index.ts'
import { componentVariablePath, createBehaviorContext } from '../src/packs/process-plant/runtime/behavior-contract.ts'
import { instrumentationBehaviorDefinitions } from '../src/packs/process-plant/runtime/behaviors/instrumentation-behaviors.ts'
import { initialComponentValueFor } from '../src/packs/process-plant/runtime/component-initial-values.ts'
import { createProcessPlantVariableTable } from '../src/packs/process-plant/runtime/variable-table.ts'

const system = compileProcessPlant(createPwrReferencePlantDefinition({ id: 'plant:shutdown-balance-observer', loopCount: 4 }))
const balance = system.graph.components.find(component => component.kind === 'rcsInventoryBalance')!
const behavior = instrumentationBehaviorDefinitions.find(row => row.id === 'rcs-inventory-balance')!
const path = (value: string): VariablePath => value as VariablePath

// Isolated observer frames deliberately prescribe known mass changes. The
// actual material solver is exercised separately by shutdown-inventory tests;
// these cases prove which identified boundary flows the observer accounts for.
const observed = (args: { withdrawn: number; returned: number; charging?: number; injection?: number; letdown?: number; relief?: number; externalLoss?: number }) => {
  const runtime = createProcessPlantRuntime({ system })
  const table = createProcessPlantVariableTable(system, initialComponentValueFor, runtime.checkpoint().values)
  const dt = .1
  const charging = args.charging ?? 0, injection = args.injection ?? 0, letdown = args.letdown ?? 0, relief = args.relief ?? 0
  const inventory = table.readNumber(path('vessel.primaryCoolantInventoryKg'))
    + table.readNumber(path('pressurizer.waterInventoryKg')) + table.readNumber(path('pressurizer.steamMassKg'))
  const actualNetFlow = charging + injection + args.returned - letdown - args.withdrawn - relief - (args.externalLoss ?? 0)
  table.write(path('vessel.chargingFlowKgPerS'), charging)
  table.write(path('vessel.safetyInjectionFlowKgPerS'), injection + args.returned)
  table.write(path('vessel.letdownFlowKgPerS'), letdown)
  table.write(path('vessel.shutdownCoolingWithdrawalFlowKgPerS'), args.withdrawn)
  table.write(path('pressurizer.reliefFlowKgPerS'), relief)
  table.write(path('pressurizer.safetyValveFlowKgPerS'), 0)
  table.write(path('rcsInventoryBalance.balancedInventoryKg'), inventory - actualNetFlow * dt)
  table.write(path('rcsInventoryBalance.leakRateKgPerS'), 0)
  const context = createBehaviorContext({ behaviorId: behavior.id, phase: behavior.phase, dtSeconds: dt, table,
    writablePaths: new Set(behavior.writes.map(local => componentVariablePath(balance, local))) })
  behavior.update({ system, component: balance, context })
  return { table, dt, inventory }
}

describe('RCS inventory observer includes achieved shutdown withdrawal', () => {
  test('the read dependency includes actual withdrawal, not valve demand or a closed-loop mode flag', () => {
    expect(behavior.reads).toContain('vessel.shutdownCoolingWithdrawalFlowKgPerS')
  })

  for (const [withdrawn, returned] of [[520, 520], [100, 0], [0, 100]] as const) {
    test(`identified ${withdrawn} kg/s withdrawal and ${returned} kg/s return have no unexplained loss`, () => {
      const { table, inventory } = observed({ withdrawn, returned })
      expect(table.readNumber(path('rcsInventoryBalance.leakRateKgPerS'))).toBeCloseTo(0, 8)
      expect(table.readNumber(path('rcsInventoryBalance.balancedInventoryKg'))).toBe(inventory)
    })
  }

  test('ordinary external makeup, identified relief and letdown retain their independent balance', () => {
    const { table } = observed({ withdrawn: 520, returned: 520, charging: 3, injection: 5, letdown: 2, relief: .3 })
    expect(table.readNumber(path('rcsInventoryBalance.leakRateKgPerS'))).toBeCloseTo(0, 8)
  })

  test('an additional external loss remains detectable during matched closed RHR flow', () => {
    const { table, dt } = observed({ withdrawn: 520, returned: 520, externalLoss: 2 })
    const timeConstant = Number((balance.parameters as { averagingTimeConstantS: number }).averagingTimeConstantS)
    // The existing observer filter is unchanged: one finite sample starts
    // approaching the actual unexplained loss rather than suppressing it.
    expect(table.readNumber(path('rcsInventoryBalance.leakRateKgPerS'))).toBeCloseTo(2 * dt / timeConstant, 8)
    expect(table.readNumber(path('rcsInventoryBalance.leakRateKgPerS'))).toBeGreaterThan(0)
  })
})
