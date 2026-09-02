import {
  procedureRunCloseCommandKind,
  procedureRunResetCommandKind,
  procedureRunStartCommandKind,
  procedureStepUpdateCommandKind,
} from '../../core/model/index.ts'
import type {
  SimulationRunId,
  ProcedureAssessment,
  ProcedureCatalog,
  ProcedureDocument,
  ProcedureRunScope,
  ProcedureRunState,
  ProcedureStepId,
  ProcedureTag,
  ProcedureTagId,
} from '../../core/model/index.ts'
import { invokeSimulationRunCapability, querySimulationRunCapability } from '../simulation-run-client.ts'
import { workspaceApiPath } from '../workspace-context.ts'

export interface ProcedureRunsResponse {
  readonly runs: ReadonlyArray<ProcedureRunState>
}

export interface ProcedureSourceLoadStatus {
  readonly sourceId: string
  readonly label: string
  readonly repository: string
  readonly ref: string
  readonly path: string
  readonly stage: 'idle' | 'listing' | 'loading-documents' | 'ready' | 'failed'
  readonly loadedItems: number
  readonly totalItems?: number
  readonly currentItem?: string
  readonly startedAt?: string
  readonly updatedAt?: string
  readonly completedAt?: string
  readonly cached: boolean
  readonly error?: string
}

