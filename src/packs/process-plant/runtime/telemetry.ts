import { z } from 'zod'
import { variablePathSchema, type VariablePath } from '../graph/index.ts'
import type { ProcessPlantRuntime, ProcessPlantVariableSnapshot } from './model.ts'

export interface ProcessPlantTelemetryPoint {
  readonly elapsedMs: number
  readonly value: number | boolean
  readonly canonicalValue: number | boolean
}

export interface ProcessPlantTelemetrySeries {
  readonly path: VariablePath
  readonly points: ReadonlyArray<ProcessPlantTelemetryPoint>
}

export interface ProcessPlantTelemetryConfig {
  readonly sampleIntervalMs: number
  readonly variables: ReadonlyArray<VariablePath>
}

export interface ProcessPlantTelemetrySnapshot {
  readonly schemaVersion: 1
  readonly sampleIntervalMs: number
  readonly variables: ReadonlyArray<VariablePath>
  readonly nextSampleAtMs: number
  readonly series: ReadonlyArray<ProcessPlantTelemetrySeries>
}

export interface ProcessPlantTelemetryRecorder {
  readonly recordDueSamples: (runtime: ProcessPlantRuntime) => void
  readonly snapshot: () => ProcessPlantTelemetrySnapshot
  readonly series: (paths?: ReadonlyArray<VariablePath>) => ReadonlyArray<ProcessPlantTelemetrySeries>
}

export const processPlantTelemetryConfigSchema = z.object({
  sampleIntervalMs: z.number().int().positive(),
  variables: z.array(variablePathSchema).min(1),
}).strict()

const processPlantTelemetryPointSchema = z.object({
  elapsedMs: z.number().int().nonnegative(),
  value: z.union([z.number().finite(), z.boolean()]),
  canonicalValue: z.union([z.number().finite(), z.boolean()]),
}).strict()

const processPlantTelemetrySeriesSchema = z.object({
  path: variablePathSchema,
  points: z.array(processPlantTelemetryPointSchema),
}).strict()

export const processPlantTelemetrySnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  sampleIntervalMs: z.number().int().positive(),
  variables: z.array(variablePathSchema).min(1),
  nextSampleAtMs: z.number().int().nonnegative(),
  series: z.array(processPlantTelemetrySeriesSchema),
}).strict()

const variableByPath = (
  snapshot: ReadonlyArray<ProcessPlantVariableSnapshot>,
): ReadonlyMap<VariablePath, ProcessPlantVariableSnapshot> =>
  new Map(snapshot.map(variable => [variable.path, variable]))

const appendPoint = (
  series: Map<VariablePath, ProcessPlantTelemetryPoint[]>,
  elapsedMs: number,
  variable: ProcessPlantVariableSnapshot,
): void => {
  const points = series.get(variable.path)
  if (!points) throw new Error(`process plant telemetry series is not configured for variable: ${variable.path}`)
  const previous = points.at(-1)
  if (previous?.elapsedMs === elapsedMs) return
  points.push({
    elapsedMs,
    value: variable.value,
    canonicalValue: variable.canonicalValue,
  })
}

export const createProcessPlantTelemetryRecorder = (config: {
  readonly telemetry: ProcessPlantTelemetryConfig
  readonly restoredSnapshot?: ProcessPlantTelemetrySnapshot
}): ProcessPlantTelemetryRecorder => {
  const telemetry = processPlantTelemetryConfigSchema.parse(config.telemetry)
  const restored = config.restoredSnapshot === undefined
    ? undefined
    : processPlantTelemetrySnapshotSchema.parse(config.restoredSnapshot)
  if (restored && restored.sampleIntervalMs !== telemetry.sampleIntervalMs) {
    throw new Error('restored process plant telemetry sample interval does not match scenario config')
  }
  const configuredVariables = new Set(telemetry.variables)
  if (configuredVariables.size !== telemetry.variables.length) {
    throw new Error('process plant telemetry config contains duplicate variables')
  }
  if (restored) {
    for (const path of restored.variables) {
      if (!configuredVariables.has(path)) throw new Error(`restored process plant telemetry includes unconfigured variable: ${path}`)
    }
  }

  const series = new Map<VariablePath, ProcessPlantTelemetryPoint[]>(
    telemetry.variables.map(path => {
      const restoredSeries = restored?.series.find(candidate => candidate.path === path)
      return [path, [...(restoredSeries?.points ?? [])]]
    }),
  )
  let nextSampleAtMs = restored?.nextSampleAtMs ?? 0

  return {
    recordDueSamples: (runtime: ProcessPlantRuntime): void => {
      const runtimeSnapshot = runtime.snapshot()
      if (runtimeSnapshot.elapsedMs < nextSampleAtMs) return
      const variables = variableByPath(runtimeSnapshot.variables)
      while (nextSampleAtMs <= runtimeSnapshot.elapsedMs) {
        for (const path of telemetry.variables) {
          const variable = variables.get(path)
          if (!variable) throw new Error(`process plant telemetry variable is not declared by runtime: ${path}`)
          appendPoint(series, nextSampleAtMs, variable)
        }
        nextSampleAtMs += telemetry.sampleIntervalMs
      }
    },
    snapshot: (): ProcessPlantTelemetrySnapshot => ({
      schemaVersion: 1,
      sampleIntervalMs: telemetry.sampleIntervalMs,
      variables: telemetry.variables,
      nextSampleAtMs,
      series: [...series.entries()].map(([path, points]) => ({ path, points: [...points] })),
    }),
    series: (paths?: ReadonlyArray<VariablePath>): ReadonlyArray<ProcessPlantTelemetrySeries> => {
      const selectedPaths = paths ?? telemetry.variables
      return selectedPaths.map(path => {
        const points = series.get(path)
        if (!points) throw new Error(`process plant telemetry series not found: ${path}`)
        return { path, points: [...points] }
      })
    },
  }
}
