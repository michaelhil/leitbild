// A vignette's alerts and its header's worst chip (architecture B), over the
// shared alert rows (features/displays/alerts/rows.ts), each drawn with
// OpenBridge's own alert icon (register #23: the OpenBridge-free twin stays in
// the main app's strip), in list order (features/displays/alerts/list.ts); a
// row without a priority is shown by its severity word, "priority not
// declared", and never ranks as a priority (R1). People acknowledge alerts
// in the display window (W2.7), so an icon is drawn as its record stands:
// an unacknowledged alarm that asks for attention flashes until a person
// acknowledges it, and what asks none now (expected after a first-out,
// standing, advisory) shows its priority steady, the word UNACK saying it is
// not yet acknowledged.
import type { Priority } from '../../../core/model/alerts.ts'
import type { Observation } from '../../../core/observation/model.ts'
import type { VignetteSection, VignetteView } from '../../../features/displays/compose/model.ts'
import { ageText, firstOutMark, listPart } from '../../../features/displays/alerts/list.ts'
import { asksAttention, priorityRank, stateWords, subjectOf, unacknowledged, type AlertRow } from '../../../features/displays/alerts/rows.ts'
import { severityStyle } from '../../displays/severity.ts'

export type IconType = 'level-critical' | 'alarm' | 'warning' | 'caution'

/**
 * What a row is drawn with:
 * - OpenBridge's alert icon (obc-alert-icon) in its record's state: its type by the declared priority (emergency is
 *   OpenBridge's critical level), acknowledged steady, unacknowledged flashing at OpenBridge's tempo, returned
 *   rectified (flashing slowly until acknowledged);
 * - its priority alone, steady (obc-badge), while it is unacknowledged but asks no attention now: expected after a
 *   first-out, standing or advisory (R43), so only what is news flashes;
 * - its word, where it has no icon: notice, or a priority not declared.
 */
export type RowIcon =
  | { readonly kind: 'icon'; readonly type: IconType; readonly acknowledged: boolean; readonly active: boolean }
  | { readonly kind: 'badge'; readonly type: IconType }
  | { readonly kind: 'word'; readonly word: string }

export const alertIcon = (row: AlertRow): RowIcon => {
  const type = row.priority === 'emergency' ? 'level-critical' : row.priority === 'alarm' || row.priority === 'warning' || row.priority === 'caution' ? row.priority : null
  if (type === null) return { kind: 'word', word: severityStyle(row.priority, row.alert.severity)?.word ?? 'Notice' }
  if (row.state === 'active-ack') return { kind: 'icon', type, acknowledged: true, active: true }
  if (listPart(row) === 'expected' || !asksAttention(row)) return { kind: 'badge', type }
  return { kind: 'icon', type, acknowledged: false, active: row.state !== 'returned-unack' }
}

/**
 * A priority's count as obc-alert-counter-item takes it (emergency is OpenBridge's critical level, notice its
 * diagnostic one); null for none or a priority not declared, which OpenBridge has no count for and a word says.
 */
export const counterCounts = (priority: Priority | null, count: number): Readonly<Record<string, number>> | null =>
  priority === 'emergency' ? { countLevelCritical: count } : priority === 'alarm' ? { countAlarm: count } : priority === 'warning' ? { countWarning: count }
    : priority === 'caution' ? { countCaution: count } : priority === 'notice' ? { countLevelDiagnostic: count } : null

/** A priority's obc-badge type, as obc-alert-counter-item draws it; a neutral badge for none or a priority not declared. */
export const badgeType = (priority: Priority | null): string =>
  priority === 'emergency' ? 'level-critical' : priority === 'alarm' || priority === 'warning' || priority === 'caution' ? priority : priority === 'notice' ? 'level-diagnostic' : 'regular'

/** A priority in words: "alarm", "priority not declared". */
export const priorityWords = (priority: Priority | null): string => priority === null ? 'priority not declared' : priority === 'none' ? 'no priority' : priority

/** The word an unacknowledged alert's row and its section's count carry, beside its icon or its steady priority. */
export const UNACK_WORD = 'UNACK'

/**
 * The most of a label that fits where `fits` says: the whole of it, else its first whole words with "…" (a trailing
 * comma or colon left out), and only where its first word alone does not fit, that word cut with "…". A row's message
 * gives way so, never its marks, its state or its time (plan §2 rule 2). Fewer words never take more room, so the
 * words are found by halving.
 */
export const wordsThatFit = (text: string, fits: (shown: string) => boolean): string => {
  if (fits(text)) return text
  const words = text.split(' ')
  const cut = (shown: string): string => `${shown.replace(/[\s,;:·]+$/, '')}…`
  const most = (count: number, shown: (kept: number) => string): number => {
    let [low, high] = [0, count]
    while (low < high) {
      const mid = Math.ceil((low + high) / 2)
      if (fits(shown(mid))) low = mid
      else high = mid - 1
    }
    return low
  }
  const kept = most(words.length - 1, count => cut(words.slice(0, count).join(' ')))
  if (kept > 0) return cut(words.slice(0, kept).join(' '))
  const first = words[0]!
  return cut(first.slice(0, most(first.length - 1, count => cut(first.slice(0, count)))))
}

