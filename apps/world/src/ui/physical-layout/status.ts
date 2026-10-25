import type { Priority } from '../../core/model/alerts.ts'
import { refObjectId } from '../../core/model/alerts.ts'
import type { Observation } from '../../core/observation/model.ts'
import type { VignetteValue } from '../../features/displays/compose/model.ts'
import { alertCensus, countedAs, type AlertCensus } from '../../features/displays/alerts/census.ts'
import { priorityRank, subjectOf, type AlertRow } from '../../features/displays/alerts/rows.ts'
import { severityTable, type Palette } from '../displays/severity.ts'

/** The physical occurrence never substitutes its own id for an owner's element. */
export interface PhysicalLayoutSubject {
  readonly packId: string
  readonly objectId: string
  readonly elementId: string
  readonly label: string
}

export const physicalSubjectKey = (subject: Pick<PhysicalLayoutSubject, 'packId' | 'objectId' | 'elementId'>): string =>
  JSON.stringify([subject.packId, subject.objectId, subject.elementId])

export interface PhysicalSubjectReading {
  readonly subject: PhysicalLayoutSubject
  /** The owner's declarations in its lead order, never a map-specific threshold table. */
  readonly values: ReadonlyArray<VignetteValue>
  readonly observations: ReadonlyArray<Observation>
}

export interface PhysicalSubjectStatus {
  readonly subject: PhysicalLayoutSubject
  readonly priority: Priority | null
  readonly quality: Observation['quality'] | 'not-observed'
  /** A declared state word, not an inference from a number or equipment label. */
  readonly word: string | null
  readonly active: number
  readonly returned: number
  readonly census: AlertCensus
  readonly frozen: boolean
}

const ownerKey = (target: Pick<PhysicalLayoutSubject, 'packId' | 'objectId'>): string => JSON.stringify([target.packId, target.objectId])
const alertKey = (row: AlertRow): string => JSON.stringify([row.packId, row.objectId, row.alert.id])

/** One owner lifecycle counts once, even when several physical casings carry it. */
export const uniqueLayoutAlerts = (rows: ReadonlyArray<AlertRow>): ReadonlyArray<AlertRow> => {
  const unique = new Map<string, AlertRow>()
  for (const row of rows) {
    const key = alertKey(row)
    const previous = unique.get(key)
    if (previous !== undefined && JSON.stringify(previous) !== JSON.stringify(row)) throw new Error(`Conflicting lifecycle rows for ${row.objectLabel}: ${row.alert.id}`)
    unique.set(key, row)
  }
  return [...unique.values()]
}

/** Alerts retain their actual owner subject; an actuation's ends are not invented fault locations. */
export const subjectLayoutAlerts = (rows: ReadonlyArray<AlertRow>, subject: PhysicalLayoutSubject): ReadonlyArray<AlertRow> =>
  uniqueLayoutAlerts(rows.filter(row => row.packId === subject.packId && row.objectId === subject.objectId && subjectOf(row) === subject.elementId))

const worstQuality = (values: ReadonlyArray<VignetteValue>, observations: ReadonlyArray<Observation>): PhysicalSubjectStatus['quality'] => {
  if (values.length === 0) return 'not-observed'
  const qualities = values.map(value => observations.find(observation => observation.ref === value.ref)?.quality ?? 'bad')
  if (qualities.every(quality => quality === 'not-applicable')) return 'not-applicable'
  return (['bad', 'stale', 'uncertain', 'good'] as const).find(quality => qualities.includes(quality)) ?? 'not-applicable'
}

export const physicalSubjectStatus = (reading: PhysicalSubjectReading, rows: ReadonlyArray<AlertRow>, frozen: boolean): PhysicalSubjectStatus => {
  const own = subjectLayoutAlerts(rows, reading.subject)
  const observations = reading.observations.filter(observation => reading.values.some(value => value.ref === observation.ref))
  if (reading.values.some(value => refObjectId(value.ref) !== reading.subject.objectId)
    || observations.some(observation => refObjectId(observation.ref) !== reading.subject.objectId)) throw new Error('Layout readings belong to another operational owner')
  const quality = worstQuality(reading.values, observations)
  // Expected, standing and advisory populations remain counted and labelled;
  // they do not create a second alarm colour through this view.
  const priorities = [
    ...observations.filter(observation => observation.quality === 'good').map(observation => observation.priority),
    ...own.filter(row => countedAs(row) === 'news').map(row => row.priority),
  ]
  const priority = priorities.reduce<Priority | null>((best, value) => priorityRank(value) > priorityRank(best) ? value : best, 'none')
  let word: string | null = null
  for (const value of reading.values) {
    if (value.valueType !== 'boolean' && value.valueType !== 'enum' && value.quantity !== 'state') continue
    const observation = observations.find(observation => observation.ref === value.ref)
    const raw = observation?.quality === 'good' ? observation.value : null
    if (raw === null || raw === undefined) continue
    const declared = value.states?.find(entry => entry.value === String(raw))?.label
    if (declared !== undefined) { word = declared; break }
    // An unlabelled boolean could mean permissive, selection or demand; a
    // stand-alone yes/no would falsely present it as the equipment's state.
    // An open enum explicitly declared as state already supplies its words.
    if (!(value.states?.length) && value.quantity === 'state' && value.valueType === 'enum' && typeof raw === 'string') { word = raw; break }
  }
  return {
    subject: reading.subject, priority: frozen ? null : priority, quality: frozen ? 'stale' : quality, word: frozen ? null : word,
    active: own.filter(row => row.state !== 'returned-unack').length,
    returned: own.filter(row => row.state === 'returned-unack').length,
    census: alertCensus(own), frozen,
  }
}

