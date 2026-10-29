import { describe, expect, test } from 'bun:test'
import { compileProcessPlant, compileResolvedProcessPlant, createProcessPlantProtectionRunner, createProcessPlantRuntime, createPwrReferencePlantDefinition, type VariablePath } from '../src/packs/process-plant/index.ts'
import { valvePositionController, operatorControllerBindings } from '../src/packs/process-plant/graph/valve-controller.ts'
import { validateOperatorWrite } from '../src/packs/process-plant/operations/command-guard.ts'
import { createProcessPlantRuntimeInstances } from '../src/packs/process-plant/sim/runtime-instance-factory.ts'
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

  test('the shared operator guard refuses manual position in AUTO and permits real MAN authority', () => {
    const { runtime, set, run } = started()
    const path = 'feedwaterControlValveA.positionFraction' as VariablePath
    const validate = (origin: 'person' | 'ai' | 'system' | undefined) => validateOperatorWrite({
      system: plant, runtime, payload: { plantId: plant.id, path, value: 0.4 }, origin,
    })
    for (const origin of ['person', 'ai', undefined] as const) expect(validate(origin)).toMatchObject({ accepted: false, reason: expect.stringContaining('select MAN') })
    // System/instructor setup has its existing separate authority, as I&C and solver writes do.
    expect(validate('system').accepted).toBe(true)
    set('feedwaterControlValveA.controllerAutomatic', false)
    run(1)
    expect(validate('person').accepted).toBe(true)
    expect(validate('ai').accepted).toBe(true)
    set('feedwaterControlValveA.controllerAutomatic', true)
    run(1)
    expect(validate('person').accepted).toBe(false)
    expect(validateOperatorWrite({ system: plant, runtime, payload: { plantId: plant.id, path: 'auxFeedwaterValveA.positionFraction' as VariablePath, value: 0.4 }, origin: 'person' }).accepted).toBe(true)
  })

  test('AUTO takes an active manual ramp permanently, including queued and restored ownership changes', () => {
    const instance = () => createProcessPlantRuntimeInstances({ compiledPlants: [plant], runtimeState: null }).get(plant.id)!
    const path = 'feedwaterControlValveA.positionFraction' as VariablePath
    const mode = 'feedwaterControlValveA.controllerAutomatic' as VariablePath
    const run = instance()
    run.runtime.writeCommand({ type: 'setVariable', path: mode, value: false })
    run.runtime.tick(1_000)
    run.ramps.start({ id: 'ramp:manual', path, target: 0, durationMs: 60_000 })
    run.ramps.apply(1_000)
    expect(run.ramps.snapshot().active).toHaveLength(1)
    // A mode request is queued until the solver step. A final old-MAN application can enter the same batch;
    // the AUTO controller must own the actual step, and the next ramp application must end that program.
    run.runtime.writeCommand({ type: 'setVariable', path: mode, value: true })
    const ramp = run.ramps.snapshot().active[0]!
    const queuedManualDemand = ramp.from + (ramp.target - ramp.from) * ((2_000 - ramp.startedAtMs) / ramp.durationMs)
    run.ramps.apply(2_000)
    run.runtime.tick(1_000)
    expect(run.runtime.readVariable(mode)).toBe(true)
    expect(Number(run.runtime.readVariable(path))).not.toBeCloseTo(queuedManualDemand, 6)
    expect(Number(run.runtime.readVariable('feedwaterControlValveA.effectivePositionFraction' as VariablePath))).toBeGreaterThan(0)
    run.ramps.apply(3_000)
    expect(run.ramps.snapshot().active).toEqual([])
    run.runtime.writeCommand({ type: 'setVariable', path: mode, value: false })
    run.runtime.tick(1_000)
    const demand = run.runtime.readVariable(path)
    run.ramps.apply(60_000)
    expect(run.runtime.readVariable(path)).toBe(demand)

    const restored = createProcessPlantRuntimeInstances({ compiledPlants: [plant], runtimeState: {
      schemaVersion: 1,
      plants: [{ plantId: plant.id, runtime: instance().runtime.checkpoint(), ramps: { active: [{ id: 'ramp:restored', path, from: 0.6, target: 0, startedAtMs: 0, durationMs: 60_000 }] } }],
    } }).get(plant.id)!
    expect(restored.runtime.readVariable(mode)).toBe(true)
    restored.ramps.apply(1_000)
    expect(restored.ramps.snapshot().active).toEqual([])
  })

  test('an actual isolation or lost condenser permissive ends a MAN ramp rather than resuming it later', () => {
    for (const blockedBy of ['isolation', 'condenser'] as const) {
      const instance = createProcessPlantRuntimeInstances({ compiledPlants: [plant], runtimeState: null }).get(plant.id)!
      const path = 'turbineBypassValve.positionFraction' as VariablePath
      const set = (path: string, value: boolean | number) => instance.runtime.writeCommand({ type: 'setVariable', path: path as VariablePath, value })
      set('turbineBypassValve.controllerAutomatic', false)
      instance.runtime.tick(1_000)
      instance.ramps.start({ id: `ramp:${blockedBy}`, path, target: 1, durationMs: 120_000 })
      if (blockedBy === 'isolation') {
        set('turbineBypassValve.isolationSignal', true)
        instance.runtime.tick(1_000)
      } else {
        set('circulatingWaterPump.running', false)
        instance.runtime.tick(60_000)
        expect(Number(instance.runtime.readVariable('condenser.coolingWaterFlowKgPerS' as VariablePath))).toBeLessThan(7_000)
      }
      const validation = validateOperatorWrite({ system: plant, runtime: instance.runtime, payload: { plantId: plant.id, path, value: 1 }, origin: 'person' })
      expect(validation).toMatchObject({ accepted: false, reason: expect.stringContaining(blockedBy === 'isolation' ? 'isolation' : 'coolingWaterFlowKgPerS') })
      instance.ramps.apply(instance.runtime.elapsedMs() + 1_000)
      expect(instance.ramps.snapshot().active).toEqual([])
      set('turbineBypassValve.isolationSignal', false)
      set('circulatingWaterPump.running', true)
      instance.runtime.tick(60_000)
      instance.ramps.apply(instance.runtime.elapsedMs() + 1_000)
      instance.runtime.tick(1_000)
      expect(instance.runtime.readVariable(path)).toBe(0)
    }
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
