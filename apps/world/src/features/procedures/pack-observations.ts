import { isoTimestampSchema, type IsoTimestamp, type ProcedureTag, type ProcedureTagId } from '../../core/model/index.ts'
import type { ProcedureDecisionObservation } from '@leitbild/procmd'
import type { PackProcedureContribution, PackProcedureQuery } from '../../core/packs/protocol.ts'

// The wire semantics every Pack's procedure observations keep (protocol.ts
// PackProcedure*Result), validated once for the procedure window and for
// World's own procedure reads. A malformed row is an error, never a guess.

export interface ProcedureTagValidation {
  readonly id: string
  readonly status: 'resolved' | 'resolved-with-warnings' | 'missing'
  readonly signal?: Record<string, unknown>
  /** The declared element (its observation declaration's id) the tag is measured on, where it names one: the tag opens its default. */
  readonly measuredOn?: string
  readonly warnings: ReadonlyArray<string>
}

export interface ProcedureTagValue {
  readonly tagId: ProcedureTagId
  readonly label: string
  readonly value: unknown
  readonly formatted: string
  readonly unit?: string
  readonly quality?: string
  readonly path?: string
  readonly writable?: boolean
  readonly scopeId?: string
  readonly signalTagId?: string
  readonly evidence?: { readonly kind: 'instrument' | 'engineering-diagnostic'; readonly sampledAt: IsoTimestamp; readonly provenance: string; readonly modelRef?: string; readonly modelDigest?: string; readonly automationRef?: string; readonly automationDigest?: string }
  readonly conversionStatus?: 'native' | 'converted' | 'unavailable'
  readonly warning?: string
}

export interface ProcedureCsfSignalRead {
  readonly id: string
  readonly label: string
  readonly path?: string
  readonly formatted: string
  readonly operator?: string
  readonly expected?: unknown
  readonly matches?: boolean
}

/** A status tree's colour, unknown where a reading it needs is not available, or not judged in the Plant's state. */
export type ProcedureCsfStatus = 'green' | 'yellow' | 'orange' | 'red' | 'unknown' | 'not-monitored'
const procedureCsfStatuses: ReadonlyArray<ProcedureCsfStatus> = ['green', 'yellow', 'orange', 'red', 'unknown', 'not-monitored']

// The criteria a provider may judge a colour by: its own reference-model
// status trees, or a qualified plant criterion. A row naming neither is shown
// unknown, whatever colour it reports.
const judgedCriteria = new Set(['reference-model-criteria', 'qualified-criterion'])

export interface ProcedureCsfEvaluation {
  readonly id: string
  readonly label: string
  readonly status: ProcedureCsfStatus
  /** The function restoration procedure the colour sends operators to. */
  readonly procedure?: string
  readonly reason?: string
  readonly signalCount: number
  readonly signals: ReadonlyArray<ProcedureCsfSignalRead>
  readonly qualification: string
  readonly simTimeMs?: number
  readonly modelRef?: string
  readonly modelDigest?: string
}

const assertRecord = (value: unknown, message: string): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(message)
  return value as Record<string, unknown>
}

const assertArray = (value: unknown, message: string): ReadonlyArray<unknown> => {
  if (!Array.isArray(value)) throw new Error(message)
  return value
}

const assertString = (value: unknown, message: string): string => {
  if (typeof value !== 'string' || value.length === 0) throw new Error(message)
  return value
}

const optionalRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null

const stringOrUndefined = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined

const formatSignalValue = (
  value: unknown,
  unit: string | undefined,
): string =>
  `${String(value)}${unit === undefined ? '' : ` ${unit}`}`

const formattedNumber = (value: number, digits: number): string => {
  if (Number.isInteger(value)) return value.toFixed(0)
  if (Math.abs(value) > 0 && Math.abs(value) < 0.001) return value.toExponential(3)
  return value.toFixed(digits)
}

