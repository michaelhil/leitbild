import { describe, expect, test } from 'bun:test'
import type { ScenarioRole } from '../../core/model/index.ts'
import { createDirectRoutingAdapter } from '../../routing/direct-adapter.ts'
import { einsatzCommandIds as ids } from './capabilities.ts'
import { prepareCommand, type CommandContext } from './commands.ts'
import { einsatzConfigSchema } from './config-validation.ts'
import { executeIntent } from './engine/engine.ts'
import { emptyEngineState, type EngineState } from './engine/model.ts'
import { at, controller, emptyState, low, newTask, newUnit, ports, runAll, start, templates, types } from './fixtures/engine-harness.ts'
import fixture from './fixtures/engine.config.json'
import { recommend } from './recommend.ts'
import { refusalCode } from './refusal.ts'
import { attributionOf, commandsUnit, inPicture, listText, openViewer, queuesTask, resolveViewer, type EinsatzViewer } from './viewer.ts'

/** The fixture configuration on two sides with groups: North's ground and air crews; their roles command their units. */
const groupConfig = einsatzConfigSchema.parse({
  ...fixture,
  groups: [
    { id: 'ground', label: 'Ground lead', category: 'Crews', side: 'north' },
    { id: 'air', label: 'Air lead', category: 'Crews', side: 'north' },
  ],
})

/** The roles of a sided Run: the groups' roles, an operator role that is no group's, and a controller. */
const declared: ReadonlyArray<ScenarioRole> = [
  { id: 'group:ground', label: 'Ground lead', class: 'operator', sees: ['north'] },
  { id: 'group:air', label: 'Air lead', class: 'operator', sees: ['north'] },
  { id: 'watch', label: 'Watch', class: 'operator', sees: ['north'] },
  { id: 'control', label: 'Control', class: 'controller', sees: 'all' },
]

const withGroups = async (): Promise<EngineState> => {
  let state = emptyEngineState({ config: groupConfig, sides: ['north'], timeMs: start })
  for (const intent of [
    newUnit('c1', types.roadCarrier, at(0.001), { side: 'north', group: 'ground' }),
    newUnit('d1', types.directCarrier, at(0.002), { side: 'north', group: 'air' }),
    newUnit('g1', types.pairServer, at(0.003), { side: 'north', group: 'air' }),
    newTask('t1', templates.load, at(0), { [low]: 1 }, { side: 'north' }),
    newTask('n1', templates.report, at(0), undefined, { side: 'north' }),
  ]) {
    const outcome = await executeIntent(state, intent, controller, ports)
    if (!outcome.ok) throw new Error(outcome.reason)
    state = outcome.state
  }
  return state
}

const operatorOf = (...roleIds: string[]): EinsatzViewer => resolveViewer({ roleIds, class: 'operator', sees: ['north'] }, declared)
const contextFor = (state: EngineState, viewer: EinsatzViewer): CommandContext => ({ state, viewer, roles: declared, by: attributionOf(viewer, 'actor:tester'), newId: kind => `${kind}:new` })
const refusalOf = (state: EngineState, viewer: EinsatzViewer, kind: Parameters<typeof prepareCommand>[1], payload: unknown): string => {
  const prepared = prepareCommand(contextFor(state, viewer), kind, payload)
  if (prepared.ok) throw new Error(`Expected ${kind} to be refused`)
  return prepared.reason
}

