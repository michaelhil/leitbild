import { expect, test } from 'bun:test'
import { elementBlocks, blockRows } from '../src/features/displays/compose/element-groups.ts'
import { groupValues } from '../src/features/displays/compose/view.ts'
import type { VignetteValue } from '../src/features/displays/compose/model.ts'
import { componentValueOwner } from '../src/ui/embed/vignette/component-activation.ts'

const value = (owner: string, signal: string, quantity: VignetteValue['quantity'], group?: string): VignetteValue => ({
  ref: `${owner}#${signal}`, label: `${owner} · ${signal}`, quantity, unit: '1', valueType: 'number', thresholds: [], series: null,
  element: { id: 'core', class: 'source', label: 'Reactor Core', shortLabel: 'Core', ...(group === undefined ? {} : { group }) },
})
const ownerName = (entry: VignetteValue) => entry.ref.split('#')[0]!

test('identical local element ids stay separate by owner, with readable headings and exact inspection identity', () => {
  const values = ['plant:one', 'plant:two'].flatMap(owner => [value(owner, 'power', 'electric-power'), value(owner, 'temperature', 'temperature')])
  const blocks = elementBlocks(values, ownerName)!
  expect(blocks).toHaveLength(2)
  expect(blockRows(blocks)).toBe(6)
  for (const [at, block] of blocks.entries()) {
    if (block.kind !== 'element' || block.element === null) throw Error('Expected one named block per owner')
    const owner = at === 0 ? 'plant:one' : 'plant:two'
    expect(block.element.id).toBe('core')
    expect(block.element.label).toBe(`${owner} · Reactor Core`)
    expect(block.element.shortLabel).toBe(`${owner} · Core`)
    expect(componentValueOwner(block.values)).toBe(owner)
    expect(block.values.map(entry => entry.ref)).toEqual([`${owner}#power`, `${owner}#temperature`])
  }
})

test('parallel readings of the same train in different units have separate table rows and owner labels', () => {
  const values = ['plant:one', 'plant:two'].map(owner => value(owner, 'power', 'electric-power', 'A'))
  const table = groupValues(values, ownerName)!
  expect(table.rows).toBe(3)
  expect(table.lines.map(line => line.element.shortLabel)).toEqual(['plant:one · Core', 'plant:two · Core'])
  expect(table.lines.map(line => componentValueOwner(line.values))).toEqual(['plant:one', 'plant:two'])
  expect(table.lines.map(line => line.element.id)).toEqual(['core', 'core'])
  expect(new Set(table.lines.map(line => JSON.stringify([componentValueOwner(line.values), line.element.id]))).size).toBe(2)
  expect(table.lines.flatMap(line => line.values.flatMap(entry => entry?.ref ?? []))).toEqual(values.map(entry => entry.ref))
})

test('one owner keeps its original names and two services in one train are not made parallel', () => {
  const values = [value('plant:one', 'power', 'electric-power', 'A'), { ...value('plant:one', 'temperature', 'temperature', 'A'), element: { id: 'other', class: 'source', label: 'Other', group: 'A' } }]
  expect(groupValues(values, ownerName)).toBeNull()
  expect(elementBlocks(values, ownerName)).toBeNull()
  const one = elementBlocks([value('plant:one', 'power', 'electric-power'), value('plant:one', 'temperature', 'temperature'), { ...value('plant:one', 'other', 'electric-power'), element: { id: 'other', class: 'store', label: 'Other' } }], ownerName)!
  expect(one[0]?.kind === 'element' && one[0].element?.label).toBe('Reactor Core')
})