/** A PackProcedureTagValidationResult, keyed by tag id. */
export const parseProcedureTagValidations = (raw: unknown): ReadonlyMap<string, ProcedureTagValidation> => {
  const result = assertRecord(raw, 'procedure tag validation returned a malformed result')
  const rows = assertArray(result.tags, 'procedure tag validation returned no tags').map((value): readonly [string, ProcedureTagValidation] => {
    const row = assertRecord(value, 'procedure tag validation row is malformed')
    const id = assertString(row.id, 'procedure tag validation row requires id')
    const status = assertString(row.status, 'procedure tag validation row requires status')
    if (status !== 'resolved' && status !== 'resolved-with-warnings' && status !== 'missing') {
      throw new Error(`procedure tag validation returned unsupported status: ${status}`)
    }
    const warnings = assertArray(row.warnings, 'procedure tag validation row requires warnings').map(warning =>
      assertString(warning, 'procedure tag validation warning must be a string'),
    )
    const signal = optionalRecord(row.signal)
    const measuredOn = row.measuredOn === undefined ? undefined : assertString(row.measuredOn, 'procedure tag validation measuredOn must be a non-empty string')
    if (measuredOn !== undefined && status === 'missing') throw new Error(`procedure tag validation row ${id} is missing but names equipment`)
    return [id, {
      id,
      status,
      ...(signal === null ? {} : { signal }),
      ...(measuredOn === undefined ? {} : { measuredOn }),
      warnings,
    }]
  })
  return new Map(rows)
}

/** The first observation of a PackProcedureSignalReadResult for one tag, in the unit the tag requests where it declares one. */
export const parseProcedureTagValue = (tag: ProcedureTag, raw: unknown): ProcedureTagValue => {
  const result = assertRecord(raw, 'procedure signal query returned no result')
  const listed = assertArray(result.signals, 'procedure signal query returned no signals')[0]
  if (listed === undefined) throw new Error('not resolved to a Leitbild signal')
  const first = assertRecord(listed, 'procedure signal query returned malformed signal')
  const signal = assertRecord(first.signal, 'procedure tag read row requires signal')
  const variable = assertRecord(first.variable, 'procedure tag read row requires variable')
  if (typeof signal.tagId === 'string' && signal.tagId !== tag.id) throw new Error(`procedure signal identity ${signal.tagId} does not match requested tag ${tag.id}`)
  if (typeof signal.path === 'string' && typeof variable.path === 'string' && signal.path !== variable.path) throw new Error('procedure signal and variable paths disagree')
  let unit = assertString(signal.unit, 'procedure signal requires unit')
  if (variable.unit !== undefined && variable.unit !== unit) throw new Error('procedure signal and variable native units disagree')
  if (typeof variable.writable === 'boolean' && typeof signal.writable === 'boolean' && variable.writable !== signal.writable) throw new Error('procedure signal and variable writability disagree')
  let value = variable.value
  let conversionStatus: ProcedureTagValue['conversionStatus']
  let warning: string | undefined
  if (tag.units !== undefined) {
    // Unit semantics belong to the runtime. A missing projection is a malformed
    // response, not permission for a reader to infer or relabel a value.
    const view = assertRecord(first.valueView, 'requested-unit signal read requires valueView')
    const status = view.status
    if (status !== 'native' && status !== 'converted' && status !== 'unavailable') throw new Error('signal valueView has unsupported status')
    if (view.requestedUnit !== tag.units.trim()) throw new Error('signal valueView does not match requested unit')
    const viewUnit = assertString(view.unit, 'signal valueView requires unit')
    if (status !== 'converted' && (viewUnit !== unit || view.value !== value)) throw new Error('native or unavailable signal valueView must preserve raw value and unit')
    if (status === 'converted' && viewUnit !== view.requestedUnit) throw new Error('converted signal valueView has unexpected unit')
    if (status === 'unavailable') warning = assertString(view.reason, 'unavailable signal valueView requires reason')
    unit = viewUnit
    value = view.value
    conversionStatus = status
  }
  if (typeof value !== 'boolean' && (typeof value !== 'number' || !Number.isFinite(value))) throw new Error('procedure signal requires a finite number or boolean value')
  const quality = optionalRecord(first.quality)
  const rawEvidence = optionalRecord(first.evidence)
  let evidence: ProcedureTagValue['evidence']
  if (rawEvidence !== null) {
    if (rawEvidence.kind !== 'instrument' && rawEvidence.kind !== 'engineering-diagnostic') throw new Error('procedure signal evidence kind is unestablished')
    const sampledAt = isoTimestampSchema.parse(rawEvidence.sampledAt)
    evidence = { kind: rawEvidence.kind, sampledAt, provenance: assertString(rawEvidence.provenance, 'procedure signal evidence requires provenance'),
      ...(typeof rawEvidence.modelRef === 'string' ? { modelRef: rawEvidence.modelRef } : {}), ...(typeof rawEvidence.modelDigest === 'string' ? { modelDigest: rawEvidence.modelDigest } : {}),
      ...(typeof rawEvidence.automationRef === 'string' ? { automationRef: rawEvidence.automationRef } : {}), ...(typeof rawEvidence.automationDigest === 'string' ? { automationDigest: rawEvidence.automationDigest } : {}) }
  }
  return {
    tagId: tag.id,
    ...(typeof result.plantId === 'string' ? { scopeId: result.plantId } : {}),
    ...(typeof signal.tagId === 'string' ? { signalTagId: signal.tagId } : {}),
    ...(evidence === undefined ? {} : { evidence }),
    label: typeof signal.label === 'string' ? signal.label : tag.id,
    value,
    formatted: formatSignalValue(typeof value === 'number' ? formattedNumber(value, 3) : value, unit),
    unit,
    ...(conversionStatus === undefined ? {} : { conversionStatus }),
    ...(warning === undefined ? {} : { warning }),
    ...(typeof quality?.status === 'string' ? { quality: quality.status } : {}),
    ...(typeof signal.path === 'string' ? { path: signal.path } : {}),
    ...(typeof signal.writable === 'boolean' ? { writable: signal.writable } : {}),
  }
}

