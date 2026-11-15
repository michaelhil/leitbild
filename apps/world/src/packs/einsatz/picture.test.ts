import { describe, expect, test } from 'bun:test'
import { einsatzConfigSchema } from './config-validation.ts'
import { commandsUnit, groupUnitTypesOf, inPicture, queuesTask, type PictureTask, type PictureTypes, type PictureUnit, type PictureViewer } from './picture.ts'

/**
 * The picture rules for role sets in sided Runs: the union of the held
 * roles' pictures, each group's role commanding and queueing only within its
 * own; an operator role that is no group's commands nothing.
 */

describe('Picture rules for group roles', () => {
  /** A carrier, a server of one requirement and a sensor. */
  const config = einsatzConfigSchema.parse({
    priorities: [{ id: 'p', label: 'Routine', code: 'P' }],
    loadClasses: [{ id: 'c1', label: 'One', code: 'C1', noun: { one: 'item', other: 'items' } }, { id: 'c2', label: 'Two', code: 'C2', noun: { one: 'item', other: 'items' } }],
    unitTypes: [
      { id: 'mover', label: 'Mover', icon: 'car', components: { mobility: { mode: 'road' }, carry: { capacity: 1, classes: ['c1'] } } },
      { id: 'fixer', label: 'Fixer', icon: 'wrench', components: { mobility: { mode: 'road' }, service: { provides: ['fix'], onSceneS: 60 } } },
      { id: 'watcher', label: 'Watcher', icon: 'eye', components: { mobility: { mode: 'road' }, sensor: { detectM: 1_000, identifyM: 500 } } },
    ],
    taskTemplates: [
      { id: 'job', label: 'Job', icon: 'package' },
      { id: 'repair', label: 'Repair', icon: 'flag', requires: [{ provides: 'fix', count: 1, label: { one: 'fixer', other: 'fixers' } }] },
      { id: 'note', label: 'Note', icon: 'flag' },
    ],
  })
  const types: PictureTypes = {
    unitType: id => config.unitTypes.find(type => type.id === id)!,
    taskTemplate: id => config.taskTemplates.find(template => template.id === id)!,
  }
  const units: ReadonlyArray<PictureUnit> = [
    { type: 'unit', unitType: 'mover', side: 'north', group: 'haulers' },
    { type: 'unit', unitType: 'mover', side: 'north', group: 'haulers' },
    { type: 'unit', unitType: 'fixer', side: 'north', group: 'crew' },
    { type: 'unit', unitType: 'watcher', side: 'north', group: 'eyes' },
    { type: 'unit', unitType: 'mover', side: 'south', group: 'raiders' },
  ]
  const groups = groupUnitTypesOf(units)
  const role = (group: string, sees: ReadonlyArray<string>) => ({ id: `group:${group}`, class: 'operator', sees }) as const
  const viewerOf = (...roles: ReadonlyArray<ReturnType<typeof role>>): PictureViewer =>
    ({ class: 'operator', sees: [...new Set(roles.flatMap(entry => entry.sees))], roles })
  const task = (template: string, side: string, loads: Readonly<Record<string, number>> = {}, pickedUp: Readonly<Record<string, number>> = {}): PictureTask =>
    ({ type: 'task', template, side, loads, pickedUp })

  test('reads each group\'s unit types from its units, once each', () => {
    expect(['haulers', 'crew', 'eyes', 'raiders', 'nobody'].map(groups)).toEqual([['mover'], ['fixer'], ['watcher'], ['mover'], []])
  })

  test('a group\'s role commands exactly its group\'s units, within the side it sees', () => {
    const haulers = viewerOf(role('haulers', ['north']))
    expect(units.map(entry => commandsUnit(types, haulers, entry))).toEqual([true, true, false, false, false])
    // A group's role seeing both sides still commands its own group only.
    const wide = viewerOf(role('haulers', ['north', 'south']))
    expect(units.map(entry => commandsUnit(types, wide, entry))).toEqual([true, true, false, false, false])
    expect(units.map(entry => commandsUnit(types, viewerOf(role('crew', ['north']), role('raiders', ['south'])), entry))).toEqual([false, false, true, false, true])
  })

  test('a group\'s role queues the tasks of its picture its units can serve: a requirement they provide or load they carry', () => {
    const queues = (viewer: PictureViewer, record: PictureTask) => queuesTask(types, viewer, record, groups)
    const haulers = viewerOf(role('haulers', ['north']))
    const crew = viewerOf(role('crew', ['north']))
    const eyes = viewerOf(role('eyes', ['north']))
    // Load of a class the movers carry, still waiting or already picked up; none of a class they do not carry.
    expect([task('job', 'north', { c1: 1 }), task('job', 'north', {}, { c1: 1 }), task('job', 'north', { c2: 1 }), task('job', 'south', { c1: 1 })].map(record => queues(haulers, record))).toEqual([true, true, false, false])
    expect([task('repair', 'north'), task('repair', 'north', { c1: 1 }), task('note', 'north')].map(record => queues(crew, record))).toEqual([true, true, false])
    // Movers carry the load of a repair, though they cannot fix it.
    expect(queues(haulers, task('repair', 'north', { c1: 1 }))).toBe(true)
    // A sensor serves nothing, and a report with nothing to serve is in no group's queue.
    expect([task('job', 'north', { c1: 1 }), task('repair', 'north'), task('note', 'north')].map(record => queues(eyes, record))).toEqual([false, false, false])
  })

  test('a role in the picture that is no group\'s commands nothing and queues nothing; a controller commands its whole picture', () => {
    const desk: PictureViewer = { class: 'operator', sees: ['north'], roles: [{ id: 'north-desk', class: 'operator', sees: ['north'] }] }
    expect(units.map(entry => commandsUnit(types, desk, entry))).toEqual([false, false, false, false, false])
    expect(queuesTask(types, desk, task('job', 'north', { c1: 1 }), groups)).toBe(false)
    const control: PictureViewer = { class: 'controller', sees: 'all', roles: [{ id: 'control', class: 'controller', sees: 'all' }] }
    expect(units.map(entry => commandsUnit(types, control, entry))).toEqual([true, true, true, true, true])
    expect(inPicture(types, desk, units[4]!)).toBe(false)
  })
})
