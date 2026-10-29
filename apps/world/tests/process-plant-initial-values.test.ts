import { describe, expect, test } from 'bun:test'
import { compileProcessPlant, compileResolvedProcessPlant, createProcessPlantRuntime, createPwrReferencePlantDefinition, type VariablePath } from '../src/packs/process-plant/index.ts'
import { initialComponentValueFor } from '../src/packs/process-plant/runtime/component-behaviors.ts'
import { createProcessPlantVariableTable } from '../src/packs/process-plant/runtime/variable-table.ts'
import { guardPlantTests } from './plant-hang-guard.ts'

guardPlantTests()
const plant = compileProcessPlant(createPwrReferencePlantDefinition({ id: 'plant:initial-values', loopCount: 4 }))
const target = 'turbineBypassValve.controllerSetpoint' as VariablePath

const changedTarget = (setpoint: number) => compileResolvedProcessPlant({
  id: 'plant:changed-initial-target', modelRef: 'test.model', operatingPointRef: 'test.point', automationRef: 'test.automation',
  graph: { ...plant.sourceGraph, components: plant.sourceGraph.components.map(component => String(component.id) !== 'turbineBypassValve' ? component : {
    ...component, parameters: { ...(component.parameters as object), controller: { ...(component.parameters as { controller: object }).controller, setpoint } },
  }) },
  automationForGraph: () => ({ operatingModes: [], annunciatorSystems: [], firstOutGroups: [], safetyFunctions: [], rules: [] }),
})

describe('declared physical domains also apply to initialized runtime values', () => {
  test('the current complete PWR initializes correctly with two through six loops', () => {
    for (const loopCount of [2, 3, 4, 5, 6]) {
      const system = compileProcessPlant(createPwrReferencePlantDefinition({ id: `plant:initial-${loopCount}`, loopCount }))
      expect(() => createProcessPlantRuntime({ system })).not.toThrow()
      const table = createProcessPlantVariableTable(system, initialComponentValueFor)
      for (const variable of system.graph.variables) if (variable.owner.type === 'link') expect(table.read(variable.path)).toBe(variable.initialValue!)
    }
  })

  test('a source-authored negative pressure target cannot start a runtime', () => {
    const invalid = changedTarget(-1)
    expect(() => createProcessPlantRuntime({ system: invalid })).toThrow(`${target} pressure value must be non-negative`)
    const finiteHighTarget = changedTarget(20)
    expect(createProcessPlantRuntime({ system: finiteHighTarget }).readVariable(target)).toBe(20)
  })

  test('initializer type, nonfinite values and level physical domains are enforced before any solver step', () => {
    const cases = [
      [target, Number.NaN], [target, Number.POSITIVE_INFINITY], [target, true],
      ['feedwaterControlValveA.controllerSetpoint', 101], ['feedwaterControlValveA.controllerSetpoint', -1],
      ['turbineBypassValve.controllerAutomatic', 1],
    ] as const
    for (const [path, value] of cases) expect(() => createProcessPlantVariableTable(plant,
      (component, variablePath) => variablePath === path ? value : initialComponentValueFor(component, variablePath),
    )).toThrow(String(path))
  })

  test('a bad compiled link initial value is rejected rather than entering the numerical table', () => {
    const pressure = plant.graph.variables.find(variable => variable.owner.type === 'link' && variable.descriptor.quantity === 'pressure')!
    const invalid = { ...plant, graph: { ...plant.graph, variables: plant.graph.variables.map(variable => variable === pressure ? { ...variable, initialValue: -1 } : variable) } }
    expect(() => createProcessPlantVariableTable(invalid, initialComponentValueFor)).toThrow(`${pressure.path} pressure value must be non-negative`)
  })

  test('a deliberately manual valve is valid only when its removed controller has no dangling variable overrides', () => {
    const compile = (removeOverrides: boolean) => compileResolvedProcessPlant({
      id: 'plant:static-valve', modelRef: 'test.model', operatingPointRef: 'test.point', automationRef: 'test.automation',
      graph: { ...plant.sourceGraph, components: plant.sourceGraph.components.map(component => {
        if (String(component.id) !== 'turbineBypassValve') return component
        const { controller, ...parameters } = component.parameters as Record<string, unknown>
        return { ...component, parameters, variables: removeOverrides
          ? component.variables.filter(variable => variable.path !== 'controllerAutomatic' && variable.path !== 'controllerSetpoint') : component.variables }
      }) },
      automationForGraph: () => ({ operatingModes: [], annunciatorSystems: [], firstOutGroups: [], safetyFunctions: [], rules: [] }),
    })
    expect(() => compile(false)).toThrow('controllerAutomatic')
    const staticValve = compile(true)
    const runtime = createProcessPlantRuntime({ system: staticValve })
    runtime.writeCommand({ type: 'setVariable', path: 'turbineBypassValve.positionFraction' as VariablePath, value: 0.4 })
    runtime.tick(1_000)
    expect(runtime.readVariable('turbineBypassValve.positionFraction' as VariablePath)).toBe(0.4)
    expect(Number(runtime.readVariable('turbineBypassValve.effectivePositionFraction' as VariablePath))).toBeGreaterThan(0)
  })

  test('valid operating-point values override initializers and a restored checkpoint remains authoritative', () => {
    const system = { ...plant, initialState: [{ path: target, value: 7.4 }] }
    const runtime = createProcessPlantRuntime({ system })
    expect(runtime.readVariable(target)).toBe(7.4)
    runtime.writeCommand({ type: 'setVariable', path: target, value: 7.5 })
    runtime.tick(1_000)
    const restored = createProcessPlantRuntime({ system, restoredCheckpoint: runtime.checkpoint() })
    expect(restored.readVariable(target)).toBe(7.5)
  })

  test('an invalid restored value is rejected under the same initialized physical domain', () => {
    const checkpoint = createProcessPlantRuntime({ system: plant }).checkpoint()
    const slot = plant.graph.variables.findIndex(variable => variable.path === target)
    const values = [...checkpoint.values]
    values[slot] = -1
    expect(() => createProcessPlantRuntime({ system: plant, restoredCheckpoint: { ...checkpoint, values } })).toThrow(`${target} pressure value must be non-negative`)
  })
})