// One comparison a status tree made: the reading (or the total or difference
// of several) against its threshold, and whether it held.
const parseProcedureCsfComparison = (value: unknown): ProcedureCsfSignalRead => {
  const row = assertRecord(value, 'procedure CSF comparison is malformed')
  const reads = assertArray(row.reads, 'procedure CSF comparison requires reads').map(read => assertRecord(read, 'procedure CSF reading is malformed'))
  const names = reads.map(read => assertString(read.signal, 'procedure CSF reading requires signal'))
  const combines = row.combines === 'total' || row.combines === 'difference' ? row.combines : undefined
  const unit = stringOrUndefined(row.unit)
  const measured = combines === undefined ? reads[0]?.value : row.measured
  const label = combines === 'total' ? `Total of ${names.join(', ')}` : combines === 'difference' ? names.join(' − ') : stringOrUndefined(reads[0]?.label) ?? names[0] ?? 'signal'
  const operator = assertString(row.operator, 'procedure CSF comparison requires operator')
  const path = combines === undefined ? stringOrUndefined(reads[0]?.path) : undefined
  return {
    id: `${names.join('|')} ${operator} ${String(row.threshold)}`,
    label,
    ...(path === undefined ? {} : { path }),
    formatted: measured === undefined ? 'unavailable' : formatSignalValue(typeof measured === 'number' ? formattedNumber(measured, 3) : measured, unit),
    operator,
    expected: row.threshold,
    ...(row.answer === 'yes' ? { matches: true } : row.answer === 'no' ? { matches: false } : {}),
  }
}

