import { z } from 'zod'
import { objectIdSchema, recordingSeriesIdFor, type IsoTimestamp, type RecordedSample } from '../../core/model/index.ts'
import { recordedHoldMs, relativeDeadband } from '../../features/historian/policy.ts'
import type { PackRuntimeRecordedHistory } from '../../simulation/protocol.ts'
import { processUnitSchema } from './graph/index.ts'
import { processPlantEvidenceFrame } from './evidence-frame.ts'
import { evaluateProcessPlantProcedureCondition, processPlantProcedureBasisSchema, processPlantProcedureConditionSchema } from './condition-evidence.ts'
import type { ProcessPlantRuntimeInstance } from './runtime-instance.ts'
import { processPlantSignalQuality, processPlantSignalReferenceSchema, readableProcessPlantSignalBinding, type ProcessPlantSignalQuality } from './signals.ts'
import { processPlantSimRuntimeId } from './sim/constants.ts'
import { processPlantEvidenceSignal, processPlantEvidenceVariable, encodeProcessPlantSampleTimeRuns, type ProcessPlantEvidenceVariable } from './procedure-evidence-facts.ts'
import { processPlantResponseStartSchema, startingResponseCondition, startingResponseReading } from './response-start.ts'

const numericOperator = z.enum(['<', '<=', '==', '!=', '>=', '>'])
export const processPlantResponseQuerySchema = z.object({
  targetObjectId: objectIdSchema,
  basis: processPlantProcedureBasisSchema,
  condition: processPlantProcedureConditionSchema.describe('Current read-only prerequisites, reacquired with this response. A recorded response never replaces current physical feedback.'),
  windowSeconds: z.number().finite().positive().describe('Required elapsed simulation-time observation window. Its engineering source must justify the exercise window; pause does not accumulate it.'),
  startingObservation: processPlantResponseStartSchema.optional().describe('Original native starting acquisition supplied by the pinned procedure transition. Evaluate its entire interval through now, never a replacement rolling window.'),
  startingCondition: processPlantProcedureConditionSchema.optional().describe('Authored starting prerequisites evaluated from the retained original acquisition; independent of the required ending condition.'),
  unchangedSettings: z.array(z.object({ signal: processPlantSignalReferenceSchema, unit: processUnitSchema }).strict()).min(1).max(128).optional()
    .describe('Configuration must match its original acquisition, retained configuration samples and latest accepted person/AI operation identity. Configuration is not physical response.'),
  afterOperations: z.array(z.object({ signal: processPlantSignalReferenceSchema, value: z.union([z.number().finite(), z.boolean()]), unit: processUnitSchema }).strict()).min(1).optional()
    .describe('Optional command-relative response: the latest retained accepted operation on EACH exact control must match this value/unit and the current control value. Historical samples before the latest required receipt cannot qualify. Accepted commands do not prove achieved response.'),
  comparisons: z.array(z.object({
    signal: processPlantSignalReferenceSchema,
    statistic: z.enum(['minimum', 'maximum', 'change']).describe('Stored numeric sample minimum/maximum, including current acquisition, or current minus the retained left-boundary sample. No interpolation or uninterrupted-hold claim.'),
    operator: numericOperator,
    value: z.number().finite(),
    unit: processUnitSchema,
  }).strict()).min(1),
}).strict().superRefine((input, context) => {
  if (input.startingObservation !== undefined && input.afterOperations !== undefined) context.addIssue({ code: 'custom', message: 'Use one response origin: an original observation or accepted control operations.' })
})

type Status = 'satisfied' | 'challenged' | 'unknown'
const compare = (actual: number, operator: z.infer<typeof numericOperator>, expected: number): boolean =>
  operator === '<' ? actual < expected : operator === '<=' ? actual <= expected : operator === '==' ? actual === expected
    : operator === '!=' ? actual !== expected : operator === '>=' ? actual >= expected : actual > expected
const combine = (statuses: ReadonlyArray<Status>): Status => statuses.includes('challenged') ? 'challenged' : statuses.includes('unknown') ? 'unknown' : 'satisfied'

