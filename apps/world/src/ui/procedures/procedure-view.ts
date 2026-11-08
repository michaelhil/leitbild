import type { ProcedureBranch, ProcedureCatalogItem, ProcedureDocument, ProcedureRunScope, ProcedureRunState, ProcedureStep, ProcedureTag, ProcedureTextBlock } from '../../core/model/index.ts'
import type { ProcedureCriterionReading } from '../../core/model/procedure-criteria.ts'
import type { ProcedureAssessmentCondition } from '@leitbild/procmd'
import type { ProcedureSourceEvidenceRequest } from './procedure-client.ts'
import type { ProcedureChecksView } from '../../features/procedures/checks-view.ts'
import { limitMaxAgeSeconds } from '@leitbild/procmd'

const primaryKinds = new Set(['check', 'action', 'expected', 'decision', 'when', 'until', 'within', 'concurrent', 'caution', 'note', 'text'])
const listKinds = new Set(['check', 'action', 'expected', 'rno'])
export type StepItem =
  | { readonly kind: 'block'; readonly blocks: readonly [ProcedureTextBlock, ...ProcedureTextBlock[]]; readonly primary: boolean; readonly sourceLine: number }
  | { readonly kind: 'branch'; readonly branch: ProcedureBranch; readonly primary: false; readonly sourceLine: number }

/** Group consecutive instructions without moving a caution, qualification or branch. */
export const procedureStepItems = (step: ProcedureStep): ReadonlyArray<StepItem> => {
  const ordered: StepItem[] = [
    ...step.blocks.map(block => ({ kind: 'block' as const, blocks: [block] as const, primary: primaryKinds.has(block.kind), sourceLine: block.sourceLine })),
    ...step.branches.map(branch => ({ kind: 'branch' as const, branch, primary: false as const, sourceLine: branch.sourceLine })),
  ]
  ordered.sort((left, right) => left.sourceLine - right.sourceLine)
  const items: StepItem[] = []
  for (const item of ordered) {
    const previous = items.at(-1)
    if (previous?.kind === 'block' && item.kind === 'block' &&
        listKinds.has(item.blocks[0].kind) && previous.blocks[0].kind === item.blocks[0].kind &&
        !step.pairs?.some(pair => previous.sourceLine < pair.sourceLine && pair.sourceLine < item.sourceLine) &&
        previous.blocks.every(block => !block.paths?.length) && !item.blocks[0].paths?.length) {
      items[items.length - 1] = { ...previous, blocks: [...previous.blocks, ...item.blocks] }
    } else {
      items.push(item)
    }
  }
  return items
}

type OperatorRow =
  | { readonly kind: 'sequence'; readonly items: ReadonlyArray<StepItem> }
  | { readonly kind: 'pair'; readonly id: string; readonly advisoryBranchIndex?: number; readonly expected: ReadonlyArray<StepItem>; readonly rno: ReadonlyArray<StepItem>; readonly other: ReadonlyArray<StepItem> }

const itemColumn = (item: StepItem): 'expected' | 'rno' | 'other' => {
  if (item.kind === 'branch') {
    return item.branch.outcome === 'normal' ? 'expected' : item.branch.outcome === 'rno' ? 'rno' : 'other'
  }
  if (item.blocks[0].kind === 'rno') return 'rno'
  return item.primary ? 'expected' : 'other'
}

const isNote = (item: StepItem) => item.kind === 'block' && item.blocks[0].kind === 'note'

/** An authored pair, or one unambiguous unmarked response. Complex retained steps keep source order. */
export const procedureOperatorRows = (step: ProcedureStep): { readonly rows: ReadonlyArray<OperatorRow>; readonly basis: ReadonlyArray<StepItem> } => {
  const all = procedureStepItems(step)
  const isBasis = (item: StepItem) => item.kind === 'block' && item.blocks[0].kind === 'basis'
  const items = all.filter(item => !isBasis(item))
  const basis = all.filter(isBasis)
  const makePair = (id: string, rowItems: ReadonlyArray<StepItem>, advisoryBranchIndex?: number): OperatorRow => ({
    kind: 'pair', id, ...(advisoryBranchIndex === undefined ? {} : { advisoryBranchIndex }),
    expected: rowItems.filter(item => itemColumn(item) === 'expected'),
    rno: rowItems.filter(item => itemColumn(item) === 'rno'),
    other: rowItems.filter(item => itemColumn(item) === 'other'),
  })
  if (step.pairs?.length) {
    // On a step with line limits a Pair names the branch its lights test, and the step ends with its boxes. Elsewhere the Pair also holds its branch.
    const assigned = new Map(step.blocks.some(block => block.limits !== undefined) ? [] : step.pairs.flatMap(pair => pair.advisoryBranchIndex === undefined
      ? []
      : [[step.branches[pair.advisoryBranchIndex]!, pair.id] as const]))
    const groups = new Map<string, StepItem[]>(step.pairs.map(pair => [pair.id, []]))
    const before: StepItem[] = []
    let active: string | undefined
    let next = 0
    for (const item of items) {
      while (next < step.pairs.length && step.pairs[next]!.sourceLine < item.sourceLine) {
        active = step.pairs[next++]!.id
      }
      const owner = item.kind === 'branch' ? assigned.get(item.branch) ?? active : active
      if (owner !== undefined) groups.get(owner)!.push(item)
      else before.push(item)
    }
    return {
      rows: [
        ...(before.length ? [{ kind: 'sequence' as const, items: before }] : []),
        ...step.pairs.map(pair => makePair(pair.id, groups.get(pair.id)!, pair.advisoryBranchIndex)),
      ],
      basis,
    }
  }
  // A control or prerequisite after an RNO must never be silently moved before it.
  let sawResponse = false
  let single = true
  let end = items.length
  const firstBranch = items.findIndex(item => item.kind === 'branch')
  if (firstBranch !== -1) while (end > firstBranch && isNote(items[end - 1]!)) end--
  const instructions = items.slice(0, end)
  for (const item of instructions) {
    if (item.kind === 'branch') continue
    if (itemColumn(item) === 'other' && item.blocks[0].kind !== 'unknown') single = false
    if (itemColumn(item) === 'rno') sawResponse = true
    else if (sawResponse && itemColumn(item) === 'expected') single = false
  }
  if (firstBranch !== -1 && instructions.slice(firstBranch).some(item => item.kind === 'block')) single = false
  return {
    rows: items.length === 0 ? [] : single
      ? [makePair('step', instructions), ...(end < items.length ? [{ kind: 'sequence' as const, items: items.slice(end) }] : [])]
      : [{ kind: 'sequence', items }],
    basis,
  }
}