export interface ProcedureTagValidation {
  readonly id: string
  readonly status: 'resolved' | 'resolved-with-warnings' | 'missing'
  readonly signal?: Record<string, unknown>
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

export interface ProcedureCsfEvaluation {
  readonly id: string
  readonly label: string
  readonly status: 'satisfied' | 'challenged' | 'unknown'
  readonly reason?: string
  readonly signalCount: number
  readonly signals: ReadonlyArray<ProcedureCsfSignalRead>
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

const readJson = async <T>(response: Response, message: string): Promise<T> => {
  if (!response.ok) throw new Error(`${message}: ${response.status}`)
  return await response.json() as T
}

export const readProcedureCatalog = async (
  simulationRunId: SimulationRunId,
  config: { readonly sourceId?: string; readonly refresh?: boolean } = {},
): Promise<ProcedureCatalog> => {
  const params = new URLSearchParams()
  if (config.sourceId) params.set('sourceId', config.sourceId)
  if (config.refresh) params.set('refresh', 'true')
  const suffix = params.size > 0 ? `?${params.toString()}` : ''
  const response = await fetch(workspaceApiPath(`/simulation-runs/${encodeURIComponent(simulationRunId)}/procedures${suffix}`), { cache: 'no-store' })
  const body = await readJson<{ readonly catalog: ProcedureCatalog }>(response, 'procedure catalog fetch failed')
  return body.catalog
}

export const readProcedureSourceStatus = async (
  simulationRunId: SimulationRunId,
  config: { readonly sourceId?: string } = {},
): Promise<ProcedureSourceLoadStatus> => {
  const params = new URLSearchParams()
  if (config.sourceId) params.set('sourceId', config.sourceId)
  const suffix = params.size > 0 ? `?${params.toString()}` : ''
  const response = await fetch(workspaceApiPath(`/simulation-runs/${encodeURIComponent(simulationRunId)}/procedure-source-status${suffix}`), { cache: 'no-store' })
  const body = await readJson<{ readonly status: ProcedureSourceLoadStatus }>(response, 'procedure source status fetch failed')
  return body.status
}

export const readProcedureDocument = async (
  simulationRunId: SimulationRunId,
  procedureId: string,
  config: { readonly sourceId?: string; readonly refresh?: boolean } = {},
): Promise<ProcedureDocument> => {
  const params = new URLSearchParams()
  if (config.sourceId) params.set('sourceId', config.sourceId)
  if (config.refresh) params.set('refresh', 'true')
  const suffix = params.size > 0 ? `?${params.toString()}` : ''
  const response = await fetch(workspaceApiPath(`/simulation-runs/${encodeURIComponent(simulationRunId)}/procedures/${encodeURIComponent(procedureId)}${suffix}`), { cache: 'no-store' })
  const body = await readJson<{ readonly procedure: ProcedureDocument }>(response, 'procedure fetch failed')
  return body.procedure
}

export const readProcedureRuns = async (
  simulationRunId: SimulationRunId,
): Promise<ProcedureRunsResponse> => {
  const response = await fetch(workspaceApiPath(`/simulation-runs/${encodeURIComponent(simulationRunId)}/procedure-runs`), { cache: 'no-store' })
  const body = await readJson<{ readonly procedures: ProcedureRunsResponse }>(response, 'procedure runs fetch failed')
  return body.procedures
}

export const startProcedureRun = async (
  simulationRunId: SimulationRunId,
  config: { readonly sourceId: string; readonly procedureId: string; readonly scope: ProcedureRunScope },
): Promise<void> => {
  const response = await invokeSimulationRunCapability(simulationRunId, {
    capabilityId: procedureRunStartCommandKind,
    input: config,
  })
  if (response.kind !== 'command') throw new Error(`${procedureRunStartCommandKind} is not a command`)
  if (!response.result.ok) throw new Error(response.result.reason ?? 'procedure run start rejected')
}

export const updateProcedureStep = async (
  simulationRunId: SimulationRunId,
  config: {
    readonly runId: string
    readonly stepId: ProcedureStepId
    readonly assessment?: ProcedureAssessment
    readonly comment?: string
    readonly favorite?: boolean
    readonly currentStepId?: ProcedureStepId
  },
): Promise<void> => {
  const response = await invokeSimulationRunCapability(simulationRunId, {
    capabilityId: procedureStepUpdateCommandKind,
    input: config,
  })
  if (response.kind !== 'command') throw new Error(`${procedureStepUpdateCommandKind} is not a command`)
  if (!response.result.ok) throw new Error(response.result.reason ?? 'procedure step update rejected')
}

export const closeProcedureRun = async (
  simulationRunId: SimulationRunId,
  config: { readonly runId: string; readonly status: 'completed' | 'abandoned' },
): Promise<void> => {
  const response = await invokeSimulationRunCapability(simulationRunId, {
    capabilityId: procedureRunCloseCommandKind,
    input: config,
  })
  if (response.kind !== 'command') throw new Error(`${procedureRunCloseCommandKind} is not a command`)
  if (!response.result.ok) throw new Error(response.result.reason ?? 'procedure run close rejected')
}

export const resetProcedureRun = async (
  simulationRunId: SimulationRunId,
  config: { readonly sourceId: string; readonly procedureId: string; readonly scope: ProcedureRunScope },
): Promise<void> => {
  const response = await invokeSimulationRunCapability(simulationRunId, {
    capabilityId: procedureRunResetCommandKind,
    input: config,
  })
  if (response.kind !== 'command') throw new Error(`${procedureRunResetCommandKind} is not a command`)
  if (!response.result.ok) throw new Error(response.result.reason ?? 'procedure run reset rejected')
}

const normalizedUnit = (value: string): string => value.trim().toLowerCase().replace(/\s/g, '')

const formattedNumber = (value: number, digits: number): string => {
  if (Number.isInteger(value)) return value.toFixed(0)
  if (Math.abs(value) > 0 && Math.abs(value) < 0.001) return value.toExponential(3)
  return value.toFixed(digits)
}

const enumValue = (unit: string, value: number | boolean): string => {
  const options = unit.slice(5, -1).split(',').map(option => option.trim()).filter(Boolean)
  if (typeof value === 'boolean') {
    if (options.includes('RUNNING') || options.includes('STOPPED')) return value ? 'RUNNING' : 'STOPPED'
    if (options.includes('OPEN') || options.includes('CLOSED')) return value ? 'OPEN' : 'CLOSED'
    if (options.includes('ALIGNED') || options.includes('ISOLATED')) return value ? 'ALIGNED' : 'ISOLATED'
    return value ? 'TRUE' : 'FALSE'
  }
  if (options.includes('OPEN') && options.includes('CLOSED')) {
    if (value >= 0.95) return 'OPEN'
    if (value <= 0.05) return 'CLOSED'
    if (options.includes('INTERMEDIATE')) return 'INTERMEDIATE'
  }
  return `${formattedNumber(value * 100, 1)} percent`
}

const procedureSignalValue = (config: {
  readonly requestedUnit?: string
  readonly actualUnit: string
  readonly quantity: string
  readonly value: unknown
}): { readonly value: unknown; readonly formatted: string; readonly unit: string } => {
  const requested = config.requestedUnit
  const unit = requested ?? config.actualUnit
  if (typeof config.value !== 'number' && typeof config.value !== 'boolean') {
    return { value: config.value, formatted: `${String(config.value)} ${unit}`, unit }
  }
  const normalized = requested === undefined ? '' : normalizedUnit(requested)
  if (normalized.startsWith('enum[')) {
    const value = enumValue(requested ?? '', config.value)
    return { value, formatted: value, unit }
  }
  if (typeof config.value === 'boolean') return { value: config.value, formatted: `${String(config.value)} ${unit}`, unit }
  if (normalized === 'degf' && config.actualUnit === 'degC') {
    const value = config.quantity === 'temperatureDelta' ? config.value * 9 / 5 : config.value * 9 / 5 + 32
    return { value, formatted: `${formattedNumber(value, 1)} degF`, unit }
  }
  if (normalized === 'gpm' && config.actualUnit === 'kg/s') {
    const value = config.value * 15.850323
    return { value, formatted: `${formattedNumber(value, 1)} gpm`, unit }
  }
  if (normalized === 'psig' && config.actualUnit === 'MPa') {
    const value = config.value * 145.037738 - 14.6959
    return { value, formatted: `${formattedNumber(value, 1)} psig`, unit }
  }
  if (normalized === 'psig' && config.actualUnit === 'Pa') {
    const value = config.value * 0.000145037738 - 14.6959
    return { value, formatted: `${formattedNumber(value, 1)} psig`, unit }
  }
  if (normalized === 'inhga' && config.actualUnit === 'Pa') {
    const value = config.value * 0.000295299875
    return { value, formatted: `${formattedNumber(value, 2)} inHgA`, unit }
  }
  if (normalized === 'steps_withdrawn' && config.actualUnit === 'fraction') {
    const value = Math.max(0, Math.min(1, 1 - config.value)) * 228
    return { value, formatted: `${formattedNumber(value, 0)} steps withdrawn`, unit }
  }
  const suffix = normalized === 'percent_collapsed_liquid' ? 'percent collapsed liquid' : unit
  return { value: config.value, formatted: `${formattedNumber(config.value, 3)} ${suffix}`, unit }
}

const queryProcedureSignal = async (
  simulationRunId: SimulationRunId,
  plantId: string,
  tagId: string,
  read: boolean,
): Promise<Record<string, unknown> | null> => {
  const result = assertRecord(await querySimulationRunCapability(
    simulationRunId,
    read ? 'world.process-plant.signals.read' : 'world.process-plant.signals.resolve',
    { plantId, signals: [{ tagId }] },
  ), 'process signal query returned no result')
  const first = assertArray(result.signals, 'process signal query returned no signals')[0]
  return first === undefined ? null : assertRecord(first, 'process signal query returned malformed signal')
}

export const validateProcedureTags = async (
  simulationRunId: SimulationRunId,
  plantId: string,
  tags: ReadonlyArray<ProcedureTag>,
): Promise<ReadonlyMap<string, ProcedureTagValidation>> => {
  if (tags.length === 0) return new Map()
  const result = assertRecord(await querySimulationRunCapability(
    simulationRunId,
    'world.process-plant.procedure-tags.validate',
    { plantId, tags },
  ), 'procedure tag validation returned a malformed result')
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
    return [id, {
      id,
      status,
      ...(signal === null ? {} : { signal }),
      warnings,
    }]
  })
  return new Map(rows)
}

