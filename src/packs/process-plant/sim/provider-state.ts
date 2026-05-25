import { z } from 'zod'
import {
  processEquipmentIdSchema,
  processQuantitySchema,
  processSignalTagIdSchema,
  processUnitSchema,
  processVariableCapabilitySchema,
  processVariableLimitsSchema,
  processVariableValueSchema,
  variableDomainSchema,
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
  domain: variableDomainSchema,
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

export const processPlantProviderStateSchema = z.object({
  schemaVersion: z.literal(1),
  systems: z.array(z.object({
    systemId: z.string().min(1),
    runtime: processPlantRuntimeSnapshotSchema,
    schedule: processPlantScheduleSnapshotSchema.optional(),
    telemetry: processPlantTelemetrySnapshotSchema.optional(),
    protection: processPlantProtectionSnapshotSchema.optional(),
  })),
})

export interface ProcessPlantProviderState {
  readonly schemaVersion: 1
  readonly systems: ReadonlyArray<{
    readonly systemId: string
    readonly runtime: ProcessPlantRuntimeSnapshot
    readonly schedule?: ProcessPlantScheduleSnapshot
    readonly telemetry?: ProcessPlantTelemetrySnapshot
    readonly protection?: ProcessPlantProtectionSnapshot
  }>
}

export const providerStateForProcessPlantSystems = (
  systems: ReadonlyMap<string, ProcessPlantSystemRuntime>,
): ProcessPlantProviderState => ({
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
  providerState: ProcessPlantProviderState | null,
  systemId: string,
) => providerState?.systems.find(system => system.systemId === systemId)

export const restoredRuntimeSnapshotFor = (
  providerState: ProcessPlantProviderState | null,
  systemId: string,
): ProcessPlantRuntimeSnapshot | undefined => restoredSystemFor(providerState, systemId)?.runtime

export const restoredScheduleSnapshotFor = (
  providerState: ProcessPlantProviderState | null,
  systemId: string,
): ProcessPlantScheduleSnapshot | undefined => restoredSystemFor(providerState, systemId)?.schedule

export const restoredTelemetrySnapshotFor = (
  providerState: ProcessPlantProviderState | null,
  systemId: string,
): ProcessPlantTelemetrySnapshot | undefined => restoredSystemFor(providerState, systemId)?.telemetry

export const restoredProtectionSnapshotFor = (
  providerState: ProcessPlantProviderState | null,
  systemId: string,
): ProcessPlantProtectionSnapshot | undefined => restoredSystemFor(providerState, systemId)?.protection
