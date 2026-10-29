import { describe, expect, test } from 'bun:test'
import { compileProcessPlant, compileResolvedProcessPlant, createProcessPlantProtectionRunner, createProcessPlantRuntime, createPwrReferencePlantDefinition, type VariablePath } from '../src/packs/process-plant/index.ts'
import { valvePositionController, operatorControllerBindings } from '../src/packs/process-plant/graph/valve-controller.ts'
import { guardPlantTests } from './plant-hang-guard.ts'

guardPlantTests()
const plant = compileProcessPlant(createPwrReferencePlantDefinition({ id: 'plant:valve-control', loopCount: 4 }))
const started = () => {
  const runtime = createProcessPlantRuntime({ system: plant })
  const read = (path: string) => runtime.readVariable(path as VariablePath)
  const set = (path: string, value: number | boolean) => runtime.writeCommand({ type: 'setVariable', path: path as VariablePath, value })
  const run = (seconds: number) => { for (let i = 0; i < seconds; i++) runtime.tick(1_000) }
  return { runtime, read, set, run }
}

describe('operator authority on the existing proportional valve controller', () => {
  test('only opted-in controllers contribute native typed mode/target variables across 2, 4 and 6 loops', () => {
    for (const loopCount of [2, 4, 6]) {
      const system = compileProcessPlant(createPwrReferencePlantDefinition({ id: 'plant:controller-shape', loopCount }))
      const controlled = system.graph.components.filter(component => operatorControllerBindings(component) !== null)
      expect(controlled).toHaveLength(2 * loopCount + 1)
      for (const component of controlled) {
        const config = valvePositionController(component)!
        const paths = operatorControllerBindings(component)!
        expect(system.graph.variables.find(variable => variable.path === paths.automatic)?.descriptor).toMatchObject({ writable: true, quantity: 'boolean', unit: 'boolean' })
        expect(system.graph.variables.find(variable => variable.path === paths.setpoint)?.descriptor).toMatchObject({ writable: true, quantity: config.operator!.setpoint.quantity, unit: config.operator!.setpoint.unit })
      }
      const manual = system.graph.components.find(component => String(component.id) === 'auxFeedwaterValveA')!
      expect(operatorControllerBindings(manual)).toBeNull()
      expect(manual.variables.some(variable => String(variable.path).includes('controller'))).toBe(false)
    }
  })

  test('initial AUTO and setpoints retain the authored current operating behavior', () => {
    const { read, run } = started()
    expect(read('turbineBypassValve.controllerAutomatic')).toBe(true)
    expect(read('turbineBypassValve.controllerSetpoint')).toBe(7.6)
    expect(read('steamGeneratorReliefValveA.controllerSetpoint')).toBe(7.86)
    expect(read('feedwaterControlValveA.controllerSetpoint')).toBe(55)
    run(10)
    expect(read('turbineBypassValve.effectivePositionFraction')).toBeLessThan(0.01)
    expect(read('steamGeneratorReliefValveA.effectivePositionFraction')).toBeLessThan(0.01)
    expect(Number(read('sgA.levelPercent'))).toBeGreaterThan(54)
    expect(Number(read('sgA.levelPercent'))).toBeLessThan(56)
  })

  test('MAN preserves a demand and physical actuator travel; AUTO resumes from it using the new target', () => {
    const { read, set, run } = started()
    set('turbineBypassValve.controllerAutomatic', false)
    set('turbineBypassValve.positionFraction', 0.2)
    run(10)
    expect(read('turbineBypassValve.positionFraction')).toBe(0.2)
    expect(Number(read('turbineBypassValve.effectivePositionFraction'))).toBeGreaterThan(0.15)
    set('turbineBypassValve.controllerSetpoint', 6)
    run(1)
    expect(read('turbineBypassValve.positionFraction')).toBe(0.2)
    set('turbineBypassValve.controllerAutomatic', true)
    run(5)
    expect(Number(read('turbineBypassValve.positionFraction'))).toBeGreaterThan(0.5)
    expect(Number(read('turbineBypassValve.effectivePositionFraction'))).toBeGreaterThan(0.3)
    expect(Number(read('turbineBypassValve.outletFlowKgPerS'))).toBeGreaterThan(0)
  })

  test('a blocked condenser permissive closes the bypass in MAN despite repeated open demands', () => {
    const { read, set, run } = started()
    set('circulatingWaterPump.running', false)
    // Await the actual cooling-water coastdown and actuator's declared closing travel.
    run(60)
    expect(Number(read('condenser.coolingWaterFlowKgPerS'))).toBeLessThan(7_000)
    set('turbineBypassValve.controllerAutomatic', false)
    for (let i = 0; i < 30; i++) { set('turbineBypassValve.positionFraction', 1); run(1) }
    expect(Number(read('condenser.coolingWaterFlowKgPerS'))).toBeLessThan(7_000)
    expect(read('turbineBypassValve.positionFraction')).toBe(0)
    expect(Number(read('turbineBypassValve.effectivePositionFraction'))).toBeLessThan(0.01)
  })

  test('standing SI protection keeps feedwater isolated through repeated AUTO/MAN and target changes', () => {
    const { runtime, read, set, run } = started()
    const protection = createProcessPlantProtectionRunner({ system: plant, protection: plant.automation })
    set('manualSafetyInjection.pushbutton', true)
    for (let i = 0; i < 20; i++) {
      set('feedwaterControlValveA.controllerAutomatic', i % 2 === 0)
      set('feedwaterControlValveA.controllerSetpoint', 100)
      set('feedwaterControlValveA.positionFraction', 1)
      run(1)
      protection.evaluate({ runtime, elapsedMs: runtime.elapsedMs(), simulationRunId: 'run-controller-proof' as never, sourceRuntimeId: 'process-plant.local' })
    }
    expect(read('feedwaterControlValveA.isolationSignal')).toBe(true)
    expect(read('feedwaterControlValveA.positionFraction')).toBe(0)
    expect(Number(read('feedwaterControlValveA.effectivePositionFraction'))).toBeLessThan(0.01)
  })

  test('native physical domains reject invalid targets while no arbitrary pressure ceiling is introduced', () => {
    const { set } = started()
    for (const value of [-1, NaN, Infinity]) expect(() => set('turbineBypassValve.controllerSetpoint', value)).toThrow()
    for (const value of [-1, 101]) expect(() => set('feedwaterControlValveA.controllerSetpoint', value)).toThrow()
    expect(() => set('turbineBypassValve.controllerSetpoint', 20)).not.toThrow()
    expect(() => set('turbineBypassValve.controllerAutomatic', 1)).toThrow('boolean')
  })

  test('the controller declaration rejects mismatched native units and out-of-span initial settings', () => {
    const changed = (change: (controller: any) => any) => compileResolvedProcessPlant({
      id: 'plant:bad-controller', modelRef: 'test.controller', operatingPointRef: 'test.point', automationRef: 'test.automation',
      graph: { ...plant.sourceGraph, components: plant.sourceGraph.components.map(component => String(component.id) !== 'feedwaterControlValveA' ? component : {
        ...component, parameters: { ...(component.parameters as any), controller: change((component.parameters as any).controller) },
      }) },
      automationForGraph: () => ({ operatingModes: [], annunciatorSystems: [], firstOutGroups: [], safetyFunctions: [], rules: [] }),
    })
    expect(() => changed(controller => ({ ...controller, operator: { ...controller.operator, setpoint: { quantity: 'pressure', unit: 'MPa', step: 0.1 } } }))).toThrow('must match measuredPath')
    expect(() => changed(controller => ({ ...controller, setpoint: 101 }))).toThrow('outside its authored limits')
  })

  test('an exact new checkpoint retains its real operator selections', () => {
    const { runtime, set, run } = started()
    set('turbineBypassValve.controllerAutomatic', false)
    set('turbineBypassValve.controllerSetpoint', 7.4)
    run(1)
    const restored = createProcessPlantRuntime({ system: plant, restoredCheckpoint: runtime.checkpoint() })
    expect(restored.readVariable('turbineBypassValve.controllerAutomatic' as VariablePath)).toBe(false)
    expect(restored.readVariable('turbineBypassValve.controllerSetpoint' as VariablePath)).toBe(7.4)
  })
})