export const readProcedureTagValue = async (
  simulationRunId: SimulationRunId,
  plantId: string,
  tag: ProcedureTag,
): Promise<ProcedureTagValue> => {
  const first = await queryProcedureSignal(simulationRunId, plantId, tag.id, true)
  if (first === null) throw new Error('not resolved to a Leitbild signal')
  const signal = assertRecord(first.signal, 'procedure tag read row requires signal')
  const variable = assertRecord(first.variable, 'procedure tag read row requires variable')
  const actualUnit = assertString(signal.unit, 'process signal requires unit')
  const procedureValue = procedureSignalValue({
    ...(tag.units === undefined ? {} : { requestedUnit: tag.units }),
    actualUnit,
    quantity: assertString(signal.quantity, 'process signal requires quantity'),
    value: variable.value,
  })
  const quality = optionalRecord(first.quality)
  return {
    tagId: tag.id,
    label: typeof signal.label === 'string' ? signal.label : tag.id,
    value: procedureValue.value,
    formatted: procedureValue.formatted,
    unit: procedureValue.unit,
    ...(typeof quality?.status === 'string' ? { quality: quality.status } : {}),
    ...(typeof signal.path === 'string' ? { path: signal.path } : {}),
  }
}

const parseProcedureCsfSignalRead = (value: unknown): ProcedureCsfSignalRead => {
  const row = assertRecord(value, 'procedure CSF signal read row is malformed')
  const signal = assertRecord(row.signal, 'procedure CSF signal read row requires signal')
  const variable = assertRecord(row.variable, 'procedure CSF signal read row requires variable')
  const comparison = optionalRecord(row.comparison)
  const tagId = stringOrUndefined(signal.tagId)
  const label = stringOrUndefined(signal.label) ?? tagId ?? stringOrUndefined(variable.path) ?? 'plant signal'
  const path = stringOrUndefined(signal.path) ?? stringOrUndefined(variable.path)
  const unit = stringOrUndefined(signal.unit) ?? stringOrUndefined(variable.unit)
  const formatted = formatSignalValue(variable.value, unit)
  const operator = stringOrUndefined(comparison?.operator)
  return {
    id: tagId ?? path ?? label,
    label,
    ...(path === undefined ? {} : { path }),
    formatted,
    ...(operator === undefined ? {} : { operator }),
    ...(comparison !== null && 'value' in comparison ? { expected: comparison.value } : {}),
    ...(typeof comparison?.matches === 'boolean' ? { matches: comparison.matches } : {}),
  }
}