/**
 * What a row says after its message, by part: its tag; its notes (what it is expected after, standing or advisory, its
 * state where UNACK does not say it); its age in Run time, else its clock time.
 */
export interface RowDetail { readonly tag?: string; readonly notes: ReadonlyArray<string>; readonly age: string }

/** A first-out's tag less the group its mark names ("LO · RX TRIP" under "1st RX TRIP" is "LO"); none where it only names it. */
const ownLimit = (tag: string, group: string): string | undefined =>
  tag === group ? undefined : tag.endsWith(` · ${group}`) ? tag.slice(0, -` · ${group}`.length) : tag

export const rowDetail = (row: AlertRow, nowMs: number): RowDetail => {
  const tag = row.tag === undefined ? undefined : firstOutMark(row) !== null && row.action !== undefined ? ownLimit(row.tag, row.action.label) : row.tag
  return {
    ...(tag === undefined ? {} : { tag }),
    notes: [
      ...(row.expected === undefined ? [] : [`after ${row.expected.after}`]),
      ...(row.alert.standing === true ? ['standing'] : []),
      ...(row.alert.advisory === true ? ['advisory'] : []),
      ...(unacknowledged(row) ? (row.state === 'returned-unack' ? ['returned'] : []) : row.state === 'active-unack' ? [] : [stateWords(row)]),
    ],
    age: ageText(nowMs, row) ?? (row.raised === null ? 'time unknown' : `${row.raised.at.slice(11, 19)} UTC`),
  }
}

/** A row's detail as it is written: "LO-LO · ALM · after RX TRIP · 2:58". */
export const detailText = (detail: RowDetail): string => [...(detail.tag === undefined ? [] : [detail.tag]), ...detail.notes, detail.age].join(' · ')

/** What a row says after its message, whole: as its title and assistive technology read it. */
export const alertDetail = (row: AlertRow, nowMs: number): string => detailText(rowDetail(row, nowMs))

/** A row's full words, as its title and assistive technology read them: its object, state, mark, message, detail and clock time. */
export const alertTitle = (row: AlertRow, nowMs: number): string =>
  `${row.objectLabel}: ${unacknowledged(row) ? `${UNACK_WORD} · ` : ''}${firstOutMark(row) === null ? '' : `${firstOutMark(row)}: `}${row.alert.message} · ${alertDetail(row, nowMs)}${row.raised === null || ageText(nowMs, row) === null ? '' : ` · ${row.raised.at.slice(11, 19)} UTC`}`

type AlertsSection = Pick<Extract<VignetteSection, { kind: 'alerts' }>, 'objectIds' | 'elements' | 'refs'>

/** Whether a row belongs to a section: one of its objects (any in the Run), and where it names elements or observables, on one of them. */
export const inSection = (section: AlertsSection) => (row: AlertRow): boolean => {
  if (section.objectIds !== 'run' && !section.objectIds.includes(row.objectId)) return false
  if (section.elements === undefined && section.refs === undefined) return true
  // A row on an element, or on a group its Pack declares as an element (a Grid island), is that element's.
  return (subjectOf(row) !== undefined && (section.elements ?? []).includes(subjectOf(row)!)) || (row.alert.observable !== undefined && (section.refs ?? []).includes(row.alert.observable))
}

/** The element an alert is on, where its record names one: what its row opens. */
export const elementOf = (row: AlertRow): string | undefined => row.alert.subject !== undefined && 'element' in row.alert.subject ? row.alert.subject.element : undefined

/** The parts of a row a line lays out, in the fonts they are written in; `word`: the icon's word where it has no icon; `ack`: its acknowledge button. */
export interface RowParts {
  readonly word?: string
  readonly ack?: true
  readonly unack: boolean
  readonly heading?: string
  readonly mark: string | null
  readonly message: string
  readonly detail: RowDetail
}
export const rowParts = (row: AlertRow, nowMs: number, heading?: string | undefined, ack = false): RowParts => {
  const icon = alertIcon(row)
  // Its ACK says what UNACK would.
  return { ...(icon.kind === 'word' ? { word: icon.word } : {}), ...(ack ? { ack: true as const } : {}), unack: unacknowledged(row) && !ack, ...(heading === undefined ? {} : { heading }), mark: firstOutMark(row), message: row.alert.message, detail: rowDetail(row, nowMs) }
}

/** A row's icon, its acknowledge button and the gaps between its parts, in px (AlertRowLine.svelte). */
export const ROW_ICON_PX = 20
export const ROW_ACK_PX = 40
export const ROW_GAP_PX = 6
/** The fonts a row writes its parts in (AlertRowLine.svelte): its message, its marks (UNACK, 1st RX TRIP, a heading), its detail, an icon's word; a tile's label and a badge's number (AlertTiles.svelte). */
export type RowFont = 'message' | 'mark' | 'detail' | 'word' | 'tile' | 'badge' | 'chip'

