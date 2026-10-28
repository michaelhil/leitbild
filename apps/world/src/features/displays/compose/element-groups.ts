/**
 * An answer's values grouped by the element each is measured on (plan v5 W7.4, H17): a decision aid, not a flat
 * list. An element's values come together under its name, its criterion first (W1.4); parallel elements (one class,
 * each in its own group, one value per quantity each, at most four) read as one table, a line per element; a value alone on its
 * element, or on none, reads as a row whose label names it. Only where the values are on several elements.
 */
import type { GroupedSection, ValueBlock, VignetteElement, VignetteValue } from './model.ts'
import { refObjectId } from '../../../core/model/alerts.ts'

const MAX_COLUMNS = 4

/** A value's column in a table of parallel elements: what it is and its unit. */
const columnOf = (value: VignetteValue): string => `${value.quantity}|${value.unit}`

/** Element ids and train names belong to an owner; identical units reuse them. */
export const valueElementKey = (value: VignetteValue): string | null => value.element === undefined ? null : JSON.stringify([refObjectId(value.ref), value.element.id])
export const valueElementName = (value: VignetteValue, objectOf: (value: VignetteValue) => string | undefined, qualified: boolean): VignetteElement => {
  const element = value.element!, owner = objectOf(value)
  return !qualified || owner === undefined ? element : { ...element, label: `${owner} · ${element.label}`, shortLabel: `${owner} · ${element.shortLabel ?? element.label}` }
}

/**
 * Elements alike enough to read as one table: two or more of one class, each in a group of its own (parallel trains,
 * as groupValues asks), each with the same quantities, one value each.
 */
const parallel = (groups: ReadonlyArray<Named>): boolean => {
  if (groups.length < 2 || new Set(groups.map(group => group.element.class)).size !== 1) return false
  if (groups.some(group => group.element.group === undefined) || new Set(groups.map(group => JSON.stringify([refObjectId(group.values[0]!.ref), group.element.group]))).size !== groups.length) return false
  const columns = (values: ReadonlyArray<VignetteValue>): string => values.map(columnOf).join('\u0000')
  const first = columns(groups[0]!.values)
  return groups.every(group => group.values.every(value => value.valueType !== 'criterion') && new Set(group.values.map(columnOf)).size === group.values.length
    && group.values.length <= MAX_COLUMNS && columns(group.values) === first)
}

/** A value's label without its object and the element a line or heading names: "Run command". */
export const bareLabel = (value: VignetteValue, object: string | undefined): string => {
  const own = object !== undefined && value.label.startsWith(`${object} · `) ? value.label.slice(object.length + 3) : value.label
  const element = [value.element?.shortLabel, value.element?.label].find(name => name !== undefined && own.endsWith(` · ${name}`))
  return element === undefined ? own : own.slice(0, -(element.length + 3))
}

/**
 * Parallel elements as one table: a line per element, a column per quantity, named as its values are where they share
 * a name ("Run command"), else by the quantity, as groupValues names it.
 */
const tableOf = (groups: ReadonlyArray<Named>, objectOf: (value: VignetteValue) => string | undefined): GroupedSection => ({
  kind: 'grouped', rows: 1 + groups.length,
  quantities: groups[0]!.values.map((value, column) => {
    const names = new Set(groups.map(group => bareLabel(group.values[column]!, objectOf(group.values[column]!))))
    return { label: names.size === 1 ? [...names][0]! : value.quantity.replaceAll('-', ' '), unit: value.unit }
  }),
  lines: groups.map(group => ({ element: group.element, values: group.values })),
})

type Group = { readonly element: VignetteElement | null; readonly values: ReadonlyArray<VignetteValue> }
type Named = Group & { readonly element: VignetteElement }
const onElement = (group: Group): group is Named => group.element !== null

/** The rows a list of blocks takes: a name over each element's values, a head over each table. */
export const blockRows = (blocks: ReadonlyArray<ValueBlock>): number =>
  blocks.reduce((sum, block) => sum + (block.kind === 'table' ? block.table.rows : (block.element === null ? 0 : 1) + block.values.length), 0)

/** The values grouped by element in the order their elements first appear, or null where that groups nothing; `objectOf` names a value's object. */
export const elementBlocks = (values: ReadonlyArray<VignetteValue>, objectOf: (value: VignetteValue) => string | undefined = () => undefined): ReadonlyArray<ValueBlock> | null => {
  const qualified = new Set(values.map(value => refObjectId(value.ref))).size > 1
  const order: Array<string | null> = []
  const byElement = new Map<string | null, { readonly element: VignetteElement | null; readonly values: VignetteValue[] }>()
  for (const value of values) {
    const id = valueElementKey(value)
    if (!byElement.has(id)) { order.push(id); byElement.set(id, { element: value.element === undefined ? null : valueElementName(value, objectOf, qualified), values: [] }) }
    byElement.get(id)!.values.push(value)
  }
  if (order.filter(id => id !== null).length < 2) return null
  // A criterion leads its element's values, as it leads the element's detail (W1.4).
  const groups = order.map((id): Group => {
    const group = byElement.get(id)!
    return { element: group.element, values: [...group.values.filter(value => value.valueType === 'criterion'), ...group.values.filter(value => value.valueType !== 'criterion')] }
  })
  const blocks: ValueBlock[] = []
  for (let at = 0; at < groups.length;) {
    const group = groups[at]!
    // The run of parallel elements this one starts: elements of its class with the same quantities.
    const run: Named[] = onElement(group) ? [group] : []
    for (let next = groups[at + run.length]; run.length > 0 && next !== undefined && onElement(next) && parallel([run[0]!, next]); next = groups[at + run.length]) run.push(next)
    if (run.length >= 2) blocks.push({ kind: 'table', table: tableOf(run, objectOf) })
    // An element with one value reads as a row whose label names it; one with several under its name.
    else if (group.values.length >= 2 && group.element !== null) blocks.push({ kind: 'element', element: group.element, values: group.values })
    else {
      // Rows next to each other stay one block.
      const last = blocks.at(-1)
      if (last?.kind === 'element' && last.element === null) blocks[blocks.length - 1] = { kind: 'element', element: null, values: [...last.values, ...group.values] }
      else blocks.push({ kind: 'element', element: null, values: group.values })
    }
    at += Math.max(1, run.length)
  }
  // Nothing grouped: the values read as rows, as before.
  return blocks.every(block => block.kind === 'element' && block.element === null) ? null : blocks
}
