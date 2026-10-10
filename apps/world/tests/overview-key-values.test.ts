import { describe, expect, test } from 'bun:test'
import { compileProcessPlant, createPwrReferencePlantDefinition } from '../src/packs/process-plant/index.ts'
import { equipmentKeyValues, overviewKeyValues } from '../src/packs/process-plant/displays/overview-key-values.ts'
import { annunciatorSystems } from '../src/packs/process-plant/displays/annunciators.ts'

describe('the values a unit overview leads with', () => {
  test('come from what protection trips on outside the loops, then the energy source and sink', () => {
    for (const loopCount of [4, 6]) {
      const plant = compileProcessPlant(createPwrReferencePlantDefinition({ id: `plant:key-values-${loopCount}`, loopCount }))
      const paths = overviewKeyValues(plant)
      expect(paths).toEqual([
        'core.powerMw',
        'vessel.netInventoryFlowKgPerS',
        'pressurizer.pressureMPa',
        'containment.pressureMPa',
        'core.coolantOutletTemperatureC',
        'turbine.electricMw',
      ] as never)
      // A steam generator's low-low level trips the auxiliary feed, but per-loop values stay on their loop.
      for (const path of paths) expect(plant.graph.components[plant.graph.componentIndexById.get(String(path).split('.')[0] as never)!]!.metadata?.loopId).toBeUndefined()
    }
  })
})

describe('the values equipment opened from the overview leads with', () => {
  const plant = compileProcessPlant(createPwrReferencePlantDefinition({ id: 'plant:equipment-values', loopCount: 4 }))
  const of = (...ids: ReadonlyArray<string>) => equipmentKeyValues(plant, ids.map(id => plant.graph.componentIndexById.get(id as never)!))

  test('are its signals the I&C rules judge, then its key values and instruments; never a demand', () => {
    expect(of('core').slice(0, 2)).toEqual(['core.powerMw', 'core.coolantOutletTemperatureC'] as never)
    // A pump's run command and a valve's position demand are writable: the drawing shows them, the values do not.
    expect(of('feedwaterControlValveA')).toEqual([])
  })

  test('parallel equipment is compared value by value', () => {
    expect(of('sgA', 'sgB')).toEqual(['sgA.levelPercent', 'sgB.levelPercent', 'sgA.secondaryRadiationMSvPerH', 'sgB.secondaryRadiationMSvPerH', 'sgA.pressureMPa', 'sgB.pressureMPa'] as never)
  })
})

describe('the annunciator systems an overview summarises its alarms by', () => {
  test('are the systems the I&C rules declare, in the order the model first declares them, each with its rules', () => {
    const plant = compileProcessPlant(createPwrReferencePlantDefinition({ id: 'plant:annunciators', loopCount: 4 }))
    const result = annunciatorSystems(plant)
    if (!result.ok) throw new Error(result.issues.join('; '))
    const systems = result.systems
    // A name too wide for a tile at its least width is shown by its initials, never cut.
    expect(systems.map(system => system.label)).toEqual(['Reactor protection', 'RCS', 'Steam generators', 'Safety injection', 'Containment', 'Electrical', 'Feedwater', 'Balance of plant', 'Main steam'])
    expect(systems.map(system => system.name)).toEqual(['reactor protection', 'reactor coolant system', 'steam generators', 'safety injection', 'containment', 'electrical', 'feedwater', 'balance of plant', 'main steam'])
    // Every alarm and trip of the reference Plant is annunciated on exactly one system.
    const annunciated = systems.flatMap(system => system.ruleIds)
    expect(new Set(annunciated).size).toBe(annunciated.length)
    expect(annunciated.length).toBe(plant.automation.rules.filter(rule => rule.enabled && rule.effects.some(effect => effect.type === 'alarm.enter' || effect.type === 'trip.enter')).length)
  })
})

describe('an annunciator tile never looks quiet while one of its alarms is active', () => {
  const plant = compileProcessPlant(createPwrReferencePlantDefinition({ id: 'plant:annunciator-gaps', loopCount: 4 }))
  const withRules = (rules: typeof plant.automation.rules) => ({ ...plant, automation: { ...plant.automation, rules } })
  const unannunciated = (rule: (typeof plant.automation.rules)[number]) => ({ ...rule, effects: rule.effects.map(effect => effect.type === 'alarm.enter' || effect.type === 'trip.enter' ? { ...effect, annunciator: undefined } : effect) })

  test('so a Plant names a system on every alarm, or on none', () => {
    const [first, ...rest] = plant.automation.rules
    const gap = annunciatorSystems(withRules([unannunciated(first!), ...rest]) as never)
    expect(gap).toEqual({ ok: false, issues: [`alarms of ${first!.id} name no annunciator system, so a system's tile could look quiet while they are active`] })
    // A Plant that annunciates nothing has no tiles.
    expect(annunciatorSystems(withRules(plant.automation.rules.map(unannunciated)) as never)).toEqual({ ok: true, systems: [] })
  })
})
