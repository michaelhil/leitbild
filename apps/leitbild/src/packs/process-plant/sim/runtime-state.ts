import { z } from 'zod'
import {
  processEquipmentIdSchema,
  processQuantitySchema,
  processSignalTagIdSchema,
  processUnitSchema,
  processVariableCapabilitySchema,
  processVariableLimitsSchema,
  processVariableValueSchema,
  variableDisciplineSchema,
  variableKindSchema,
  variablePathSchema,
} from '../graph/index.ts'
import {
  processPlantScheduleSnapshotSchema,
  processPlantTelemetrySnapshotSchema,
  processPlantProtectionSnapshotSchema,
  type ProcessPlantRuntimeSnapshot,
  type ProcessPlantScheduleSnapshot,
  type ProcessPlantTelemetrySnapshot,
  type ProcessPlantProtectionSnapshot,
} from '../runtime/index.ts'
import type { ProcessPlantSystemRuntime } from '../system-runtime.ts'

const processPlantVariableSnapshotSchema = z.object({
  path: variablePathSchema,
  label: z.string().min(1),
  value: processVariableValueSchema,
  canonicalValue: processVariableValueSchema,
  quantity: processQuantitySchema,
  unit: processUnitSchema,
  discipline: variableDisciplineSchema,
  kind: variableKindSchema,
  writable: z.boolean(),
  published: z.boolean(),
  tagId: processSignalTagIdSchema.optional(),
  equipmentId: processEquipmentIdSchema.optional(),
  description: z.string().min(1).optional(),
  externalRefs: z.array(z.string().min(1)).optional(),
  capabilities: processVariableCapabilitySchema.optional(),
  limits: processVariableLimitsSchema.optional(),
})

const processPlantRuntimeSnapshotSchema = z.object({
  graphSpecId: z.string().min(1),
  variablePaths: z.array(variablePathSchema).min(1),
  elapsedMs: z.number().finite().nonnegative(),
  remainderMs: z.number().finite().nonnegative(),
  queuedCommands: z.array(z.object({
    type: z.literal('setVariable'),
    path: variablePathSchema,
    value: processVariableValueSchema,
  })),
  variables: z.array(processPlantVariableSnapshotSchema),
})

export const processPlantRuntimeStateSchema = z.object({
  schemaVersion: z.literal(1),
  systems: z.array(z.object({
    systemId: z.string().min(1),
    runtime: processPlantRuntimeSnapshotSchema,
    schedule: processPlantScheduleSnapshotSchema.optional(),
    telemetry: processPlantTelemetrySnapshotSchema.optional(),
    protection: processPlantProtectionSnapshotSchema.optional(),
  })),
})

export interface ProcessPlantRuntimeState {
  readonly schemaVersion: 1
  readonly systems: ReadonlyArray<{
    readonly systemId: string
    readonly runtime: ProcessPlantRuntimeSnapshot
    readonly schedule?: ProcessPlantScheduleSnapshot
    readonly telemetry?: ProcessPlantTelemetrySnapshot
    readonly protection?: ProcessPlantProtectionSnapshot
  }>
}

export const runtimeStateForProcessPlantSystems = (
  systems: ReadonlyMap<string, ProcessPlantSystemRuntime>,
): ProcessPlantRuntimeState => ({
  schemaVersion: 1,
  systems: [...systems.values()].map(({ system, runtime, schedule, telemetry, protection }) => ({
    systemId: system.id,
    runtime: runtime.snapshot(),
    schedule: schedule.snapshot(),
    ...(telemetry === undefined ? {} : { telemetry: telemetry.snapshot() }),
    ...(protection === undefined ? {} : { protection: protection.snapshot() }),
  })),
})

const restoredSystemFor = (
  runtimeState: ProcessPlantRuntimeState | null,
  systemId: string,
) => runtimeState?.systems.find(system => system.systemId === systemId)

export const restoredRuntimeSnapshotFor = (
  runtimeState: ProcessPlantRuntimeState | null,
  systemId: string,
): ProcessPlantRuntimeSnapshot | undefined => restoredSystemFor(runtimeState, systemId)?.runtime

export const restoredScheduleSnapshotFor = (
  runtimeState: ProcessPlantRuntimeState | null,
  systemId: string,
): ProcessPlantScheduleSnapshot | undefined => restoredSystemFor(runtimeState, systemId)?.schedule

export const restoredTelemetrySnapshotFor = (
  runtimeState: ProcessPlantRuntimeState | null,
  systemId: string,
): ProcessPlantTelemetrySnapshot | undefined => restoredSystemFor(runtimeState, systemId)?.telemetry

export const restoredProtectionSnapshotFor = (
  runtimeState: ProcessPlantRuntimeState | null,
  systemId: string,
): ProcessPlantProtectionSnapshot | undefined => restoredSystemFor(runtimeState, systemId)?.protection
