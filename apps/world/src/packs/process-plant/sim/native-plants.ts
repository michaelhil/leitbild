import type { ProcessPlantDefinition } from '../config.ts'
import { resolveLd01UnitArtifact } from '../engine/artifact.ts'
import { connectNativeProcessPlantEngine, type NativeEngineFailure, type NativeProcessPlantEngine } from '../engine/native-engine.ts'
import { runsOnNativeEngine } from '../engine/port.ts'
import { compileProcessPlants, type CompiledProcessPlant } from '../plant-compiler.ts'
import { restoredNativeCheckpointFor, restoredRuntimeStateEntryFor, type ProcessPlantRuntimeState, type ProcessPlantRuntimeStateEntry } from './runtime-state.ts'

// A Run's Plants as its connect finds them: compiled, each LD-01 Plant with its native engine connected. A
// fresh Run with an LD-01 Plant the engine cannot serve is refused (its creation refused it already). A restored
// Run's LD-01 Plant whose engine is unavailable (no artifact here, another artifact, a refused RESTORE) connects
// as "engine unavailable": it keeps its saved state unchanged, and nothing runs in its place.

export interface UnavailableProcessPlant {
  readonly reason: string
  /** Its state as last saved, kept unchanged and saved again with the Run's, for a later restore. */
  readonly retained?: ProcessPlantRuntimeStateEntry
}

export interface ConnectedProcessPlants {
  readonly compiled: ReadonlyArray<CompiledProcessPlant>
  readonly nativeEngines: Map<string, NativeProcessPlantEngine>
  readonly unavailable: Map<string, UnavailableProcessPlant>
}

export const connectProcessPlants = async (config: {
  readonly definitions: ReadonlyArray<ProcessPlantDefinition>
  readonly runtimeState: ProcessPlantRuntimeState | null
  readonly onEngineFailure: (plantId: string, failure: NativeEngineFailure) => void
}): Promise<ConnectedProcessPlants> => {
  const restoring = config.runtimeState !== null
  const unavailable = new Map<string, UnavailableProcessPlant>()
  const unavailableAs = (plantId: string, reason: string): void => {
    const retained = restoredRuntimeStateEntryFor(config.runtimeState, plantId)
    unavailable.set(plantId, { reason: `LD-01 engine unavailable: ${reason}`, ...(retained === undefined ? {} : { retained }) })
  }
  const native = config.definitions.filter(definition => runsOnNativeEngine(definition.model.ref))
  const artifact = native.length === 0 ? null : resolveLd01UnitArtifact()
  if (artifact !== null && !artifact.ok) {
    if (!restoring) throw new Error(`an LD-01 Plant is refused: ${artifact.reason}`)
    for (const definition of native) unavailableAs(definition.id, artifact.reason)
  }
  const compiled = compileProcessPlants(config.definitions.filter(definition => !unavailable.has(definition.id)))
  const nativeEngines = new Map<string, NativeProcessPlantEngine>()
  if (artifact === null || !artifact.ok) return { compiled: compiled, nativeEngines, unavailable }
  const connecting = compiled.filter(plant => runsOnNativeEngine(plant.modelRef))
  const settled = await Promise.allSettled(connecting.map(async plant => {
    const restored = restoredNativeCheckpointFor(config.runtimeState, plant.id)
    return await connectNativeProcessPlantEngine({
      plant,
      tagMap: artifact.artifact.tagMap,
      load: artifact.artifact.load,
      artifactSha256: artifact.artifact.manifestSha256,
      command: [artifact.artifact.binary],
      ...(restored === undefined ? {} : { restored }),
      onFailure: failure => { config.onEngineFailure(plant.id, failure) },
    })
  }))
  const refused: string[] = []
  for (const [index, outcome] of settled.entries()) {
    const plant = connecting[index]!
    if (outcome.status === 'fulfilled') nativeEngines.set(plant.id, outcome.value)
    else if (restoring) unavailableAs(plant.id, outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason))
    else refused.push(outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason))
  }
  if (refused.length > 0) {
    await Promise.allSettled([...nativeEngines.values()].map(engine => engine.close()))
    throw new Error(`an LD-01 Plant is refused: ${refused.join('; ')}`)
  }
  return { compiled: compiled.filter(plant => !unavailable.has(plant.id)), nativeEngines, unavailable }
}
