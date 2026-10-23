import { asksAttention, groupKey, priorityRank, simulationMs, type AlertRow } from './rows.ts'

// An alert list as an operator reads it (plan v5 W2.4–W2.6), over the rows a
// sample carries, generic for every Pack: first the first-outs, in the order
// they came in; then what challenges an object's own states (a safety
// function); then new alarms that ask attention, the worst first and the
// newest of each priority first; then those returned to normal still
// unacknowledged; then one line per first-out that what came in as expected
// after it folds into ("15 expected after RX TRIP"), and one for the standing
// and advisory ones, each opening in place. The trip line and the full list
// (L4: by category, filtered) read the same rows.

/** Where a row stands in a list. */
export type ListPart = 'first-out' | 'state' | 'new' | 'returned' | 'expected' | 'quiet'
const PART_ORDER: ReadonlyArray<ListPart> = ['first-out', 'state', 'new', 'returned', 'expected', 'quiet']

export const listPart = (row: AlertRow): ListPart =>
  row.alert.firstOut?.rank === 1 ? 'first-out'
    : row.ownState === true ? 'state'
      : row.expected !== undefined ? 'expected'
        : !asksAttention(row) ? 'quiet'
          : row.state === 'returned-unack' ? 'returned' : 'new'

const earliest = (left: AlertRow, right: AlertRow): number => (simulationMs(left) ?? Infinity) - (simulationMs(right) ?? Infinity) || left.key.localeCompare(right.key)
const newest = (left: AlertRow, right: AlertRow): number => (simulationMs(right) ?? -Infinity) - (simulationMs(left) ?? -Infinity) || left.key.localeCompare(right.key)
const worst = (left: AlertRow, right: AlertRow): number => priorityRank(right.priority) - priorityRank(left.priority) || newest(left, right)

/** Rows in list order: by part, then first-outs as they came in, returned ones newest first, the others the worst first. */
export const listOrder = (left: AlertRow, right: AlertRow): number => {
  const [a, b] = [listPart(left), listPart(right)]
  if (a !== b) return PART_ORDER.indexOf(a) - PART_ORDER.indexOf(b)
  return a === 'first-out' ? earliest(left, right) : a === 'returned' ? newest(left, right) : worst(left, right)
}

/** "1st RX TRIP" where its Pack names the first-out's group, else "FIRST OUT"; null for a row that is not first out. */
export const firstOutMark = (row: AlertRow): string | null =>
  row.alert.firstOut?.rank !== 1 ? null : row.action === undefined ? 'FIRST OUT' : `1st ${row.action.label}`

export type ListLine =
  | { readonly kind: 'row'; readonly row: AlertRow; readonly part: ListPart }
  /** What several rows fold into: those expected after one first-out, or the standing and advisory ones. */
  | { readonly kind: 'aggregate'; readonly key: string; readonly part: 'expected' | 'quiet'; readonly label: string; readonly rows: ReadonlyArray<AlertRow>; readonly open: boolean }

/** A list's lines in order, each aggregate whose key is in `open` followed by its rows. */
export const listLines = (rows: ReadonlyArray<AlertRow>, open: ReadonlySet<string>): ReadonlyArray<ListLine> => {
  const sorted = [...rows].sort(listOrder)
  const lines: ListLine[] = sorted.filter(row => listPart(row) !== 'expected' && listPart(row) !== 'quiet').map(row => ({ kind: 'row', row, part: listPart(row) }))
  const fold = (key: string, part: 'expected' | 'quiet', label: string, members: ReadonlyArray<AlertRow>): void => {
    if (members.length === 0) return
    lines.push({ kind: 'aggregate', key, part, label, rows: members, open: open.has(key) })
    if (open.has(key)) lines.push(...members.map(row => ({ kind: 'row' as const, row, part })))
  }
  // One line per first-out, in the order their first expected alerts came in.
  const expected = sorted.filter(row => listPart(row) === 'expected')
  const afters = [...new Set([...expected].sort(earliest).map(row => row.expected!.after))]
  for (const after of afters) {
    const members = expected.filter(row => row.expected!.after === after)
    fold(`expected:${after}`, 'expected', `${members.length} expected after ${after}`, members)
  }
  const quiet = sorted.filter(row => listPart(row) === 'quiet')
  const standing = quiet.filter(row => row.alert.standing === true).length
  const advisory = quiet.filter(row => row.alert.standing !== true && row.alert.advisory === true).length
  fold('quiet', 'quiet', [...(standing > 0 ? [`${standing} standing`] : []), ...(advisory > 0 ? [`${advisory} advisory`] : [])].join(' · '), quiet)
  return lines
}

/** The rows a line stands for: a row itself, an aggregate those it folds (shown under it when open). */
const rowsOf = (line: ListLine): ReadonlyArray<AlertRow> => line.kind === 'row' ? [line.row] : line.open ? [] : line.rows

/**
 * The lines that fit `room` grid rows, one each. Where they do not all fit, a row says how many more there are ("+N
 * more"), and the aggregates that end the list keep their lines (`pinned`, shown after it), as they say what most of
 * the list is; an opened one keeps the rows it opened to as far as half the room, or what the rows before it leave.
 * `hidden`: the alerts not shown.
 */