/** A PackProcedureAssessmentResult as critical safety function colours, keyed by function id. */
export const parseProcedureCsfEvaluations = (raw: unknown): ReadonlyMap<string, ProcedureCsfEvaluation> => {
  const result = assertRecord(raw, 'procedure CSF evaluation returned a malformed result')
  return new Map(assertArray(result.assessments, 'procedure CSF evaluation returned no statuses').map(item => {
    const row = assertRecord(item, 'procedure CSF row is malformed')
    const id = assertString(row.id, 'procedure CSF row requires id')
    const label = assertString(row.title, 'procedure CSF row requires title')
    const status = assertString(row.status, 'procedure CSF row requires status') as ProcedureCsfStatus
    if (!procedureCsfStatuses.includes(status)) throw new Error(`procedure CSF row has unsupported status: ${status}`)
    const steps = assertArray(row.path, 'procedure CSF row requires its path').map(step => assertRecord(step, 'procedure CSF path step is malformed'))
    const compared = steps.flatMap(step => assertArray(step.comparisons, 'procedure CSF path step requires comparisons').map(parseProcedureCsfComparison))
    const signals = [...new Map(compared.map(signal => [signal.id, signal])).values()]
    const qualification = stringOrUndefined(row.qualification) ?? 'not-established'
    const judged = judgedCriteria.has(qualification)
    const coloured = status !== 'unknown' && status !== 'not-monitored'
    const procedure = judged && coloured ? stringOrUndefined(row.procedure) : undefined
    return [id, {
      id,
      label,
      status: judged || !coloured ? status : 'unknown',
      ...(procedure === undefined ? {} : { procedure }),
      ...(!judged && coloured ? { reason: 'Assessment criterion qualification is not established.' } : typeof row.meaning === 'string' ? { reason: row.meaning } : {}),
      signalCount: signals.length,
      signals,
      qualification,
      ...(typeof row.simTimeMs === 'number' && Number.isFinite(row.simTimeMs) ? { simTimeMs: row.simTimeMs } : {}),
      ...(typeof row.modelRef === 'string' ? { modelRef: row.modelRef } : {}),
      ...(typeof row.modelDigest === 'string' ? { modelDigest: row.modelDigest } : {}),
    }]
  }))
}

/** One procedure scope's observations, read through the scope's owning Pack. */
export interface ProcedureObservationPort {
  readonly validateTags: (tags: ReadonlyArray<ProcedureTag>) => Promise<ReadonlyMap<string, ProcedureTagValidation>>
  readonly readTag: (tag: ProcedureTag) => Promise<ProcedureTagValue>
  /** A single owning-Pack acquisition for all declared tags. */
  readonly readTags: (tags: ReadonlyArray<ProcedureTag>) => Promise<ReadonlyMap<string, ProcedureTagValue | Error>>
  readonly readObservation: (binding: ProcedureDecisionObservation) => Promise<Readonly<Record<string, unknown>>>
  readonly evaluateCsfs: (assessmentIds: ReadonlyArray<string>) => Promise<ReadonlyMap<string, ProcedureCsfEvaluation>>
}

/** `query` invokes the Pack's declared read Capability as the caller, so the caller's restrictions apply. */
export const createProcedureObservationPort = (config: {
  readonly scopeId: string
  readonly provider: PackProcedureContribution
  readonly query: (query: PackProcedureQuery) => Promise<unknown>
}): ProcedureObservationPort => {
  const readTags: ProcedureObservationPort['readTags'] = async tags => {
    if (tags.length === 0) return new Map()
    const raw = assertRecord(await config.query(config.provider.signalReadQuery(config.scopeId, tags)), 'procedure signal query returned no result')
    const rows = assertArray(raw.signals, 'procedure signal query returned no signals').map(row => assertRecord(row, 'procedure signal row is malformed'))
    const requested = new Set(tags.map(tag => tag.id))
    const keyed = new Map<string, Record<string, unknown>>()
    for (const row of rows) {
      const signal = assertRecord(row.signal, 'procedure signal row requires signal')
      const id = assertString(signal.tagId, 'procedure signal row requires canonical tagId')
      if (!requested.has(id) || keyed.has(id)) throw new Error(`procedure signal query returned unexpected or duplicated identity ${id}`)
      keyed.set(id, row)
    }
    return new Map<string, ProcedureTagValue | Error>(tags.map(tag => {
      try {
        const row = keyed.get(tag.id)
        if (row === undefined) throw new Error(`procedure signal query omitted ${tag.id}`)
        return [tag.id, parseProcedureTagValue(tag, { ...raw, signals: [row] })] as const
      } catch (error) { return [tag.id, error instanceof Error ? error : new Error(String(error))] as const }
    }))
  }
  return {
    validateTags: async tags => tags.length === 0
      ? new Map()
      : parseProcedureTagValidations(await config.query(config.provider.tagValidationQuery(config.scopeId, tags))),
    readTags,
    readObservation: async binding => assertRecord(await config.query({ capabilityId: binding.capabilityId, input: { ...binding.input, targetObjectId: config.scopeId } }), 'procedure decision query returned malformed evidence'),
    readTag: async tag => {
      const value = (await readTags([tag])).get(tag.id)
      if (value instanceof Error) throw value
      if (value === undefined) throw new Error(`procedure signal query omitted ${tag.id}`)
      return value
    },
    evaluateCsfs: async assessmentIds => assessmentIds.length === 0
      ? new Map()
      : parseProcedureCsfEvaluations(await config.query(config.provider.assessmentsQuery(config.scopeId, assessmentIds))),
  }
}