/**
 * An explicitly sampled response from the existing exception record. It neither
 * interpolates silent periods nor promotes stored samples to continuous proof.
 * The current physical frame and retained samples are independently visible.
 */
export const evaluateProcessPlantResponse = (config: {
  readonly plant: ProcessPlantRuntimeInstance
  readonly input: z.infer<typeof processPlantResponseQuerySchema>
  readonly simulationTime?: IsoTimestamp
  readonly recordingIntervalMs?: number
  readonly recordedSeriesIds?: ReadonlySet<string>
  readonly recordedHistory?: PackRuntimeRecordedHistory
}) => {
  const { plant, input } = config
  const identity = { targetObjectId: input.targetObjectId, ...processPlantEvidenceFrame(plant, config.simulationTime), simTimeMs: plant.runtime.elapsedMs(),
    basis: { ...input.basis, qualification: 'sampled-model-response' as const }, automaticCsfQualified: false as const,
    interpretation: 'Stored-sample envelope and endpoint change only; no uninterrupted hold, instrument qualification, future capacity or recovery claim.' }
  const acquired = evaluateProcessPlantProcedureCondition({ plant, condition: input.condition, basis: input.basis, ...(config.simulationTime === undefined ? {} : { simulationTime: config.simulationTime }) })
  // Point and temporal queries share the same explicit deciding-facts DTO.
  const current = { targetObjectId: input.targetObjectId, ...acquired }
  const evidence: Array<Record<string, unknown>> = []
  const recordings: Array<Record<string, unknown>> = []
  const anchors: Array<Record<string, unknown>> = []
  const currentFrameApplies = input.targetObjectId === plant.plant.id && input.basis.modelRef === plant.plant.modelRef && input.basis.modelDigest === plant.plant.modelDigest
  const failure = (reason: string) => {
    const challenged = currentFrameApplies && current.status === 'challenged'
    return { ...identity, status: challenged ? 'challenged' as const : 'unknown' as const,
      reason: challenged ? `Current physical prerequisites are challenged. ${reason}` : reason, current, evidence, recordings, afterOperations: anchors }
  }
  if (input.targetObjectId !== plant.plant.id) return failure('Response target does not match the answering Plant.')
  if (input.basis.modelRef !== plant.plant.modelRef || input.basis.modelDigest !== plant.plant.modelDigest) return failure('Response basis does not match the current Plant model and digest.')
  const now = config.simulationTime === undefined ? Number.NaN : Date.parse(config.simulationTime)
  const interval = config.recordingIntervalMs
  if (!Number.isFinite(now) || interval === undefined || !Number.isSafeInteger(interval) || interval <= 0 || config.recordedHistory === undefined || config.recordedSeriesIds === undefined) {
    return failure('Run simulation time and an active Plant recording/history selection are required.')
  }
  const original = input.startingObservation
  if (original !== undefined) {
    const age = now - Date.parse(original.simulationTime), integratedAge = plant.runtime.elapsedMs() - original.simTimeMs
    if (original.targetObjectId !== input.targetObjectId || original.status !== 'satisfied'
      || original.modelRef !== identity.modelRef || original.modelDigest !== identity.modelDigest
      || original.automationRef !== identity.automationRef || original.automationDigest !== identity.automationDigest
      || !Number.isFinite(age) || age < 0 || integratedAge < 0 || Math.abs(age - integratedAge) > plant.plant.graph.timestep.fixedStepMs + 1) {
      return failure('The original starting observation does not establish this Plant, model, I&C configuration and advancing simulation-time trajectory.')
    }
    if (age < input.windowSeconds * 1000 || integratedAge < input.windowSeconds * 1000) return failure('The required response duration has not elapsed since the original starting observation.')
    if (input.startingCondition === undefined) return failure('An original starting observation requires its authored starting condition.')
    try {
      if (startingResponseCondition(original, input.startingCondition, plant.plant.graph) !== 'satisfied') return failure('The original acquisition does not establish every authored starting prerequisite.')
    } catch (error) { return failure(error instanceof Error ? error.message : String(error)) }
  }
  if (input.unchangedSettings !== undefined && original === undefined) return failure('Unchanged configuration requires the original starting observation.')
  const start = original === undefined ? now - input.windowSeconds * 1000 : Date.parse(original.simulationTime)
  const durationMs = now - start
  const fromMs = start - recordedHoldMs - interval
  const limit = Math.ceil((durationMs + recordedHoldMs + interval) / interval) + 2
  if (!Number.isSafeInteger(Math.ceil(durationMs)) || !Number.isSafeInteger(limit) || !Number.isFinite(new Date(fromMs).getTime())) return failure('The requested response window cannot be represented in simulation time.')
  if (durationMs > plant.runtime.elapsedMs()) return failure('The Plant has not accumulated the requested elapsed simulation-time response window.')
  let notBeforeElapsedMs = 0
  for (const anchor of input.afterOperations ?? []) {
    const binding = readableProcessPlantSignalBinding(plant.plant.graph, anchor.signal)
    const latest = plant.operations?.latest(binding.path)
    if (!binding.writable || binding.unit !== anchor.unit || latest === undefined || latest.value !== anchor.value || latest.kind === 'ramp'
      || plant.runtime.readVariableSnapshot(binding.path).value !== anchor.value || latest.elapsedMs > plant.runtime.elapsedMs()) {
      return failure('The latest retained accepted control operation does not establish every required command anchor; do not recreate missing history from current demands.')
    }
    notBeforeElapsedMs = Math.max(notBeforeElapsedMs, latest.elapsedMs)
    anchors.push({ signal: processPlantEvidenceSignal(binding), receipt: latest })
  }
  if (input.afterOperations !== undefined && plant.runtime.elapsedMs() - notBeforeElapsedMs < durationMs) return failure('The requested response duration has not elapsed after all required accepted control operations.')
  const clockOrigin = now - plant.runtime.advancedMs()
  const anchoredAt = clockOrigin + notBeforeElapsedMs
  const fixedStepMs = plant.plant.graph.timestep.fixedStepMs
  const from = new Date(fromMs).toISOString() as IsoTimestamp
  const to = config.simulationTime!
  const summaries = new Map<string, { readonly status: Status; readonly recordingIndex: number; readonly reason: string | undefined; readonly minimum: number | undefined; readonly maximum: number | undefined; readonly change: number | undefined }>()
  for (const comparison of input.comparisons) {
    // This resolver also rejects hidden injected-fault truth, rather than
    // converting a privileged fault knob into procedure evidence.
    const binding = readableProcessPlantSignalBinding(plant.plant.graph, comparison.signal)
    const key = String(binding.path)
    let cached = summaries.get(key)
    if (cached === undefined) {
      const seriesId = recordingSeriesIdFor(plant.plant.id, binding.path)
      const base = { signal: processPlantEvidenceSignal(binding), seriesId, expectedRuntimeId: processPlantSimRuntimeId, requestedFrom: new Date(start).toISOString(), requestedTo: to,
        recordingIntervalMs: interval, maximumRecognizedGapMs: recordedHoldMs + interval, recordingRelativeDeadband: relativeDeadband }
      let reason: string | undefined
      let samples: ReadonlyArray<RecordedSample> = []
      let value: number | undefined
      let acquiredVariable: ProcessPlantEvidenceVariable | undefined
      let quality: ProcessPlantSignalQuality = { status: 'unavailable', reason: 'Signal acquisition is unavailable.' }
      let acquiredQuality = false
      let startingValue: number | undefined
      try {
        const variable = plant.runtime.readVariableSnapshot(binding.path)
        acquiredVariable = processPlantEvidenceVariable(variable)
        quality = processPlantSignalQuality(variable, { system: plant.plant, runtime: plant.runtime })
        acquiredQuality = true
        reason = binding.writable || variable.writable ? 'Writable commands/demands cannot establish a physical response.'
          : typeof variable.value !== 'number' || !Number.isFinite(variable.value) ? 'A finite numeric response reading is required.'
            : quality.status !== 'good' ? quality.reason
              : !config.recordedSeriesIds.has(seriesId) ? 'This physical signal is not selected for recording in the Run.' : undefined
        if (reason === undefined) {
          value = variable.value as number
          if (original !== undefined) startingValue = startingResponseReading(original, binding).variable!.value as number
          samples = [...config.recordedHistory.read({ seriesId, from, to, limit })].sort((a, b) => a.sequence - b.sequence)
          if (samples.length >= limit) reason = 'The source cadence does not establish that the entire requested sample window was returned.'
          const runtimeIds = new Set(samples.map(sample => sample.runtimeId))
          if (runtimeIds.size > 1) reason = 'The retained samples mix runtime identities.'
          for (let index = 0; index < samples.length && reason === undefined; index++) {
            const sample = samples[index]!
            const at = sample.simulationTime === undefined ? Number.NaN : Date.parse(sample.simulationTime)
            const previous = samples[index - 1]
            // Recorded elapsed time is integrated time. Acquisition Run time can
            // include a remainder short of one authored step (ISO stamps have
            // millisecond precision); do not reject honest ordinary pauses.
            const offset = sample.elapsedMs === undefined ? Number.NaN : at - sample.elapsedMs - clockOrigin
            if (sample.runtimeId !== processPlantSimRuntimeId || sample.seriesId !== seriesId || !Number.isFinite(at) || at < fromMs || at > now || sample.elapsedMs === undefined || sample.elapsedMs > plant.runtime.elapsedMs()
              || offset < -1 || offset >= fixedStepMs + 1) reason = 'A retained sample does not establish this signal and simulation-time frame.'
            else if (previous !== undefined && (at < Date.parse(previous.simulationTime!) || sample.elapsedMs < previous.elapsedMs!)) reason = 'Retained response time reverses; the window is not one advancing simulation trajectory.'
          }
        }
      } catch (error) {
        reason = error instanceof Error ? error.message : String(error)
        // A history failure withholds temporal proof; it must not rewrite an
        // independently acquired physical indication as unavailable.
        if (!acquiredQuality) quality = { status: 'unavailable', reason }
      }
      let left = -1
      samples.forEach((sample, index) => {
        const at = Date.parse(sample.simulationTime ?? '')
        if (at <= start && (input.afterOperations === undefined || at >= anchoredAt && sample.elapsedMs !== undefined && sample.elapsedMs > notBeforeElapsedMs)) left = index
      })
      const selected = original === undefined ? left < 0 ? samples : samples.slice(left) : samples.filter(sample => Date.parse(sample.simulationTime ?? '') >= start)
      const first = original === undefined ? selected[0] : { simulationTime: original.simulationTime, elapsedMs: original.simTimeMs, value: startingValue }
      if (reason === undefined && (first === undefined || original === undefined && left < 0)) reason = 'The retained record does not cover the left boundary of the requested response window.'
      if (reason === undefined && original !== undefined && samples.length === 0) reason = 'The retained record does not establish this signal recording across the original observation.'
      if (reason === undefined && selected.some(sample => sample.quality !== 'good' || typeof sample.value !== 'number' || !Number.isFinite(sample.value))) reason = 'A retained response sample is unavailable or not good quality.'
      const times = [...(original === undefined ? [] : [start]), ...selected.flatMap(sample => sample.simulationTime === undefined || !Number.isFinite(Date.parse(sample.simulationTime)) ? [] : [Date.parse(sample.simulationTime)])]
      const uniqueTimes = new Set([...times, now])
      const maximumGapMs = times.reduce((maximum, at, index) => Math.max(maximum, index === 0 ? 0 : at - times[index - 1]!), times.length === 0 ? 0 : now - times.at(-1)!)
      if (reason === undefined && (uniqueTimes.size < 2 || maximumGapMs > recordedHoldMs + interval)) reason = 'The stored record has an unresolved response gap; a fresh endpoint cannot fill it.'
      const values = [...(startingValue === undefined ? [] : [startingValue]), ...selected.flatMap(sample => typeof sample.value === 'number' ? [sample.value] : [])]
      const minimum = value === undefined ? undefined : values.reduce((minimum, measured) => Math.min(minimum, measured), value)
      const maximum = value === undefined ? undefined : values.reduce((maximum, measured) => Math.max(maximum, measured), value)
      const change = value === undefined || typeof first?.value !== 'number' ? undefined : value - first.value
      const elapsedSeconds = first?.simulationTime === undefined ? undefined : (now - Date.parse(first.simulationTime)) / 1000
      const integratedSpanSeconds = first?.elapsedMs === undefined ? undefined : (plant.runtime.elapsedMs() - first.elapsedMs) / 1000
      if (reason === undefined && (integratedSpanSeconds === undefined || integratedSpanSeconds < input.windowSeconds)) reason = 'The retained samples do not cover the required integrated physical response duration.'
      const summary = { ...base, ...(input.afterOperations === undefined ? {} : { notBeforeElapsedMs, notBeforeSimulationTime: new Date(anchoredAt).toISOString() }),
        status: reason === undefined ? 'satisfied' : 'unknown', ...(reason === undefined ? {} : { reason }),
        storedSampleCount: selected.length, ...(original === undefined ? {} : { originalAcquisitionIncluded: true }), sampleTimestampOrigin: first?.simulationTime ?? to,
        sampleTimeRuns: encodeProcessPlantSampleTimeRuns(times.map(at => at - (times[0] ?? now))), maximumGapMs, quality,
        retainedRuntimeIds: [...new Set(selected.map(sample => sample.runtimeId))],
        ...(selected.length === 0 ? {} : { firstSequence: selected[0]!.sequence, lastSequence: selected.at(-1)!.sequence }),
        ...(first === undefined ? {} : { first: { ...(first.simulationTime === undefined ? {} : { simulationTime: first.simulationTime }), ...(first.elapsedMs === undefined ? {} : { elapsedMs: first.elapsedMs }), value: first.value } }),
        ...(acquiredVariable === undefined ? {} : { current: { simulationTime: to, elapsedMs: plant.runtime.elapsedMs(), ...acquiredVariable } }),
        ...(minimum === undefined ? {} : { minimum }), ...(maximum === undefined ? {} : { maximum }), ...(change === undefined ? {} : { change }),
        ...(integratedSpanSeconds === undefined ? {} : { integratedSpanSeconds }),
        ...(elapsedSeconds === undefined ? {} : { elapsedSeconds, ...(elapsedSeconds > 0 && change !== undefined ? { endpointRatePerSecond: change / elapsedSeconds } : {}) }) }
      cached = { status: reason === undefined ? 'satisfied' : 'unknown', recordingIndex: recordings.length, reason, minimum, maximum, change }
      recordings.push(summary)
      summaries.set(key, cached)
    }
    const actual = cached[comparison.statistic]
    const reason = binding.unit !== comparison.unit ? `Response unit ${comparison.unit} does not match the native signal unit ${binding.unit}.` : cached.reason
    const status: Status = reason !== undefined || cached.status === 'unknown' || actual === undefined ? 'unknown' : compare(actual, comparison.operator, comparison.value) ? 'satisfied' : 'challenged'
    evidence.push({ recordingIndex: cached.recordingIndex, comparison, ...(actual === undefined ? {} : { actual }), status, ...(reason === undefined ? {} : { reason }) })
  }
  for (const setting of input.unchangedSettings ?? []) {
    const binding = readableProcessPlantSignalBinding(plant.plant.graph, setting.signal)
    const base = { kind: 'setting', signal: processPlantEvidenceSignal(binding), requestedFrom: new Date(start).toISOString(), requestedTo: to,
      interpretation: 'Original and current configuration, retained sampled values and latest person/AI accepted-operation identity; not continuously observed controller authority.' }
    let status: Status = 'unknown', reason: string | undefined
    let detail: Record<string, unknown> = {}
    let expectedValue: number | boolean | undefined
    try {
      if (original === undefined) throw new Error('Unchanged configuration requires its original acquisition.')
      if (!binding.writable || binding.unit !== setting.unit) throw new Error('Unchanged configuration requires its canonical writable setting and native unit.')
      const initial = startingResponseReading(original, binding, true)
      const ending = startingResponseReading(current, binding, true)
      const initialValue = initial.variable!.value
      expectedValue = initialValue
      const seriesId = recordingSeriesIdFor(plant.plant.id, binding.path)
      const rows = [...config.recordedHistory.read({ seriesId, from, to, limit })].sort((a, b) => a.sequence - b.sequence)
      const selected = rows.filter(row => Date.parse(row.simulationTime ?? '') >= start)
      const initialOperation = initial.settingOperation, endingOperation = ending.settingOperation
      const changedOperation = initialOperation?.available === true && endingOperation?.available === true
        && JSON.stringify(initialOperation.latest) !== JSON.stringify(endingOperation.latest)
      const validRows = rows.every((row, index) => {
        const at = Date.parse(row.simulationTime ?? ''), previous = rows[index - 1]
        const offset = row.elapsedMs === undefined ? Number.NaN : at - row.elapsedMs - clockOrigin
        return row.runtimeId === processPlantSimRuntimeId && row.seriesId === seriesId && Number.isFinite(at) && at >= fromMs && at <= now
          && row.elapsedMs !== undefined && row.elapsedMs <= plant.runtime.elapsedMs() && offset >= -1 && offset < fixedStepMs + 1
          && (previous === undefined || at >= Date.parse(previous.simulationTime!) && row.elapsedMs >= previous.elapsedMs!)
      })
      const changedValue = ending.variable!.value !== initialValue || validRows
        && selected.some(row => row.quality === 'good' && typeof row.value === typeof initialValue && row.value !== initialValue)
      const times = [start, ...selected.map(row => Date.parse(row.simulationTime!)), now]
      const maximumGapMs = times.reduce((maximum, at, index) => Math.max(maximum, index === 0 ? 0 : at - times[index - 1]!), 0)
      reason = changedOperation ? 'An accepted person/AI operation changed the original configuration operation identity.'
        : changedValue ? 'Current or retained configuration differs from its original acquisition.'
          : !config.recordedSeriesIds.has(seriesId) || rows.length === 0 ? 'The configuration record is unavailable for the original observation.'
            : rows.length >= limit || !validRows ? 'The retained configuration does not establish this complete simulation-time trajectory.'
              : selected.some(row => row.quality !== 'good' || typeof row.value !== typeof initialValue) ? 'A retained configuration point is unavailable or not good quality.'
                : maximumGapMs > recordedHoldMs + interval ? 'The retained configuration has an unresolved observation gap.'
                  : initialOperation?.available !== true || endingOperation?.available !== true ? 'The accepted-operation identity is unavailable.' : undefined
      status = changedOperation || changedValue ? 'challenged' : reason === undefined ? 'satisfied' : 'unknown'
      detail = { seriesId, first: { simulationTime: original.simulationTime, elapsedMs: original.simTimeMs, value: initialValue },
        current: { simulationTime: to, elapsedMs: plant.runtime.elapsedMs(), ...ending.variable }, quality: ending.quality,
        storedSampleCount: selected.length, sampleTimestampOrigin: original.simulationTime,
        sampleTimeRuns: encodeProcessPlantSampleTimeRuns(selected.map(row => Date.parse(row.simulationTime!) - start)), maximumGapMs,
        originalOperation: initialOperation, currentOperation: endingOperation }
    } catch (error) { reason = error instanceof Error ? error.message : String(error) }
    const recordingIndex = recordings.length
    recordings.push({ ...base, ...detail, status, ...(reason === undefined ? {} : { reason }) })
    evidence.push({ recordingIndex, comparison: { signal: setting.signal, statistic: 'unchanged', operator: '==', ...(expectedValue === undefined ? {} : { value: expectedValue }), unit: setting.unit },
      status, ...(reason === undefined ? {} : { reason }) })
  }
  const status = combine([current.status, ...evidence.map(row => row.status as Status)])
  return { ...identity, status, ...(status === 'unknown' ? { reason: 'The current prerequisites or explicitly sampled response cannot be established from the retained evidence.' } : {}), current, evidence, recordings, afterOperations: anchors }
}