type Comparison = Extract<ProcedureAssessmentCondition, { type: 'comparison' }>
export interface ProcedureLineCheck {
  readonly text: string
  readonly comparisons: ReadonlyArray<Pick<Comparison, 'tagId' | 'operator' | 'value' | 'unit' | 'maxAgeSeconds'>>
  /** Set where the document states its limits on the line: `any` for at least one, `when` for a line that waits. */
  readonly limits?: { readonly any: boolean; readonly when: boolean }
}

const comparisonConjunction = (condition: ProcedureAssessmentCondition): ReadonlyArray<Comparison> | null => {
  if (condition.type === 'comparison') return [condition]
  if (condition.type !== 'all') return null
  const groups = condition.conditions.map(comparisonConjunction)
  return groups.some(group => group === null) ? null : groups.flatMap(group => group ?? [])
}

const trailingTags = /(?:\s*«[^»]*»)+\s*$/

/** Trailing authored tags associate each Check line with exact, unique comparisons in its paired all-of. */
export const procedureLineChecks = (step: ProcedureStep, row: Extract<OperatorRow, { kind: 'pair' }>): ReadonlyMap<number, ProcedureLineCheck> => {
  const lines = new Map<number, ProcedureLineCheck>()
  if (row.advisoryBranchIndex === undefined) return lines
  const limited = row.expected.flatMap(item => item.kind === 'block' ? item.blocks.filter(block => block.limits !== undefined) : [])
  if (limited.length > 0) {
    for (const block of limited) lines.set(block.sourceLine, {
      text: `${block.kind === 'when' ? 'WHEN ' : ''}${block.text.replace(trailingTags, '')}`,
      comparisons: block.limits!.comparisons,
      limits: { any: block.limits!.any, when: block.kind === 'when' },
    })
    return lines
  }
  const condition = step.decisions?.find(decision => decision.branchIndex === row.advisoryBranchIndex)?.condition
  const comparisons = condition && comparisonConjunction(condition)
  if (!comparisons?.length || new Set(comparisons.map(item => item.tagId)).size !== comparisons.length) return lines
  const remaining = new Map(comparisons.map(item => [item.tagId, item]))
  for (const item of row.expected) {
    if (item.kind !== 'block') continue
    for (const block of item.blocks) {
      if (block.kind !== 'check') continue
      const suffix = /(?:\s+«[A-Za-z0-9][A-Za-z0-9._/-]*»)+\s*$/.exec(block.text)
      if (suffix === null) continue
      const text = block.text.slice(0, suffix.index).trimEnd()
      if (!text || text.includes('«')) return new Map()
      const bound: Comparison[] = []
      for (const match of suffix[0].matchAll(/«([^»]+)»/g)) {
        const comparison = remaining.get(match[1]!)
        if (!comparison) return new Map()
        remaining.delete(comparison.tagId)
        bound.push(comparison)
      }
      lines.set(block.sourceLine, { text, comparisons: bound })
    }
  }
  return remaining.size === 0 ? lines : new Map()
}

export const procedureLineCheckEvidence = (
  line: ProcedureLineCheck,
  readings: ReadonlyArray<ProcedureCriterionReading>,
  currentTime: string | undefined,
) => {
  const now = Date.parse(currentTime ?? '')
  const operands = line.comparisons.map(comparison => {
    // A band holds two comparisons on one tag, so a line with limits finds a reading by its comparison and not its tag alone.
    const last = readings.find(item => item.tagId === comparison.tagId && (line.limits === undefined || (item.operator === comparison.operator && item.expected === comparison.value)))
    const acquired = Date.parse(last?.sampledAt ?? '')
    const current = last !== undefined && acquired <= now && now - acquired <= comparison.maxAgeSeconds * 1000
    return { comparison, reading: current ? last : undefined, last }
  })
  const statuses = operands.map(item => item.reading?.status)
  const status: ProcedureLightTone = line.limits?.any
    ? statuses.includes('supported') ? 'supported' : statuses.every(item => item === 'contradicted') ? 'contradicted' : 'unknown'
    : statuses.includes('contradicted') ? 'contradicted' : statuses.every(item => item === 'supported') ? 'supported' : 'unknown'
  return { status, operands }
}

export type ProcedureLightTone = 'supported' | 'contradicted' | 'unknown' | 'waiting'

/** A WHEN line waits: it has no colour until met, and never shows red. */
export const procedureLightTone = (line: ProcedureLineCheck, status: ProcedureLightTone): ProcedureLightTone =>
  line.limits?.when && status !== 'supported' ? 'waiting' : status