/** One procedure tag as World read it on a plant: its binding, and its value or why there is none. */
export interface ProcedureTagRead {
  readonly tagId: string
  /** unchecked: the Pack could not validate it now. */
  readonly binding: 'resolved' | 'resolved-with-warnings' | 'missing' | 'unchecked'
  readonly warnings: ReadonlyArray<string>
  readonly value?: ProcedureTagValue
  /** Why there is no value. */
  readonly unavailable?: string
}

const failureText = (error: unknown): string => error instanceof Error ? error.message : String(error)

/**
 * Validates and reads tags of a procedure document on its scope, through the
 * scope's Pack. A tag the document does not declare, the plant lacks or the
 * Pack cannot read now comes back with its reason, never dropped.
 */
export const readProcedureTags = async (config: {
  readonly observations: () => ProcedureObservationPort
  readonly declared: ReadonlyArray<ProcedureTag>
  readonly tagIds: ReadonlyArray<string>
}): Promise<ReadonlyArray<ProcedureTagRead>> => {
  const tags = config.tagIds.map(tagId => config.declared.find(tag => tag.id === tagId))
  let port: ProcedureObservationPort | undefined
  let validations: ReadonlyMap<string, ProcedureTagValidation> = new Map()
  let failure: string | undefined
  try {
    port = config.observations()
    validations = await port.validateTags(tags.filter((tag): tag is ProcedureTag => tag !== undefined))
  } catch (error) { failure = failureText(error) }
  let values: ReadonlyMap<string, ProcedureTagValue | Error> = new Map()
  if (failure === undefined && port !== undefined) {
    const readable = tags.filter((tag): tag is ProcedureTag => tag !== undefined && validations.get(tag.id)?.status !== 'missing')
    try { values = await port.readTags(readable) }
    catch (error) { failure = failureText(error) }
  }
  return config.tagIds.map((tagId, index): ProcedureTagRead => {
    const tag = tags[index]
    if (tag === undefined) return { tagId, binding: 'missing', warnings: [], unavailable: 'not declared in the procedure document' }
    const validation = validations.get(tagId)
    if (validation?.status === 'missing') return { tagId, binding: 'missing', warnings: validation.warnings, unavailable: 'procedure tag is not bound to this Plant' }
    if (failure !== undefined || port === undefined) return { tagId, binding: validation?.status ?? 'unchecked', warnings: validation?.warnings ?? [], unavailable: failure ?? 'no observation port' }
    if (validation === undefined) return { tagId, binding: 'unchecked', warnings: [], unavailable: 'the Pack did not validate this tag' }
    const value = values.get(tagId)
    return value === undefined || value instanceof Error
      ? { tagId, binding: validation.status, warnings: validation.warnings, unavailable: value instanceof Error ? value.message : 'the Pack did not return this tag' }
      : { tagId, binding: validation.status, warnings: validation.warnings, value }
  })
}

const evidenceReadingLength = 160

/** A read as a decision records it: a two-state value names its model variable ("reactorTripBreakerA.closed = false"),
 * any other its formatted value, with quality when not good; or why there was none. The binding's
 * conversion note stays with the step's binding, not in every recorded reading. */
export const procedureEvidenceReadingText = (read: ProcedureTagRead): string => {
  const text = read.value !== undefined
    ? [
        typeof read.value.value === 'boolean' && read.value.path !== undefined ? `${read.value.path} = ${String(read.value.value)}` : read.value.formatted,
        ...(read.value.quality === undefined || read.value.quality === 'good' ? [] : [`quality ${read.value.quality}`]),
      ].join('; ')
    : `${read.binding === 'missing' ? 'missing' : 'unavailable'}: ${read.unavailable ?? 'no value'}`
  return text.length <= evidenceReadingLength ? text : `${text.slice(0, evidenceReadingLength - 1)}…`
}
