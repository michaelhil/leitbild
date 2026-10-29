import { describe, expect, test } from 'bun:test'
import { assertControllerProtectionIsolation } from '../src/packs/process-plant/controller-protection.ts'
import { compileProcessPlant, createPwrReferencePlantDefinition } from '../src/packs/process-plant/index.ts'
import { comparison, rule, write } from '../src/packs/process-plant/specs/reference-ic-helpers.ts'

const plant = compileProcessPlant(createPwrReferencePlantDefinition({ id: 'plant:controller-protection' }))
// This admission test changes only the resolved controller declaration; the
// actual operator controller schema/runtime has its own behavioral tests.
const graph = { ...plant.graph, components: plant.graph.components.map(component => String(component.id) !== 'feedwaterControlValveA' ? component : {
  ...component,
  parameters: { ...(component.parameters as object), controller: {
    ...((component.parameters as { controller: object }).controller), operator: {},
  } },
}) }
const assess = (effects: Parameters<typeof rule>[0]['effects'], ruleClass: 'protection' | 'interlock' | 'normalControl' = 'protection') => assertControllerProtectionIsolation(graph, {
  ...plant.automation,
  rules: [rule({ id: 'controller-hold', ruleClass, condition: comparison({ tagId: 'PZR-LVL' }, '>', 0), effects })],
})

describe('controller/protection authority admission', () => {
  test('accepts the reference protection which uses physical isolation inputs', () => {
    expect(() => assertControllerProtectionIsolation(graph, plant.automation)).not.toThrow()
  })

  test('refuses a one-time protective or interlock demand which a controller could overwrite', () => {
    for (const ruleClass of ['protection', 'interlock'] as const) {
      expect(() => assess([write('close', { tagId: 'MFW-A-CV' }, 0)], ruleClass)).toThrow('isolationSignal')
      expect(() => assess([write('close', { path: 'feedwaterControlValveA.positionFraction' }, 0)], ruleClass)).toThrow('isolationSignal')
    }
  })

  test('requires the exact valve isolation input, true, in the same protection action', () => {
    const close = write('close', { tagId: 'MFW-A-CV' }, 0)
    expect(() => assess([close, write('isolate', { path: 'feedwaterControlValveA.isolationSignal' }, true)])).not.toThrow()
    expect(() => assess([close, write('isolate', { path: 'feedwaterControlValveB.isolationSignal' }, true)])).toThrow('isolationSignal')
    expect(() => assess([close, write('isolate', { path: 'feedwaterControlValveA.isolationSignal' }, false)])).toThrow('isolationSignal')
    expect(() => assess([write('open', { tagId: 'MFW-A-CV' }, 1), write('isolate', { path: 'feedwaterControlValveA.isolationSignal' }, true)])).toThrow('isolationSignal')
  })

  test('does not make ordinary regulation or an uncontrolled valve into a protection hold', () => {
    expect(() => assess([write('regulate', { tagId: 'MFW-A-CV' }, 0.5)], 'normalControl')).not.toThrow()
    expect(() => assess([write('close-manual', { tagId: 'AFW-A-CV' }, 0)])).not.toThrow()
  })
})