export interface ProcedureLightRow {
  readonly tagId: string
  readonly name: string
  readonly value: string
  readonly limit?: string
  readonly state: ProcedureLightTone
  readonly quality: string
  readonly sampledAt?: string
}

/** A declared two-state word for a value: `states: OPEN/CLOSED` says OPEN for true or 1 and CLOSED for false or 0. */
const stateWord = (value: unknown, tag: ProcedureTag | undefined): string | undefined => {
  const words = tag?.annotations?.states?.split('/')
  if (words?.length !== 2) return undefined
  return value === true || value === 1 ? words[0] : value === false || value === 0 ? words[1] : undefined
}

/** A popover row for each of a lit line's comparisons: the reading, its limit, its time and its quality. A stale reading keeps its last value and says it is stale. */
export const procedureLightRows = (operands: ReturnType<typeof procedureLineCheckEvidence>['operands'], tags: ReadonlyArray<ProcedureTag>): ReadonlyArray<ProcedureLightRow> =>
  operands.map(({ comparison, reading, last }) => {
    const tag = tags.find(item => item.id === comparison.tagId)
    const word = stateWord(comparison.value, tag)
    const stale = last !== undefined && reading === undefined
    return {
      tagId: comparison.tagId,
      name: procedureReadingName(comparison.tagId, tags) ?? comparison.tagId,
      value: last?.value === undefined ? 'no value' : stateWord(last.value, tag) ?? procedureReadingText(last.value, last.unit),
      limit: word === undefined ? procedureRequirementText(comparison.operator, comparison.value, comparison.unit) : comparison.operator === '!=' ? `not ${word}` : word,
      state: reading?.status ?? 'unknown',
      quality: stale ? 'stale' : reading === undefined ? 'no reading' : reading.status === 'unknown' ? reading.reason ?? reading.quality ?? 'no valid reading' : reading.quality ?? 'good',
      ...(last?.sampledAt === undefined ? {} : { sampledAt: last.sampledAt }),
    }
  })

/**
 * What a line-light sample depends on. A paused plant changes only by what is done to it, so any accepted command or Pack change ends the sample.
 * On a running clock a sample ends by its own age, and the next read replaces it: dropping it on every command turned all lights grey until that read returned.
 */
export const procedureCheckVersion = (perspective: number, evidenceRevision: string, clock: { readonly paused: boolean; readonly currentTime: string } | undefined): string =>
  `${perspective}:${clock?.paused ? `paused:${clock.currentTime}:${evidenceRevision}` : 'running'}`

export type ProcedureTextSegment =
  | { readonly kind: 'text' | 'tag'; readonly text: string }
  | { readonly kind: 'link'; readonly text: string; readonly href: string }

export const procedureSourceEvidenceRequest = (href: string, document: ProcedureDocument): ProcedureSourceEvidenceRequest | undefined => {
  if (!href.startsWith('/wiki?')) return undefined
  try {
    const target = new URL(href, 'https://knowledge.invalid')
    const path = target.searchParams.get('path')
    if (!path || target.searchParams.get('revision') !== document.source.revision) return undefined
    return {
      sourceId: document.source.sourceId, sourceRevision: document.source.revision, sourcePath: path,
      ...(target.hash.length > 1 ? { section: decodeURIComponent(target.hash.slice(1)) } : {}), lineCount: 100,
    }
  } catch { return undefined }
}

const procedureSourceHref = (target: string, sourceUrl?: string): string | undefined => {
  try {
    if (target.startsWith('source:')) return `/api/knowledge/source?${new URLSearchParams({ path: target.slice(7) })}`
    if (target.startsWith('//')) return undefined
    if (sourceUrl?.startsWith('/wiki?') && !/^[a-z][a-z0-9+.-]*:/i.test(target)) {
      const source = new URL(sourceUrl, 'https://knowledge.invalid')
      const sourcePath = source.searchParams.get('path')
      const revision = source.searchParams.get('revision')
      if (sourcePath && revision) {
        const resolved = new URL(target, `https://knowledge.invalid/${sourcePath}`)
        return `/wiki?${new URLSearchParams({ path: decodeURIComponent(resolved.pathname.slice(1)), revision })}${resolved.hash}`
      }
    }
    const url = sourceUrl === undefined ? new URL(target) : new URL(target, sourceUrl)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : undefined
  } catch { return undefined }
}

/** The usage page, beside a rewritten document at its own revision. Other documents have no link: the page was not written for them. */
export const procedureUsageHref = (document: Pick<ProcedureDocument, 'annotations' | 'sourceUrl'>): string | undefined =>
  document.annotations?.['ai-workable'] === 'true' ? procedureSourceHref('usage.md', document.sourceUrl) : undefined

export const procedureBlockLabel = (kind: ProcedureTextBlock['kind']): string => ({
  check: 'Check', action: 'Action', expected: 'Expected response', rno: 'Response not obtained',
  unknown: 'Unknown or unreliable indication', basis: 'Technical basis', decision: 'Decision',
  when: 'When', until: 'Until', 'abort-if': 'Abort condition', 'abort-to': 'Abort destination',
  within: 'Time limit', concurrent: 'Concurrent action', caution: 'Caution', note: 'Note',
  because: 'Because', against: 'Against', text: '',
})[kind]