describe('Einsatz viewer', () => {
  test('no stamped viewer is open mode or the timeline, a truth view commanding everything; a stamped viewer holds its declared roles', () => {
    expect(resolveViewer(undefined, declared)).toBe(openViewer)
    expect(openViewer).toEqual({ class: 'controller', sees: 'all', roles: [] })
    expect(resolveViewer({ roleIds: ['group:ground', 'group:air'], class: 'operator', sees: ['north'] }, declared))
      .toEqual({ class: 'operator', sees: ['north'], roles: declared.slice(0, 2) })
    expect(() => resolveViewer({ roleIds: ['ghost'], class: 'operator', sees: 'all' }, declared)).toThrow('The caller holds role ghost, which this Run does not declare')
  })

  test('lastAction.by names the held roles by label, and the core actor only without roles, an AI agent marked as one', () => {
    expect(attributionOf(openViewer, 'actor:operator')).toBe('actor:operator')
    expect(attributionOf(openViewer, 'actor:assistant', 'ai')).toBe('ai:actor:assistant')
    expect(attributionOf(operatorOf('group:ground'), 'actor:operator', 'ai')).toBe('Ground lead')
    expect(attributionOf(operatorOf('group:ground', 'group:air', 'watch'), 'actor:operator')).toBe('Ground lead, Air lead and Watch')
    expect(listText(['A', 'B'])).toBe('A and B')
  })

  test('the commandable set and the queue follow the groups\' roles; a role that is no group\'s, or none, commands nothing', async () => {
    const state = await withGroups()
    const unit = (id: string) => state.units.get(id)!
    const task = (id: string) => state.tasks.get(id)!
    expect(['c1', 'd1', 'g1'].filter(id => commandsUnit(state.catalog, openViewer, unit(id)))).toEqual(['c1', 'd1', 'g1'])
    expect(['c1', 'd1', 'g1'].filter(id => commandsUnit(state.catalog, operatorOf('group:ground'), unit(id)))).toEqual(['c1'])
    expect(['c1', 'd1', 'g1'].filter(id => commandsUnit(state.catalog, operatorOf('group:ground', 'group:air'), unit(id)))).toEqual(['c1', 'd1', 'g1'])
    expect(['c1', 'd1', 'g1'].filter(id => commandsUnit(state.catalog, operatorOf('watch'), unit(id)))).toEqual([])
    expect(['t1', 'n1'].filter(id => queuesTask(state, operatorOf('group:ground'), task(id)))).toEqual(['t1'])
    expect(['t1', 'n1'].filter(id => queuesTask(state, operatorOf('watch'), task(id)))).toEqual([])
  })

  test('commands name the role a unit belongs to, order to tasks outside the queue but close only queued ones, and keep creating and adjusting to controllers', async () => {
    const state = await withGroups()
    const ground = operatorOf('group:ground')
    expect(refusalOf(state, ground, ids.order, { units: ['d1'], stops: [{ taskId: 't1' }] })).toBe('unit_not_authorized: Ground lead does not command D1. It belongs to Air lead: add that role to command it')
    expect(refusalOf(state, operatorOf('watch'), ids.order, { units: ['c1', 'd1'], stops: [{ taskId: 't1' }] })).toBe('unit_not_authorized: Watch does not command C1. It belongs to Ground lead: add that role to command it')
    expect(prepareCommand(contextFor(state, ground), ids.order, { units: ['c1'], stops: [{ taskId: 'n1' }] }).ok).toBe(true)
    expect(refusalOf(state, ground, ids.taskClose, { taskId: 'n1' })).toBe('task_not_in_role_queue: N1 is not in the queue of Ground lead')
    expect(prepareCommand(contextFor(state, ground), ids.taskClose, { taskId: 't1' }).ok).toBe(true)
    expect(refusalOf(state, ground, ids.order, { units: [], stops: [{ taskId: 't1' }] })).toStartWith('invalid_input: units: ')
    expect(refusalOf(state, ground, ids.unitCreate, { type: types.roadCarrier, at: at(0) })).toBe('role_controller_only: Creating a unit needs a controller role')
    expect(refusalCode(refusalOf(state, ground, ids.taskCreate, { template: templates.load, at: at(0), loads: { [low]: 1 }, label: 'X' }))).toBe('role_controller_only')
    expect(refusalCode(refusalOf(state, ground, ids.unitAdjust, { unitId: 'c1', properties: { liftKg: 600 }, reason: 'Test' }))).toBe('role_controller_only')
    const allowed = prepareCommand(contextFor(state, ground), ids.order, { units: ['c1'], stops: [{ taskId: 't1' }] })
    expect(allowed.ok && allowed.actor.commandable(state.units.get('d1')!)).toBe(false)
    const created = prepareCommand(contextFor(state, openViewer), ids.unitCreate, { type: types.roadCarrier, at: at(0) })
    expect(created.ok && created.intent).toMatchObject({ kind: 'unit.create', id: 'unit:new', label: 'Carrier 2' })
  })

  test('a viewer holding one side\'s picture sees that side and public records; other sides\' records are not in the picture and never echoed', async () => {
    const state = await runAll(emptyState(['north', 'south']), [
      newUnit('n1', types.roadCarrier, at(0), { side: 'north' }),
      newUnit('s1', types.roadCarrier, at(0), { side: 'south' }),
      newUnit('site', types.publicSite, at(0.01)),
    ])
    const north = resolveViewer({ roleIds: ['north-ground'], class: 'operator', sees: ['north'] }, [{ id: 'north-ground', label: 'North ground', class: 'operator', sees: ['north'] }])
    expect(['n1', 's1', 'site'].filter(id => inPicture(state.catalog, north, state.units.get(id)!))).toEqual(['n1', 'site'])
    expect(refusalOf(state, north, ids.recall, { unitId: 's1' })).toBe('not_in_picture: Not in your picture')
  })

  test('a side role never commands a public unit; a controller does', async () => {
    let state = emptyEngineState({ config: groupConfig, sides: ['north'], timeMs: start })
    for (const intent of [newUnit('n1', types.roadCarrier, at(0), { side: 'north', group: 'ground' }), newUnit('site', types.publicSite, at(0.01))]) {
      const outcome = await executeIntent(state, intent, controller, ports)
      if (!outcome.ok) throw new Error(outcome.reason)
      state = outcome.state
    }
    const north = operatorOf('group:ground')
    const site = state.units.get('site')!
    expect(inPicture(state.catalog, north, site)).toBe(true)
    expect(['n1', 'site'].filter(id => commandsUnit(state.catalog, north, state.units.get(id)!))).toEqual(['n1'])
    expect(commandsUnit(state.catalog, resolveViewer({ roleIds: ['control'], class: 'controller', sees: 'all' }, declared), site)).toBe(true)
    expect(refusalOf(state, north, ids.siteSet, { siteId: 'site', accepting: false })).toBe('unit_not_authorized: Ground lead does not command SITE, and no operator role does')
  })

  test('recommendations take candidates only from the viewer\'s commandable set', async () => {
    const state = await withGroups()
    const routing = createDirectRoutingAdapter()
    const offered = (answer: Awaited<ReturnType<typeof recommend>>) => [...new Set([...answer.proposal?.units ?? [], ...answer.alternatives.flatMap(entry => entry.units)].map(entry => entry.unitId))].sort()
    expect(offered(await recommend({ state, viewer: operatorOf('group:ground'), taskId: 't1', routing }))).toEqual(['c1'])
    expect(offered(await recommend({ state, viewer: operatorOf('group:ground', 'group:air'), taskId: 't1', routing }))).toEqual(['c1', 'd1'])
    const outside = await recommend({ state, viewer: operatorOf('group:ground'), taskId: 'n1', routing }).then(() => '', (error: Error) => error.message)
    expect(refusalCode(outside)).toBe('task_not_in_role_queue')
  })
})
