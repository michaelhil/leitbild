import type {
  ControlInstanceId,
  ProcedureAssessment,
  ProcedureCatalog,
  ProcedureDocument,
  ProcedureRunState,
  ProcedureStepId,
  ProcedureTag,
  ProcedureTagId,
} from '../../core/model/index.ts'
import { queryControlInstancePack, sendControlInstanceCommand } from '../control-instance-client.ts'

export interface ProcedureRunsResponse {
  readonly runs: ReadonlyArray<ProcedureRunState>
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

const readJson = async <T>(response: Response, message: string): Promise<T> => {
  if (!response.ok) throw new Error(`${message}: ${response.status}`)
  return await response.json() as T
}

export const readProcedureCatalog = async (
  controlInstanceId: ControlInstanceId,
  config: { readonly sourceId?: string; readonly refresh?: boolean } = {},
): Promise<ProcedureCatalog> => {
  const params = new URLSearchParams()
  if (config.sourceId) params.set('sourceId', config.sourceId)
  if (config.refresh) params.set('refresh', 'true')
  const suffix = params.size > 0 ? `?${params.toString()}` : ''
  const response = await fetch(`/api/control-instances/${encodeURIComponent(controlInstanceId)}/procedures${suffix}`, { cache: 'no-store' })
  const body = await readJson<{ readonly catalog: ProcedureCatalog }>(response, 'procedure catalog fetch failed')
  return body.catalog
}

export const readProcedureDocument = async (
  controlInstanceId: ControlInstanceId,
  procedureId: string,
  config: { readonly sourceId?: string; readonly refresh?: boolean } = {},
): Promise<ProcedureDocument> => {
  const params = new URLSearchParams()
  if (config.sourceId) params.set('sourceId', config.sourceId)
  if (config.refresh) params.set('refresh', 'true')
  const suffix = params.size > 0 ? `?${params.toString()}` : ''
  const response = await fetch(`/api/control-instances/${encodeURIComponent(controlInstanceId)}/procedures/${encodeURIComponent(procedureId)}${suffix}`, { cache: 'no-store' })
  const body = await readJson<{ readonly procedure: ProcedureDocument }>(response, 'procedure fetch failed')
  return body.procedure
}

export const readProcedureRuns = async (
  controlInstanceId: ControlInstanceId,
): Promise<ProcedureRunsResponse> => {
  const response = await fetch(`/api/control-instances/${encodeURIComponent(controlInstanceId)}/procedure-runs`, { cache: 'no-store' })
  const body = await readJson<{ readonly procedures: ProcedureRunsResponse }>(response, 'procedure runs fetch failed')
  return body.procedures
}

export const startProcedureRun = async (
  controlInstanceId: ControlInstanceId,
  config: { readonly sourceId: string; readonly procedureId: string },
): Promise<void> => {
  const response = await sendControlInstanceCommand(controlInstanceId, {
    kind: 'procedure.run.start',
    targetObjectIds: [],
    payload: config,
  })
  if (!response.result.ok) throw new Error(response.result.reason ?? 'procedure run start rejected')
}

export const updateProcedureStep = async (
  controlInstanceId: ControlInstanceId,
  config: {
    readonly runId: string
    readonly stepId: ProcedureStepId
    readonly assessment?: ProcedureAssessment
    readonly comment?: string
    readonly favorite?: boolean
  },
): Promise<void> => {
  const response = await sendControlInstanceCommand(controlInstanceId, {
    kind: 'procedure.step.update',
    targetObjectIds: [],
    payload: config,
  })
  if (!response.result.ok) throw new Error(response.result.reason ?? 'procedure step update rejected')
}

export const closeProcedureRun = async (
  controlInstanceId: ControlInstanceId,
  config: { readonly runId: string; readonly status: 'completed' | 'abandoned' },
): Promise<void> => {
  const response = await sendControlInstanceCommand(controlInstanceId, {
    kind: 'procedure.run.close',
    targetObjectIds: [],
    payload: config,
  })
  if (!response.result.ok) throw new Error(response.result.reason ?? 'procedure run close rejected')
}

const requireOkPackResult = (value: unknown, message: string): Record<string, unknown> => {
  const response = assertRecord(value, message)
  if (response.ok !== true) throw new Error(typeof response.reason === 'string' ? response.reason : message)
  return assertRecord(response.result, `${message}: missing result`)
}

export const validateProcedureTags = async (
  controlInstanceId: ControlInstanceId,
  systemId: string,
  tags: ReadonlyArray<ProcedureTag>,
): Promise<ReadonlyMap<string, ProcedureTagValidation>> => {
  if (tags.length === 0) return new Map()
  const body = await queryControlInstancePack(controlInstanceId, {
    packId: 'process-plant',
    kind: 'process-plant.procedure-tags.validate',
    payload: {
      systemId,
      tags: tags.map(tag => ({
        id: tag.id,
        ...(tag.description === undefined ? {} : { description: tag.description }),
        ...(tag.simPath === undefined ? {} : { simPath: tag.simPath }),
        ...(tag.units === undefined ? {} : { units: tag.units }),
        ...(tag.equipment === undefined ? {} : { equipment: tag.equipment }),
      })),
    },
  })
  const result = requireOkPackResult(body.response, 'procedure tag validation failed')
  return new Map(assertArray(result.tags, 'procedure tag validation returned no tags').map(item => {
    const row = assertRecord(item, 'procedure tag validation row is malformed')
    const id = assertString(row.id, 'procedure tag validation row requires id')
    const status = assertString(row.status, 'procedure tag validation row requires status')
    return [id, {
      id,
      status: status === 'resolved' || status === 'resolved-with-warnings' ? status : 'missing',
      ...(typeof row.signal === 'object' && row.signal !== null ? { signal: row.signal as Record<string, unknown> } : {}),
      warnings: assertArray(row.warnings, 'procedure tag validation row requires warnings').filter((warning): warning is string => typeof warning === 'string'),
    }]
  }))
}

export const readProcedureTagValue = async (
  controlInstanceId: ControlInstanceId,
  systemId: string,
  tagId: ProcedureTagId,
): Promise<ProcedureTagValue> => {
  const body = await queryControlInstancePack(controlInstanceId, {
    packId: 'process-plant',
    kind: 'process-plant.signals.read',
    payload: {
      systemId,
      signals: [{ tagId }],
    },
  })
  const result = requireOkPackResult(body.response, 'procedure tag read failed')
  const rows = assertArray(result.signals, 'procedure tag read returned no signals')
  const first = assertRecord(rows[0], 'procedure tag read row is malformed')
  const signal = assertRecord(first.signal, 'procedure tag read row requires signal')
  const variable = assertRecord(first.variable, 'procedure tag read row requires variable')
  return {
    tagId,
    label: typeof signal.label === 'string' ? signal.label : tagId,
    value: variable.value,
    formatted: typeof variable.formatted === 'string'
      ? variable.formatted
      : `${String(variable.value)}${typeof signal.unit === 'string' ? ` ${signal.unit}` : ''}`,
    ...(typeof signal.unit === 'string' ? { unit: signal.unit } : {}),
    ...(typeof first.quality === 'string' ? { quality: first.quality } : {}),
    ...(typeof signal.path === 'string' ? { path: signal.path } : {}),
  }
}