export const procedureObservationEvidence = (result: Record<string, unknown>, tags: ReadonlyArray<ProcedureTag> = []): ReadonlyArray<{
  readonly label: string; readonly value: string; readonly criterion: string; readonly status: string; readonly reason?: string
}> => {
  const frame = Array.isArray(result.recordings) ? evidenceRecord(result.current) : result
  if (!Array.isArray(frame.evidence)) return []
  return frame.evidence.map(value => {
    const item = evidenceRecord(value)
    const status = typeof item.status === 'string' ? item.status : 'unknown'
    const reason = typeof item.reason === 'string' ? { reason: item.reason } : {}
    if (typeof item.ruleId === 'string' && (item.field === 'active' || item.field === 'latched')) {
      const label = typeof item.label === 'string' ? item.label : item.ruleId
      return {
        label: `${label} · ${item.field}`,
        value: indicationState(item.value),
        criterion: indicationState(item.expected),
        status, ...reason,
      }
    }
    const facts = Number.isSafeInteger(item.readingIndex)
      ? evidenceRecord(Array.isArray(frame.readings) ? frame.readings[item.readingIndex as number] : undefined)
      : item
    const signal = evidenceRecord(facts.signal)
    const reference = evidenceRecord(item.reference)
    const variable = evidenceRecord(facts.variable)
    const comparison = evidenceRecord(item.comparison)
    return {
      label: observationSignalLabel(signal, reference, tags),
      value: procedureReadingText(variable.value, typeof variable.unit === 'string' ? variable.unit : undefined),
      criterion: procedureRequirementText(comparison.operator, comparison.value, typeof comparison.unit === 'string' ? comparison.unit : undefined),
      status, ...reason,
    }
  })
}

export const procedureSampledEvidence = (result: Record<string, unknown>, tags: ReadonlyArray<ProcedureTag> = []): ReadonlyArray<{
  readonly label: string; readonly value: string; readonly criterion: string; readonly status: string
  readonly span?: string; readonly window?: string; readonly reason?: string
}> => {
  const recordings = result.recordings
  if (!Array.isArray(recordings) || !Array.isArray(result.evidence)) return []
  return result.evidence.map(value => {
    const item = evidenceRecord(value)
    const comparison = evidenceRecord(item.comparison)
    const recording = evidenceRecord(Number.isSafeInteger(item.recordingIndex) ? recordings[item.recordingIndex as number] : undefined)
    const signal = evidenceRecord(recording.signal)
    const reference = evidenceRecord(comparison.signal)
    const label = observationSignalLabel(signal, reference, tags)
    const statistic = comparison.statistic === 'change' ? 'change' : comparison.statistic === 'minimum' ? 'minimum' : 'maximum'
    const unit = typeof comparison.unit === 'string' ? comparison.unit : undefined
    const from = observationClock(evidenceRecord(recording.first).simulationTime)
    const to = observationClock(evidenceRecord(recording.current).simulationTime)
    const anchor = observationClock(recording.notBeforeSimulationTime)
    const gap = typeof recording.maximumGapMs === 'number' ? ` · largest gap ${recording.maximumGapMs / 1000} s` : ''
    return {
      label: `${label} · ${statistic}`,
      value: procedureReadingText(typeof item.actual === 'number' ? item.actual : undefined, unit),
      criterion: procedureRequirementText(comparison.operator, comparison.value, unit),
      status: typeof item.status === 'string' ? item.status : 'unknown',
      ...(typeof recording.integratedSpanSeconds === 'number' ? { span: `${recording.integratedSpanSeconds} s recorded` } : {}),
      ...(from && to ? { window: `Samples ${from} to ${to}${gap}${anchor ? ` · after accepted operation at ${anchor}` : ''}` } : {}),
      ...(typeof item.reason === 'string' ? { reason: item.reason } : {}),
    }
  })
}

const observationClock = (value: unknown): string | undefined =>
  typeof value === 'string' ? /^\d{4}-\d{2}-\d{2}T(\d{2}:\d{2}:\d{2}(?:\.\d+)?)/.exec(value)?.[1] : undefined

const evidenceRecord = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}

const equipmentAcronyms = new Set(['ac', 'afw', 'ccw', 'dc', 'mfw', 'msiv', 'porv', 'pzr', 'rcp', 'rcs', 'rhr', 'rwst', 'sg', 'si', 'ups'])

const equipmentWords = (id: string): string => {
  const words = id.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[\s_-]+/).filter(Boolean)
    .map(word => word.length === 1 || equipmentAcronyms.has(word.toLowerCase()) ? word.toUpperCase() : word.toLowerCase())
  const text = words.join(' ')
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/**
 * What a reading is called. A description one tag holds is its name. A description several tags share
 * ("Running", "Steam generator pressure") names their equipment too, so no two readings look alike.
 */
export const procedureReadingName = (tagId: string, tags: ReadonlyArray<ProcedureTag>): string | undefined => {
  const tag = tags.find(item => item.id === tagId)
  if (tag?.description === undefined) return undefined
  if (tags.filter(item => item.description === tag.description).length < 2) return tag.description
  if (tag.equipment === undefined) return `${tag.description} (${tagId})`
  const description = /^[A-Z][a-z]/.test(tag.description) ? tag.description.charAt(0).toLowerCase() + tag.description.slice(1) : tag.description
  return `${equipmentWords(tag.equipment)}: ${description}`
}

export interface ProcedureFoldoutItem { readonly name?: string; readonly text: string }

/** A foldout's items: each list line, its bold headline apart. Lines that are not list items continue the one before. */
export const procedureFoldoutItems = (text: string): ReadonlyArray<ProcedureFoldoutItem> => {
  const items: Array<{ name?: string; text: string }> = []
  for (const line of text.split('\n').map(item => item.trim()).filter(Boolean)) {
    const opens = line.startsWith('- ') || items.length === 0
    if (!opens) { items[items.length - 1]!.text += ` ${line}`; continue }
    const body = line.replace(/^- /, '')
    const headline = /^\*\*(.+?)\*\*\s*/.exec(body)
    items.push(headline === null ? { text: body } : { name: headline[1]!, text: body.slice(headline[0].length) })
  }
  return items
}