export const fitLines = (lines: ReadonlyArray<ListLine>, room: number): {
  readonly shown: ReadonlyArray<ListLine>; readonly pinned: ReadonlyArray<ListLine>; readonly hidden: ReadonlyArray<AlertRow>
} => {
  if (lines.length <= room) return { shown: lines, pinned: [], hidden: [] }
  const tail = lines.findIndex(line => line.kind === 'aggregate')
  const [head, end] = tail < 0 ? [lines, []] : [lines.slice(0, tail), lines.slice(tail)]
  const budget = room - 1
  // The aggregate lines first, then the rows an opened one shows, in order, within the tail's room.
  const aggregates = end.filter(entry => entry.kind === 'aggregate').slice(0, Math.max(0, budget))
  const tailRoom = Math.max(aggregates.length, budget - head.length, Math.floor(budget / 2))
  const opened = end.filter(entry => entry.kind === 'row').slice(0, Math.max(0, tailRoom - aggregates.length))
  const kept = new Set<ListLine>([...aggregates, ...opened])
  const shown = head.slice(0, Math.max(0, budget - kept.size))
  const pinned = end.filter(line => kept.has(line))
  return { shown, pinned, hidden: [...head.slice(shown.length), ...end.filter(line => !kept.has(line))].flatMap(rowsOf) }
}

/** Age in Run time as m:ss under an hour, else h mm: the onset order reads at a glance. */
export const ageText = (nowMs: number, row: AlertRow): string | null => {
  const at = simulationMs(row)
  if (at === null || !Number.isFinite(nowMs)) return null
  const seconds = Math.max(0, Math.round((nowMs - at) / 1000))
  return seconds < 3600 ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}` : `${Math.floor(seconds / 3600)} h ${String(Math.floor((seconds % 3600) / 60)).padStart(2, '0')}`
}

export interface TripLine {
  /** First-outs whose group stops an energy end (the trip), in the order they came in, each with what its label opens. */
  readonly leads: ReadonlyArray<{ readonly row: AlertRow; readonly label?: string; readonly ends: ReadonlyArray<string> }>
  /** The other groups that have actuated (an alert of theirs holds until reset), by label, in the order they came in. */
  readonly actuated: ReadonlyArray<{ readonly label: string; readonly row: AlertRow }>
}

/**
 * One object's trip line, in the strip's order. Where its Pack names its groups, each group whose actuations stop an
 * energy end leads with its first-out (else its earliest held alert) and the others that hold are actuated; where it
 * names none, its first-outs lead in the order they came in.
 */
export const tripLine = (rows: ReadonlyArray<AlertRow>, objectId: string): TripLine => {
  const own = rows.filter(row => row.objectId === objectId).sort(earliest)
  if (!own.some(row => row.action !== undefined)) return { leads: own.filter(row => row.alert.firstOut?.rank === 1).map(row => ({ row, ends: [] })), actuated: [] }
  const held = own.filter(row => row.alert.latched === true && row.state !== 'returned-unack' && row.action !== undefined)
  const labels = [...new Set([...own.filter(row => row.alert.firstOut?.rank === 1 && row.action !== undefined), ...held].sort(earliest).map(row => row.action!.label))]
  const first = (label: string): AlertRow => own.find(row => row.action?.label === label && row.alert.firstOut?.rank === 1) ?? held.find(row => row.action!.label === label)!
  const stops = (label: string): ReadonlyArray<string> => own.find(row => row.action?.label === label)?.action?.ends ?? []
  return {
    leads: labels.filter(label => stops(label).length > 0).map(label => ({ row: first(label), label, ends: stops(label) })).sort((left, right) => earliest(left.row, right.row)),
    actuated: labels.filter(label => stops(label).length === 0 && held.some(row => row.action!.label === label)).map(label => ({ label, row: first(label) })),
  }
}

/** The full list's filters, in the grid alarm list's words. */
export const LIST_FILTERS = [
  { value: 'active', label: 'Active' },
  { value: 'unacknowledged', label: 'Unacknowledged' },
  { value: 'standing', label: 'Standing' },
  { value: 'all', label: 'All' },
] as const
export type ListFilter = (typeof LIST_FILTERS)[number]['value']

/** Whether a row passes a filter: active ones, unacknowledged ones that ask attention, standing or advisory ones, or all. */
export const passes = (filter: ListFilter, row: AlertRow): boolean =>
  filter === 'all' ? true
    : filter === 'active' ? row.state !== 'returned-unack'
      : filter === 'unacknowledged' ? row.state !== 'active-ack' && asksAttention(row)
        : row.alert.standing === true || row.alert.advisory === true

/**
 * The full list's groups: by category where its Pack declares one, in the declared order, else by object (and subject
 * group) in the order they come; each group's rows in list order.
 */
export const categoryGroups = (rows: ReadonlyArray<AlertRow>): ReadonlyArray<{ readonly key: string; readonly label: string; readonly rows: ReadonlyArray<AlertRow> }> => {
  const groups = new Map<string, { key: string; label: string; order: number; rows: AlertRow[] }>()
  for (const [at, row] of rows.entries()) {
    const key = row.category === undefined ? `object:${groupKey(row)}` : `category:${row.category.id}`
    const group = groups.get(key) ?? { key, label: row.category?.label ?? row.objectLabel, order: row.category === undefined ? 1_000 + at : row.category.order, rows: [] }
    group.rows.push(row)
    groups.set(key, group)
  }
  return [...groups.values()].sort((left, right) => left.order - right.order).map(group => ({ key: group.key, label: group.label, rows: [...group.rows].sort(listOrder) }))
}
