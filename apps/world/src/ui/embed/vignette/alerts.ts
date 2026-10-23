// A vignette's alerts and its header's worst chip (architecture B), over the
// shared alert rows (features/displays/alerts/rows.ts), each drawn with
// OpenBridge's own alert icon (register #23: the OpenBridge-free twin stays in
// the main app's strip), in list order (features/displays/alerts/list.ts); a
// row without a priority is shown by its severity word, "priority not
// declared", and never ranks as a priority (R1).
// Nothing here can acknowledge an alert yet (W2.7), so no icon flashes: each
// is drawn steady, and the word UNACK carries the state (register deviation
// alert-icon-steady-unacknowledged).
import type { Observation } from '../../../core/observation/model.ts'
import type { VignetteSection, VignetteView } from '../../../features/displays/compose/model.ts'
import { ageText, firstOutMark } from '../../../features/displays/alerts/list.ts'
import { asksAttention, priorityRank, stateWords, type AlertRow } from '../../../features/displays/alerts/rows.ts'
import { severityStyle } from '../../displays/severity.ts'

/**
 * OpenBridge's alert icon for a row (obc-alert-icon): its alert type by the
 * declared priority (emergency is OpenBridge's critical level), drawn steady
 * in OpenBridge's acknowledged form whatever the record says, since nothing
 * here acknowledges (OpenBridge 2.0.0 flashes every unacknowledged icon and
 * has no steady unacknowledged form); a returned alarm is its steady
 * rectified icon. Notice has no icon and an undeclared priority none: both
 * read as their word.
 */
export const alertIcon = (row: AlertRow): { readonly type: 'level-critical' | 'alarm' | 'warning' | 'caution'; readonly acknowledged: true; readonly active: boolean } | { readonly word: string } => {
  const type = row.priority === 'emergency' ? 'level-critical' : row.priority === 'alarm' || row.priority === 'warning' || row.priority === 'caution' ? row.priority : null
  if (type === null) return { word: severityStyle(row.priority, row.alert.severity)?.word ?? 'Notice' }
  return { type, acknowledged: true, active: row.state !== 'returned-unack' }
}

/** The word an unacknowledged alert's row and its section's count carry, its steady icon not saying so. */
export const UNACK_WORD = 'UNACK'

/** Whether a row is unacknowledged and asks for attention: standing alarms and advisories never count as unacknowledged (R43). */
export const unacknowledged = (row: AlertRow): boolean => row.state !== 'active-ack' && asksAttention(row)

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

/** What a row says after its message: its tag, what it is expected after, its marks, its state where UNACK does not, its age in Run time (else its clock time). */
export const alertDetail = (row: AlertRow, nowMs: number): string => [
  // A first-out's tag that only names its group says nothing its mark does not ("1st TURB TRIP").
  ...(row.tag === undefined || (firstOutMark(row) !== null && row.tag === row.action?.label) ? [] : [row.tag]),
  ...(row.expected === undefined ? [] : [`after ${row.expected.after}`]),
  ...(row.alert.standing === true ? ['standing'] : []),
  ...(row.alert.advisory === true ? ['advisory'] : []),
  ...(unacknowledged(row) ? (row.state === 'returned-unack' ? ['returned'] : []) : row.state === 'active-unack' ? [] : [stateWords(row)]),
  ageText(nowMs, row) ?? (row.raised === null ? 'time unknown' : `${row.raised.at.slice(11, 19)} UTC`),
].join(' · ')

/** A row's full words, as its title and assistive technology read them: its object, state, mark, message, detail and clock time. */
export const alertTitle = (row: AlertRow, nowMs: number): string =>
  `${row.objectLabel}: ${unacknowledged(row) ? `${UNACK_WORD} · ` : ''}${firstOutMark(row) === null ? '' : `${firstOutMark(row)}: `}${row.alert.message} · ${alertDetail(row, nowMs)}${row.raised === null || ageText(nowMs, row) === null ? '' : ` · ${row.raised.at.slice(11, 19)} UTC`}`

type AlertsSection = Pick<Extract<VignetteSection, { kind: 'alerts' }>, 'objectIds' | 'elements' | 'refs'>

/** Whether a row belongs to a section: one of its objects (any in the Run), and where it names elements or observables, on one of them. */
export const inSection = (section: AlertsSection) => (row: AlertRow): boolean => {
  if (section.objectIds !== 'run' && !section.objectIds.includes(row.objectId)) return false
  if (section.elements === undefined && section.refs === undefined) return true
  return (elementOf(row) !== undefined && (section.elements ?? []).includes(elementOf(row)!)) || (row.alert.observable !== undefined && (section.refs ?? []).includes(row.alert.observable))
}

/** The element an alert is on, where its record names one: what its row opens. */
export const elementOf = (row: AlertRow): string | undefined => row.alert.subject !== undefined && 'element' in row.alert.subject ? row.alert.subject.element : undefined

/** The parts of a row a line lays out, besides its icon, in the fonts they are written in. */
export interface RowParts { readonly unack: boolean; readonly heading?: string; readonly mark: string | null; readonly message: string; readonly detail: string }
export const rowParts = (row: AlertRow, nowMs: number, heading?: string | undefined): RowParts =>
  ({ unack: unacknowledged(row), ...(heading === undefined ? {} : { heading }), mark: firstOutMark(row), message: row.alert.message, detail: alertDetail(row, nowMs) })

/** A row's icon and the gaps between its parts, in px (AlertRowLine.svelte). */
export const ROW_ICON_PX = 20
export const ROW_GAP_PX = 6
/** The fonts a row writes its parts in (AlertRowLine.svelte): its message, its marks (UNACK, 1st RX TRIP, a heading), its detail. */
export type RowFont = 'message' | 'mark' | 'detail'

/** How wide a row is on one line, its message whole, given how wide each part is written (`measure`). */
export const rowWidth = (parts: RowParts, measure: (text: string, font: RowFont) => number): number => {
  const widths = [ROW_ICON_PX, ...(parts.unack ? [measure(UNACK_WORD, 'mark')] : []), ...(parts.heading === undefined ? [] : [measure(parts.heading, 'mark')]),
    ...(parts.mark === null ? [] : [measure(`${parts.mark}:`, 'mark')]), measure(parts.message, 'message'), measure(parts.detail, 'detail')]
  return widths.reduce((sum, width) => sum + width, 0) + ROW_GAP_PX * (widths.length - 1)
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