/** Whether a foldout has yet to apply: its heading names the step it starts from, and the Run has not reached it. */
export const procedureFoldoutBeforeStart = (title: string, steps: ReadonlyArray<Pick<ProcedureStep, 'id' | 'label'>>, currentStepId: string | undefined): boolean => {
  const label = /\bSteps? ([\d.]+[a-z]?)/i.exec(title)?.[1]
  const start = steps.findIndex(step => step.label === label)
  return start >= 0 && steps.findIndex(step => step.id === currentStepId) < start
}

/** The foldout a reference document inherits: back along the transfers that led to it, to the nearest procedure that has one. All of it from the Runs as they stand. */
export const procedurePriorFoldout = (
  runs: ReadonlyArray<ProcedureRunState>,
  documentFor: (run: ProcedureRunState) => Pick<ProcedureDocument, 'procedureId' | 'foldout' | 'steps' | 'tags' | 'annotations'> | undefined,
  scope: Pick<ProcedureRunScope, 'plantId'>,
  procedureId: string,
): { readonly procedureId: string; readonly foldout: NonNullable<ProcedureDocument['foldout']>; readonly tags: ProcedureDocument['tags']; readonly annotations: ProcedureDocument['annotations']; readonly waiting: boolean } | undefined => {
  const seen = new Set<string>()
  let target = procedureId
  while (!seen.has(target)) {
    seen.add(target)
    const into = (run: ProcedureRunState) => run.stepStates.flatMap(state => state.decision?.targetKind === 'procedure' && state.decision.target === target ? [Date.parse(state.decision.simulationTime)] : [])
    const from = runs.filter(run => run.scope?.plantId === scope.plantId && run.status === 'transferred' && into(run).length > 0)
      .sort((left, right) => Math.max(...into(right)) - Math.max(...into(left)))[0]
    if (from === undefined) return undefined
    const document = documentFor(from)
    if (document?.foldout) return { procedureId: document.procedureId, foldout: document.foldout, tags: document.tags, annotations: document.annotations, waiting: procedureFoldoutBeforeStart(document.foldout.title, document.steps, from.currentStepId) }
    target = from.procedureId
  }
  return undefined
}

export type ProcedureIndication = NonNullable<ProcedureChecksView['indications']>[number]

/** A judgement line's tags as a grid: one column per piece of equipment and one row per thing read, where every cell is filled. Otherwise one named row each. */
export const procedureInlineLayout = (tagIds: ReadonlyArray<string>, tags: ReadonlyArray<ProcedureTag>): { readonly heads: ReadonlyArray<string>; readonly rows: ReadonlyArray<{ readonly label: string; readonly tagIds: ReadonlyArray<string | null> }> } => {
  const declared = tagIds.map(id => ({ id, tag: tags.find(item => item.id === id) }))
  // "SG A pressure" on SG A reads "Pressure" in a row beneath a column headed SG A.
  const rowOf = (item: (typeof declared)[number]): string => {
    const description = item.tag?.description ?? item.id
    const equipment = item.tag?.equipment === undefined ? undefined : equipmentWords(item.tag.equipment)
    if (equipment === undefined || !description.toLowerCase().startsWith(`${equipment.toLowerCase()} `)) return description
    const rest = description.slice(equipment.length + 1)
    return rest.charAt(0).toUpperCase() + rest.slice(1)
  }
  const columns = [...new Set(declared.map(item => item.tag?.equipment ?? item.id))]
  const rows = [...new Set(declared.map(rowOf))]
  const cell = (row: string, column: string) => declared.find(item => rowOf(item) === row && (item.tag?.equipment ?? item.id) === column)?.id ?? null
  if (columns.length > 1 && rows.length * columns.length === declared.length && rows.every(row => columns.every(column => cell(row, column) !== null)))
    return { heads: columns.map(equipmentWords), rows: rows.map(row => ({ label: row, tagIds: columns.map(column => cell(row, column)) })) }
  return { heads: [], rows: declared.map(({ id }) => ({ label: procedureReadingName(id, tags) ?? id, tagIds: [id] })) }
}

/** A reading on a judgement line: in the words its tag declares, else rounded. It says so where it is unavailable, bad or old. */
export const procedureInlineValue = (tagId: string, tags: ReadonlyArray<ProcedureTag>, indications: ReadonlyArray<ProcedureIndication>, now: number | undefined): { readonly value: string; readonly stale: boolean; readonly note?: string } => {
  const read = indications.find(item => item.tagId === tagId)
  if (read === undefined) return { value: '–', stale: true }
  if (read.value === undefined) return { value: '–', stale: true, note: read.reason ?? (read.binding === 'missing' ? 'not in this model' : 'no reading') }
  const value = stateWord(read.value, tags.find(item => item.id === tagId)) ?? procedureReadingText(read.value, read.unit)
  const acquired = Date.parse(read.sampledAt ?? '')
  if (read.quality !== undefined && read.quality !== 'good') return { value, stale: true, note: read.quality }
  if (now !== undefined && Number.isFinite(acquired) && now - acquired > limitMaxAgeSeconds * 1000) return { value, stale: true, note: 'stale' }
  return { value, stale: false }
}

