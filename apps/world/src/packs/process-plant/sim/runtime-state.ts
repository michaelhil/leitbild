import { z } from 'zod'
import {
  processVariableValueSchema,
  variablePathSchema,
} from '../graph/index.ts'
import {
  processPlantRampSnapshotSchema,
  processPlantProtectionSnapshotSchema,
  type ProcessPlantRuntimeCheckpoint,
  type ProcessPlantRampSnapshot,
  type ProcessPlantProtectionSnapshot,
} from '../runtime/index.ts'
import type { ProcessPlantRuntimeInstance } from '../runtime-instance.ts'
import type { OffsiteIsolation } from './offsite-isolation.ts'
import { plantOperationsStateSchema, type PlantOperationsState } from '../operations/plant-operations.ts'
import { nativeProcessPlantCheckpointSchema, type NativeProcessPlantCheckpoint, type NativeProcessPlantEngine } from '../engine/native-engine.ts'

const processPlantRuntimeCheckpointSchema = z.object({
  modelDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  elapsedMs: z.number().finite().nonnegative(),
  remainderMs: z.number().finite().nonnegative(),
  queuedCommands: z.array(z.object({
    type: z.literal('setVariable'),
    path: variablePathSchema,
    value: processVariableValueSchema,
  })),
  values: z.array(processVariableValueSchema),
})

export const processPlantRuntimeStateSchema = z.object({
  schemaVersion: z.literal(1),
  plants: z.array(z.object({
    plantId: z.string().min(1),
    // A TS Plant's checkpoint, or an LD-01 Plant's native snapshot (engine/native-engine.ts); no migration between them.
    runtime: z.union([processPlantRuntimeCheckpointSchema, nativeProcessPlantCheckpointSchema]),
    ramps: processPlantRampSnapshotSchema,
    protection: processPlantProtectionSnapshotSchema.optional(),
    // Connected ports a plant-side fault has isolated from their Grid (offsite-isolation.ts); none when absent.
    offsiteIsolations: z.array(z.object({ portId: z.string().min(1), cause: z.string().min(1) })).optional(),
    // What people and AI agents did and propose (operations/plant-operations.ts); none when absent.
    operations: plantOperationsStateSchema.optional(),
  })),
})

export interface ProcessPlantRuntimeState {
  readonly schemaVersion: 1
  readonly plants: ReadonlyArray<{
    readonly plantId: string
    readonly runtime: ProcessPlantRuntimeCheckpoint | NativeProcessPlantCheckpoint
    readonly ramps: ProcessPlantRampSnapshot
    readonly protection?: ProcessPlantProtectionSnapshot
    readonly offsiteIsolations?: ReadonlyArray<OffsiteIsolation>
    readonly operations?: PlantOperationsState
  }>
}

export type ProcessPlantRuntimeStateEntry = ProcessPlantRuntimeState['plants'][number]

/** One live Plant's state: an LD-01 Plant's runtime is its engine's last snapshot, which a flush never disturbs. */
export const runtimeStateEntryFor = (
  { plant, runtime, ramps, protection, operations }: ProcessPlantRuntimeInstance,
  offsiteIsolations: ReadonlyMap<string, ReadonlyArray<OffsiteIsolation>>,
  nativeEngine: NativeProcessPlantEngine | undefined,
): ProcessPlantRuntimeStateEntry => {
  const isolations = offsiteIsolations.get(plant.id) ?? []
  const operated = operations?.snapshot()
  return {
    plantId: plant.id,
    runtime: nativeEngine === undefined ? runtime.checkpoint() : nativeEngine.persisted(),
    ramps: ramps.snapshot(),
    ...(protection === undefined ? {} : { protection: protection.snapshot() }),
    ...(isolations.length === 0 ? {} : { offsiteIsolations: isolations.map(isolation => ({ ...isolation })) }),
    ...(operated === undefined ? {} : { operations: operated }),
  }
}

export const runtimeStateForProcessPlants = (
  plants: ReadonlyMap<string, ProcessPlantRuntimeInstance>,
  offsiteIsolations: ReadonlyMap<string, ReadonlyArray<OffsiteIsolation>>,
  native?: {
    readonly engines: ReadonlyMap<string, NativeProcessPlantEngine>
    /** LD-01 Plants without a live engine keep the state they last had, unchanged, for a later restore. */
    readonly retained: ReadonlyMap<string, ProcessPlantRuntimeStateEntry>
  },
): ProcessPlantRuntimeState => ({
  schemaVersion: 1,
  plants: [
    ...[...plants.values()].map(instance => runtimeStateEntryFor(instance, offsiteIsolations, native?.engines.get(instance.plant.id))),
    ...(native === undefined ? [] : [...native.retained.values()]),
  ],
})

const restoredPlantFor = (
  runtimeState: ProcessPlantRuntimeState | null,
  plantId: string,
) => runtimeState?.plants.find(plant => plant.plantId === plantId)

export const restoredRuntimeCheckpointFor = (
  runtimeState: ProcessPlantRuntimeState | null,
  plantId: string,
): ProcessPlantRuntimeCheckpoint | undefined => {
  const runtime = restoredPlantFor(runtimeState, plantId)?.runtime
  if (runtime !== undefined && 'engine' in runtime) throw new Error(`process plant ${plantId} was saved by its native engine, not the TS runtime`)
  return runtime
}

/** An LD-01 Plant's saved native state; a TS checkpoint in its place is refused, never converted. */
export const restoredNativeCheckpointFor = (
  runtimeState: ProcessPlantRuntimeState | null,
  plantId: string,
): NativeProcessPlantCheckpoint | undefined => {
  const runtime = restoredPlantFor(runtimeState, plantId)?.runtime
  if (runtime !== undefined && !('engine' in runtime)) throw new Error(`LD-01 Plant ${plantId} was saved by the TS runtime, not its native engine`)
  return runtime
}

export const restoredRuntimeStateEntryFor = (
  runtimeState: ProcessPlantRuntimeState | null,
  plantId: string,
): ProcessPlantRuntimeStateEntry | undefined => restoredPlantFor(runtimeState, plantId)

export const restoredRampSnapshotFor = (
  runtimeState: ProcessPlantRuntimeState | null,
  plantId: string,
): ProcessPlantRampSnapshot | undefined => restoredPlantFor(runtimeState, plantId)?.ramps

export const restoredProtectionSnapshotFor = (
  runtimeState: ProcessPlantRuntimeState | null,
  plantId: string,
): ProcessPlantProtectionSnapshot | undefined => restoredPlantFor(runtimeState, plantId)?.protection

export const restoredOperationsFor = (
  runtimeState: ProcessPlantRuntimeState | null,
  plantId: string,
): PlantOperationsState | undefined => restoredPlantFor(runtimeState, plantId)?.operations

export const restoredOffsiteIsolationsFor = (
  runtimeState: ProcessPlantRuntimeState | null,
  plantId: string,
): ReadonlyArray<OffsiteIsolation> => restoredPlantFor(runtimeState, plantId)?.offsiteIsolations ?? []
