import { recordingSeriesIdFor } from '../../core/model/index.ts'
import type {
  IsoTimestamp,
  PackRuntimeRecordingBatch,
  RecordingProfileDescriptor,
  RecordingSeriesDescriptor,
  ScenarioRecordingSelection,
} from '../../core/model/index.ts'
import type { ProcessPlantVariableHandle } from './runtime/variable-table.ts'
import type { ProcessPlantRuntimeInstance } from './runtime-instance.ts'
import type { CompiledProcessPlant } from './plant-compiler.ts'

export const recordedPlantVariables = (plant: CompiledProcessPlant, profileId: string) => plant.graph.variables.filter(variable =>
  profileId === 'engineering' || ['state', 'control', 'discrete'].includes(variable.descriptor.kind) || variable.descriptor.tagId !== undefined || variable.descriptor.quantity === 'power')

export const processPlantRecordingProfiles: ReadonlyArray<RecordingProfileDescriptor> = [{
  id: 'operations',
  title: 'Operations',
  description: 'State, operator controls, discrete states, tagged instruments and power balances. Other derived engineering diagnostics are excluded. Unchanged values are recorded at most once per minute.',
  defaultIntervalMs: 1_000,
  minimumIntervalMs: 250,
}, {
  id: 'engineering',
  title: 'Engineering detail',
  description: 'Every declared Plant variable for detailed analysis; intentionally slower and opt-in.',
  defaultIntervalMs: 5_000,
  minimumIntervalMs: 1_000,
}]

interface ProcessPlantRecordingSeriesPlan {
  readonly plant: ProcessPlantRuntimeInstance
  readonly handle: ProcessPlantVariableHandle
  readonly descriptor: RecordingSeriesDescriptor
}

export interface ProcessPlantRecordingPlan {
  readonly profile: RecordingProfileDescriptor
  readonly intervalMs: number
  readonly descriptors: ReadonlyArray<RecordingSeriesDescriptor>
  readonly sample: (config: {
    readonly observedAt: IsoTimestamp
    readonly simulationTime: IsoTimestamp
  }) => PackRuntimeRecordingBatch
}

const recordingProfileFor = (profileId: string): RecordingProfileDescriptor => {
  const profile = processPlantRecordingProfiles.find(candidate => candidate.id === profileId)
  if (!profile) throw new Error(`unknown process plant recording profile: ${profileId}`)
  return profile
}

export const createProcessPlantRecordingPlan = (config: {
  readonly selection: ScenarioRecordingSelection
  readonly plants: ReadonlyMap<string, ProcessPlantRuntimeInstance>
}): ProcessPlantRecordingPlan => {
  const profile = recordingProfileFor(config.selection.profileId)
  const intervalMs = config.selection.intervalMs ?? profile.defaultIntervalMs
  if (intervalMs < profile.minimumIntervalMs) {
    throw new Error(`process plant recording profile ${profile.id} requires an interval of at least ${profile.minimumIntervalMs} ms`)
  }
  const series: ProcessPlantRecordingSeriesPlan[] = [...config.plants.values()].flatMap(plant =>
    recordedPlantVariables(plant.plant, profile.id)
      .map(variable => ({
        plant,
        handle: plant.runtime.resolveVariableHandle(variable.path),
        descriptor: {
          id: recordingSeriesIdFor(plant.plant.id, variable.path),
          subjectId: plant.plant.id,
          signalId: variable.path,
          title: `${plant.plant.graph.title} · ${variable.descriptor.label}`,
          valueType: variable.descriptor.quantity === 'boolean' ? 'boolean' as const : 'number' as const,
          quantity: variable.descriptor.quantity,
          unit: variable.descriptor.unit,
        },
      })),
  )
  const descriptors = series.map(item => item.descriptor)
  const lastRecorded = new Map<string, { value: number | boolean; at: number }>()
  return {
    profile,
    intervalMs,
    descriptors,
    sample: ({ observedAt, simulationTime }) => ({
      descriptors: [],
      samples: series.flatMap(item => {
        const variable = item.plant.runtime.readVariableSnapshotHandle(item.handle)
        const at = Date.parse(simulationTime)
        const previous = lastRecorded.get(item.descriptor.id)
        if (previous && previous.value === variable.value && at >= previous.at && at - previous.at < 60_000) return []
        lastRecorded.set(item.descriptor.id, { value: variable.value, at })
        return [{
          seriesId: item.descriptor.id,
          observedAt,
          simulationTime,
          elapsedMs: item.plant.runtime.elapsedMs(),
          value: variable.value,
          quality: 'good' as const,
        }]
      }),
    }),
  }
}