/** What a branch was pressed against: the readings its criterion did not find met, by name. Undefined unless the criterion was contradicted. */
export const procedureDecisionAgainst = (decision: { readonly criterion?: { readonly status: string; readonly readings: ReadonlyArray<ProcedureCriterionReading> } | undefined } | undefined, tags: ReadonlyArray<ProcedureTag>): ReadonlyArray<string> | undefined => {
  if (decision?.criterion?.status !== 'contradicted') return undefined
  return [...new Set(decision.criterion.readings.filter(reading => reading.status !== 'supported')
    .map(reading => (reading.tagId === undefined ? undefined : procedureReadingName(reading.tagId, tags)) ?? reading.description ?? reading.tagId ?? 'Indication'))]
}

/**
 * What a line's tag buttons say. Beside a tag of the same equipment family only its letter is repeated,
 * so a line naming four valves reads "AFW valve A", "B", "C", "D" and takes one row, not four.
 */
export const procedureTagLabels = (segments: ReadonlyArray<ProcedureTextSegment>, document: Pick<ProcedureDocument, 'tags' | 'annotations'> | null): ReadonlyArray<{ readonly full: string; readonly shown: string } | undefined> => {
  let family: string | undefined
  const onLine = segments.flatMap(segment => segment.kind === 'tag' ? [procedureTagLabel(segment.text, document)] : [])
  return segments.map(segment => {
    if (segment.kind !== 'tag') {
      if (segment.text.trim() !== '') family = undefined
      return undefined
    }
    const label = procedureTagLabel(segment.text, document)
    // Two tags on one piece of equipment would both read "Pressurizer": each then says what it is.
    const full = onLine.filter(item => item === label).length > 1 ? document?.tags.find(tag => tag.id === segment.text)?.description ?? label : label
    const words = full.split(' ')
    const prefix = words.length > 1 && words.at(-1)!.length === 1 ? words.slice(0, -1).join(' ') : undefined
    const shown = prefix !== undefined && prefix === family ? words.at(-1)! : full
    family = prefix
    return { full, shown }
  })
}

/** The tags ending a line that carries no limit, and its words without them: a judgement or a fork, whose readings show with no colour. */
export const procedureJudgementLine = (block: Pick<ProcedureTextBlock, 'kind' | 'text' | 'tagIds' | 'limits'>): { readonly text: string; readonly tagIds: ReadonlyArray<string> } | undefined => {
  if (block.limits !== undefined || !['check', 'expected', 'when'].includes(block.kind) || block.tagIds.length === 0) return undefined
  const text = block.text.replace(trailingTags, '')
  return text === block.text || text.includes('«') ? undefined : { text, tagIds: block.tagIds }
}

/** What a tag button says. A rewritten document names the equipment, so the line reads as a line; a document left as it was keeps its tag ids. */
export const procedureTagLabel = (tagId: string, document: Pick<ProcedureDocument, 'tags' | 'annotations'> | null): string => {
  const equipment = document?.annotations?.['ai-workable'] === 'true' ? document.tags.find(tag => tag.id === tagId)?.equipment : undefined
  return equipment === undefined ? tagId : equipmentWords(equipment)
}

const observationSignalLabel = (signal: Record<string, unknown>, reference: Record<string, unknown>, tags: ReadonlyArray<ProcedureTag>): string => {
  const tagId = [signal.tagId, reference.tagId].find((text): text is string => typeof text === 'string')
  const named = tagId === undefined ? undefined : procedureReadingName(tagId, tags)
  if (named !== undefined) return named
  const identity = [signal.tagId, reference.tagId, signal.path, reference.path].find((text): text is string => typeof text === 'string')
  const label = typeof signal.label === 'string' ? signal.label : undefined
  return label && identity && label !== identity ? `${label} (${identity})` : label ?? identity ?? 'Unavailable indication'
}

const indicationState = (value: unknown) => value === true ? 'On' : value === false ? 'Off' : 'unavailable'