/** How wide a row is on its one line with `message` shown (its whole message by default), given how wide each part is written (`measure`). */
export const rowWidth = (parts: RowParts, measure: (text: string, font: RowFont) => number, message = parts.message): number => {
  const widths = [parts.word === undefined ? ROW_ICON_PX : measure(parts.word, 'word'), ...(parts.unack ? [measure(UNACK_WORD, 'mark')] : []),
    ...(parts.heading === undefined ? [] : [measure(parts.heading, 'mark')]), ...(parts.mark === null ? [] : [measure(`${parts.mark}:`, 'mark')]),
    message === '' ? 0 : measure(message, 'message'), measure(detailText(parts.detail), 'detail'), ...(parts.ack === true ? [ROW_ACK_PX] : [])]
  return widths.reduce((sum, width) => sum + width, 0) + ROW_GAP_PX * (widths.length - 1)
}

/** Room a row leaves unused, in px, against the few a canvas and the page's layout may round apart. */
const ROW_SLACK_PX = 4

/**
 * The parts of a row that stand on its one line in `width` px (plan §2 rule 2: nothing cut but by whole words,
 * nothing drawn over anything). Its notes go first, the last first ("acknowledged", then "after RX TRIP": its icon and
 * its aggregate say them), while its message does not fit whole; then its message gives way by whole words
 * (AlertRowLine's wholeWords) to its first word, then to nothing; then the tag goes, then the heading. The icon,
 * UNACK, a first-out mark, the age and ACK always stand. What goes stays in the row's title and for assistive
 * technology.
 */
export const fitRow = (parts: RowParts, width: number, measure: (text: string, font: RowFont) => number): RowParts => {
  const room = width - ROW_SLACK_PX
  const first = parts.message.split(' ')[0]!
  const least = first === parts.message ? first : `${first.replace(/[\s,;:·]+$/, '')}…`
  const notes = parts.detail.notes
  for (let kept = notes.length; kept >= 0; kept -= 1) {
    const tried = kept === notes.length ? parts : { ...parts, detail: { ...parts.detail, notes: notes.slice(0, kept) } }
    if (rowWidth(tried, measure) <= room) return tried
  }
  const bare: RowParts = { ...parts, detail: { ...parts.detail, notes: [] } }
  if (rowWidth(bare, measure, least) <= room || rowWidth(bare, measure, '') <= room) return bare
  const untagged: RowParts = { ...bare, detail: { notes: [], age: parts.detail.age } }
  if (rowWidth(untagged, measure, '') <= room || untagged.heading === undefined) return untagged
  return { ...(parts.word === undefined ? {} : { word: parts.word }), ...(parts.ack === true ? { ack: true as const } : {}), unack: parts.unack, mark: parts.mark, message: parts.message, detail: untagged.detail }
}

/**
 * What a vignette's full alerts view lists (W2.6): the objects its alerts and drawings are about, or the Run's, and its
 * title; null where it lists no alerts.
 */
export const alertsTarget = (view: Pick<VignetteView, 'sections'>, rows: ReadonlyArray<AlertRow>): { readonly objectIds: ReadonlyArray<string> | 'run'; readonly title: string } | null => {
  // The full view itself opens no other.
  if (view.sections.some(section => section.kind === 'alerts' && section.all === true)) return null
  if (view.sections.some(section => section.kind === 'alerts' && section.objectIds === 'run')) return { objectIds: 'run', title: 'Alerts in the Run' }
  const objectIds = [...new Set(view.sections.flatMap(section => section.kind === 'alerts' && section.objectIds !== 'run' ? section.objectIds : section.kind === 'topology' ? [section.objectId] : []))]
  if (objectIds.length === 0) return null
  const label = objectIds.length === 1 ? rows.find(row => row.objectId === objectIds[0])?.objectLabel : undefined
  return { objectIds, title: label === undefined ? 'Alerts' : `Alerts · ${label}` }
}

export type WorstChip =
  | { readonly kind: 'priority'; readonly priority: 'caution' | 'warning' | 'alarm' | 'emergency' }
  /** Only alerts without a priority stand out: their worst severity, in words. */
  | { readonly kind: 'undeclared'; readonly severity: AlertRow['alert']['severity'] }

/** The worst the vignette shows at caution or above, over its values and its alerts' rows; null where nothing is. */
export const worstChip = (observations: ReadonlyArray<Pick<Observation, 'priority'>>, rows: ReadonlyArray<AlertRow>): WorstChip | null => {
  const priorities = [...observations.map(observation => observation.priority), ...rows.flatMap(row => (row.priority === null ? [] : [row.priority]))]
  const worst = priorities.reduce<Observation['priority']>((best, priority) => (priorityRank(priority) > priorityRank(best) ? priority : best), 'none')
  if (worst === 'caution' || worst === 'warning' || worst === 'alarm' || worst === 'emergency') return { kind: 'priority', priority: worst }
  const undeclared = rows.filter(row => row.priority === null).map(row => row.alert.severity)
  const severity = undeclared.includes('critical') ? 'critical' : undeclared.includes('warning') ? 'warning' : undefined
  return severity === undefined ? null : { kind: 'undeclared', severity }
}