export interface PhysicalOccurrenceLocation {
  readonly id: string
  readonly subjects: ReadonlyArray<PhysicalLayoutSubject>
  readonly disposition: 'installed' | 'proposed' | 'removed' | 'temporary'
}

export interface PhysicalLayoutStatusSummary {
  readonly census: AlertCensus
  readonly affectedSubjects: number
  readonly affectedLocations: number
  readonly hiddenLocations: number
  readonly unlocatedAlerts: number
  readonly unlocatedSubjects: number
}

/** The plant total is independent of selected floor, loaded chunks and status-layer visibility. */
export const physicalLayoutStatusSummary = (input: {
  readonly owners: ReadonlyArray<Pick<PhysicalLayoutSubject, 'packId' | 'objectId'>>
  readonly alerts: ReadonlyArray<AlertRow>
  readonly occurrences: ReadonlyArray<PhysicalOccurrenceLocation>
  readonly visibleOccurrenceIds: ReadonlySet<string>
}): PhysicalLayoutStatusSummary => {
  const owners = new Set(input.owners.map(ownerKey))
  const rows = uniqueLayoutAlerts(input.alerts.filter(row => owners.has(ownerKey(row))))
  const affected = new Set(rows.flatMap(row => {
    const elementId = subjectOf(row)
    return elementId === undefined ? [] : [physicalSubjectKey({ packId: row.packId, objectId: row.objectId, elementId })]
  }))
  const installed = input.occurrences.filter(occurrence => occurrence.disposition === 'installed')
  const located = new Set(installed.flatMap(occurrence => occurrence.subjects.map(physicalSubjectKey)))
  const affectedLocations = installed.filter(occurrence => occurrence.subjects.some(subject => affected.has(physicalSubjectKey(subject))))
  return {
    census: alertCensus(rows), affectedSubjects: affected.size, affectedLocations: affectedLocations.length,
    hiddenLocations: affectedLocations.filter(occurrence => !input.visibleOccurrenceIds.has(occurrence.id)).length,
    unlocatedAlerts: rows.filter(row => {
      const elementId = subjectOf(row)
      return elementId === undefined || !located.has(physicalSubjectKey({ packId: row.packId, objectId: row.objectId, elementId }))
    }).length,
    unlocatedSubjects: [...affected].filter(key => !located.has(key)).length,
  }
}

/** Admission is independent of clocks: a lower simulation time never proves a reset. */
export interface PhysicalLiveScope {
  readonly runId: string
  readonly layoutObjectId: string
  readonly revision: string
  readonly objectId: string
  readonly packId: string
  readonly modelDigest: string
}

export interface PhysicalLiveStamp {
  readonly scope: PhysicalLiveScope
  readonly epoch: string
  readonly sequence: number
  readonly receivedWallMs: number
}

export const admitPhysicalLiveStamp = (expected: PhysicalLiveScope, confirmedEpoch: string, previous: PhysicalLiveStamp | null, next: PhysicalLiveStamp): void => {
  if ((Object.keys(expected) as ReadonlyArray<keyof PhysicalLiveScope>).some(key => expected[key] !== next.scope[key])) throw new Error('Layout live scope changed; discard this response and refresh its binding')
  if (next.epoch !== confirmedEpoch) throw new Error('Layout live epoch has not been confirmed by the owner')
  if (!Number.isSafeInteger(next.sequence) || next.sequence < 0 || !Number.isFinite(next.receivedWallMs)) throw new Error('Invalid layout live stamp')
  if (previous !== null && previous.epoch === next.epoch && next.sequence < previous.sequence) throw new Error('Layout live response is older than the accepted owner sequence')
}

export const physicalLiveFresh = (stamp: PhysicalLiveStamp | null, wallNowMs: number, failed: boolean): boolean =>
  !failed && stamp !== null && wallNowMs >= stamp.receivedWallMs && wallNowMs - stamp.receivedWallMs <= 5_000

/** Same palette values as the real owner's card; unknown and retained evidence has no current alarm tint. */
export const physicalSubjectStyle = (status: PhysicalSubjectStatus, palette: Palette): { readonly color: readonly [number, number, number] | null; readonly emphasis: number } => {
  if (status.frozen || status.priority === null || status.priority === 'none' || status.priority === 'notice') return { color: null, emphasis: 0 }
  const css = severityTable[status.priority].rgb?.[palette]
  if (css === undefined) return { color: null, emphasis: 0 }
  const channels = css.match(/^rgb\((\d+), (\d+), (\d+)\)$/)
  if (channels === null) throw new Error('The shared alert palette did not resolve to RGB')
  return { color: [Number(channels[1]) / 255, Number(channels[2]) / 255, Number(channels[3]) / 255], emphasis: 0.65 }
}

export const physicalStatusWords = (status: PhysicalSubjectStatus | undefined): string => {
  if (status === undefined) return 'Not read'
  if (status.frozen) return 'Not live · last known evidence'
  const quality = status.quality === 'not-observed' ? 'No live readings' : status.quality === 'not-applicable' ? 'Not applicable'
    : status.quality === 'good' ? null : `${status.quality} quality`
  const alerts = status.census.total === 0 ? null : `${status.active} active, ${status.returned} returned, ${status.census.unacknowledged} unacknowledged`
  return [status.word, quality, alerts].filter((word): word is string => word !== null).join(' · ') || 'No current abnormal indication in the acquired readings'
}