export const procedureObservationBasis = (result: Record<string, unknown>): string => {
  const basis = typeof result.basis === 'object' && result.basis !== null ? result.basis as Record<string, unknown> : {}
  const source = typeof basis.source === 'string' && /^(source:|https?:\/\/)|\.md(?:#|$)/.test(basis.source)
    ? `[Technical source](${basis.source})` : basis.source
  return [basis.description, source].filter(value => typeof value === 'string').join(' — ')
}

export const procedureObservationLabel = (result: Record<string, unknown>): 'Model comparison' | 'Read-only observation' => {
  const basis = typeof result.basis === 'object' && result.basis !== null ? result.basis as Record<string, unknown> : {}
  return basis.qualification === 'authored-comparison' ? 'Model comparison' : 'Read-only observation'
}

export const procedureTextSegments = (text: string, tagIds: readonly string[], sourceUrl?: string): ReadonlyArray<ProcedureTextSegment> => {
  const allowed = new Set(tagIds)
  const segments: ProcedureTextSegment[] = []
  let cursor = 0
  // Inline code and fenced examples are text, never live instrumentation links.
  for (const match of text.matchAll(/(`+)[\s\S]*?\1|«([^»]+)»|\[([^\]\n]+)\]\(([^)\s]+)\)/g)) {
    const start = match.index ?? 0
    if (start > cursor) segments.push({ kind: 'text', text: text.slice(cursor, start) })
    const id = match[2]
    const href = match[4] === undefined ? undefined : procedureSourceHref(match[4], sourceUrl)
    segments.push(id !== undefined && allowed.has(id) ? { kind: 'tag', text: id }
      : href !== undefined ? { kind: 'link', text: match[3]!, href }
      : { kind: 'text', text: match[0] })
    cursor = start + match[0].length
  }
  if (cursor < text.length) segments.push({ kind: 'text', text: text.slice(cursor) })
  return segments
}

/** What a step's ⓘ says about one of its tags, read from the live binding check, never from authored prose. */
export interface ProcedureStepTagBinding {
  readonly tagId: string
  readonly description?: string
  readonly status: 'resolved' | 'resolved-with-warnings' | 'missing' | 'unchecked'
  /** The Plant signal the tag reads: its label, path and native unit. */
  readonly reads?: string
  readonly warnings: ReadonlyArray<string>
  /** Authored tag fields the binding check does not judge, such as a model note. */
  readonly notes: ReadonlyArray<{ readonly label: string; readonly text: string }>
}

const signalReadsText = (signal: Record<string, unknown> | undefined): string | undefined => {
  if (signal === undefined) return undefined
  const label = typeof signal.label === 'string' ? signal.label : undefined
  const path = typeof signal.path === 'string' ? signal.path : undefined
  const unit = typeof signal.unit === 'string' && signal.unit.length > 0 ? signal.unit : undefined
  const named = label ?? path
  if (named === undefined) return undefined
  return [named, label !== undefined && path !== undefined ? `(${path}${unit === undefined ? '' : `, ${unit}`})` : unit === undefined ? undefined : `(${unit})`]
    .filter(Boolean).join(' ')
}

export const procedureStepTagBindings = (
  step: ProcedureStep,
  tags: ReadonlyArray<ProcedureTag>,
  validations: ReadonlyMap<string, { readonly status: 'resolved' | 'resolved-with-warnings' | 'missing'; readonly signal?: Record<string, unknown>; readonly warnings: ReadonlyArray<string> }>,
): ReadonlyArray<ProcedureStepTagBinding> => step.tagIds.map(tagId => {
  const tag = tags.find(candidate => candidate.id === tagId)
  const validation = validations.get(tagId)
  const reads = validation?.status === 'missing' ? undefined : signalReadsText(validation?.signal)
  return {
    tagId,
    ...(tag?.description === undefined ? {} : { description: tag.description }),
    status: validation?.status ?? 'unchecked',
    ...(reads === undefined ? {} : { reads }),
    warnings: validation?.warnings ?? [],
    notes: Object.entries(tag?.annotations ?? {}).map(([key, text]) => ({ label: key.replace(/[-_]/g, ' '), text })),
  }
})

export type ProcedureUnitJump<Summary> =
  | { readonly kind: 'run'; readonly summary: Summary }
  | { readonly kind: 'procedure'; readonly procedureId: string }
  | { readonly kind: 'unit' }

/** Where a click on a unit in the strip lands: the open procedure where that unit runs it,
 * else that unit's first active procedure, else the same procedure there, not yet run. */
export const procedureUnitJump = <Summary extends { readonly procedureId: string }>(
  active: ReadonlyArray<Summary>,
  openProcedureId: string | null,
): ProcedureUnitJump<Summary> => {
  const summary = active.find(candidate => candidate.procedureId === openProcedureId) ?? active[0]
  if (summary !== undefined) return { kind: 'run', summary }
  return openProcedureId === null ? { kind: 'unit' } : { kind: 'procedure', procedureId: openProcedureId }
}

/** What a person is told at a transfer into, and on, a document from the archive. */
export const procedureReferenceNotice = 'Reference document, not written for this plant. Limits and equipment names may differ.'

export const procedureViewKey = (document: ProcedureDocument, scope: ProcedureRunScope): string =>
  JSON.stringify([scope.plantId, document.source.sourceId, document.source.revision, document.sourcePath, document.procedureId])

/** The frontmatter category of a document the first correction left as it was. */
const categoryLabels: Readonly<Record<string, string>> = { 'model-scoped simulator task': 'Not revised' }

export const procedureCategories = (procedures: ReadonlyArray<ProcedureCatalogItem>) => {
  const groups = new Map<string, ProcedureCatalogItem[]>()
  for (const procedure of procedures) {
    const category = procedure.category ?? 'Procedures'
    const items = groups.get(category) ?? []
    items.push(procedure)
    groups.set(category, items)
  }
  return [...groups].map(([id, procedures]) => ({ id, label: categoryLabels[id] ?? id.replace(/[-_]/g, ' '), procedures }))
}

const unitText: Readonly<Record<string, string>> = { degC: '°C', degF: '°F', percent: '%', pct: '%' }
const oneDecimalUnits = new Set(['degC', 'degF', '°C', '°F', 'K', '%', 'percent', 'pct'])

/** A number as an operator reads it: one decimal for temperatures and percentages, else up to three significant decimals. */
export const procedureNumberText = (value: number, unit?: string): string => {
  const digits = unit !== undefined && oneDecimalUnits.has(unit) ? 1 : Math.abs(value) >= 100 ? 1 : Math.abs(value) >= 1 ? 2 : 3
  const fixed = Number.isInteger(value) ? String(value)
    : Math.abs(value) < 0.001 ? value.toExponential(2) : value.toFixed(digits)
  return unit === undefined ? fixed : `${fixed} ${unitText[unit] ?? unit}`
}

/** A value as an operator reads it: a two-state signal as On or Off, a number rounded with its unit, a word as written. */
export const procedureReadingText = (value: unknown, unit?: string): string => {
  if (value === undefined || value === null) return 'unavailable'
  if (typeof value === 'boolean') return value ? 'On' : 'Off'
  if (typeof value === 'number') return procedureNumberText(value, unit)
  return unit === undefined ? String(value) : `${String(value)} ${unitText[unit] ?? unit}`
}

const requirementWords: Readonly<Record<string, string>> = { '<': 'below', '<=': 'at most', '>': 'above', '>=': 'at least', '!=': 'not' }

/** A comparison in the words procedure lines use: "above 10 %", "at most 1 %", "Off". */
export const procedureRequirementText = (operator: unknown, expected: unknown, unit?: string): string => {
  const word = typeof operator === 'string' ? requirementWords[operator] : undefined
  const value = procedureReadingText(expected, unit)
  return word === undefined ? value : `${word} ${value}`
}

/** Whether one row of evidence met its comparison, in words. */
export const procedureEvidenceStatusWord = (status: unknown): string =>
  status === 'supported' || status === 'satisfied' ? 'met' : status === 'contradicted' || status === 'challenged' ? 'not met' : 'not established'

/**
 * A reading as the window shows it. Readings arrive formatted ("287.871 degC"); a number with
 * its unit is rewritten to sensible precision ("287.9 °C"), any other reading (a state, a word) stays as written.
 */
export const procedureDisplayReading = (formatted: string): string => {
  const reading = /^(-?\d+(?:\.\d+)?(?:e[-+]?\d+)?)(?: (\S+))?$/i.exec(formatted.trim())
  if (!reading) return formatted
  const value = Number(reading[1])
  return Number.isFinite(value) ? procedureNumberText(value, reading[2]) : formatted
}

/** Plant time since the Plant started, as a status tree reports it ("+01:02:03"). */
export const procedureElapsedText = (elapsedMs: number): string => {
  const seconds = Math.floor(elapsedMs / 1000)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `+${pad(Math.floor(seconds / 3600))}:${pad(Math.floor(seconds / 60) % 60)}:${pad(seconds % 60)}`
}

/** Where the Run is in its document: the step's place over the number of steps. A label can run past it (E-0 labels its last of 19 steps 18). */
export const procedureStepCounterText = (steps: ReadonlyArray<Pick<ProcedureStep, 'id'>>, stepId: string): string =>
  `step ${steps.findIndex(step => step.id === stepId) + 1}/${steps.length}`

/** A procedure's description without its leading Markdown title line, which the window already shows. */
export const procedureDescriptionText = (description: string): string =>
  description.replace(/^\s*#[^\n]*\n+/, '').trim()

/** How a critical safety function chip shows its last status tree result: normal quiet, abnormal loud, lost data never blank. */
export interface ProcedureCsfChip {
  readonly tone: 'green' | 'yellow' | 'orange' | 'red' | 'unknown' | 'not-monitored' | 'pending'
  readonly glyph: string
  readonly label: string
  readonly stale: boolean
  /** The procedure a function that is not green names. */
  readonly procedure?: string
}

/** Where pressing a chip goes: the procedure it names, if it is in the list and not already on screen. */
export const procedureChipTarget = (chip: Pick<ProcedureCsfChip, 'procedure'>, procedures: ReadonlyArray<{ readonly procedureId: string }>, shownProcedureId: string | undefined): string | undefined =>
  chip.procedure !== undefined && chip.procedure !== shownProcedureId && procedures.some(item => item.procedureId === chip.procedure) ? chip.procedure : undefined

const csfGlyphs: Readonly<Record<ProcedureCsfChip['tone'], string>> = {
  green: '●', yellow: '▲', orange: '◆', red: '■', unknown: '?', 'not-monitored': '—', pending: '…',
}

export const procedureCsfChip = (
  id: string,
  evaluation: { readonly label: string; readonly status: Exclude<ProcedureCsfChip['tone'], 'pending'>; readonly procedure?: string | undefined } | undefined,
  stale: boolean,
): ProcedureCsfChip => {
  const tone = evaluation?.status ?? 'pending'
  return { tone, glyph: csfGlyphs[tone], label: evaluation?.label ?? id, stale: evaluation !== undefined && stale, ...(tone === 'green' || evaluation?.procedure === undefined ? {} : { procedure: evaluation.procedure }) }
}

/** What a step's ⓘ heads its tag list with, and the worst binding that colours the ⓘ. */
export const procedureStepBindingSummary = (bindings: ReadonlyArray<ProcedureStepTagBinding>): {
  readonly text: string
  readonly worst: 'none' | 'unchecked' | 'resolved' | 'resolved-with-warnings' | 'missing'
} => {
  const warnings = bindings.filter(binding => binding.status === 'resolved-with-warnings').length
  const missing = bindings.filter(binding => binding.status === 'missing').length
  const unchecked = bindings.filter(binding => binding.status === 'unchecked').length
  const worst = bindings.length === 0 ? 'none' : missing > 0 ? 'missing' : warnings > 0 ? 'resolved-with-warnings' : unchecked > 0 ? 'unchecked' : 'resolved'
  return {
    text: `${bindings.length} ${bindings.length === 1 ? 'tag' : 'tags'} · ${warnings} with warnings · ${missing} missing`,
    worst,
  }
}

export const procedureBindingStatusWord = (status: ProcedureStepTagBinding['status']): string => ({
  resolved: 'Resolved', 'resolved-with-warnings': 'Warnings', missing: 'Missing', unchecked: 'Not checked',
})[status]

/** A status tree comparison as one line: the reading, then its criterion in the reading's unit ("287.9 °C > 280.0 °C"). */
export const procedureComparisonText = (formatted: string, operator?: string, expected?: unknown): string => {
  const reading = procedureDisplayReading(formatted)
  if (operator === undefined) return reading
  const unit = /^-?\d+(?:\.\d+)?(?:e[-+]?\d+)? (\S+)$/i.exec(formatted.trim())?.[1]
  const criterion = typeof expected === 'number' ? procedureNumberText(expected, unit) : String(expected)
  return `${reading} ${operator} ${criterion}`
}