export const evaluateProcedureCsfs = async (
  simulationRunId: SimulationRunId,
  plantId: string,
  csfs: ReadonlyArray<string>,
): Promise<ReadonlyMap<string, ProcedureCsfEvaluation>> => {
  if (csfs.length === 0) return new Map()
  const result = assertRecord(await querySimulationRunCapability(
    simulationRunId,
    'world.process-plant.assessments.evaluate',
    {
      plantId,
      assessmentIds: csfs,
    },
  ), 'procedure CSF evaluation returned a malformed result')
  return new Map(assertArray(result.assessments, 'procedure CSF evaluation returned no statuses').map(item => {
    const row = assertRecord(item, 'procedure CSF row is malformed')
    const id = assertString(row.id, 'procedure CSF row requires id')
    const label = assertString(row.title, 'procedure CSF row requires title')
    const status = assertString(row.status, 'procedure CSF row requires status')
    const signalsRead = assertArray(row.signalsRead, 'procedure CSF row requires signalsRead')
    const signals = signalsRead.map(parseProcedureCsfSignalRead)
    return [id, {
      id,
      label,
      status: status === 'satisfied' || status === 'challenged' ? status : 'unknown',
      ...(typeof row.reason === 'string' ? { reason: row.reason } : {}),
      signalCount: signals.length,
      signals,
    }]
  }))
}
