import { processPlantLd01ModelRef, processPlantPwrReferenceModelRef } from '../plant-definitions.ts'
import type { NativeProcessPlantEngine } from './native-engine.ts'
import type { TsProcessPlantEngine } from './ts-engine.ts'

// The Pack-internal engine port (platform design §3): exactly two implementations, chosen by the Plant Model
// reference through one closed table. Both serve the Pack's synchronous runtime view (queries, I&C,
// projection, observation read it); the native engine advances, checkpoints and closes asynchronously.
// This is not a plugin registry: a third engine is a change to this table and to its callers.

export type ProcessPlantEngine = TsProcessPlantEngine | NativeProcessPlantEngine
export type ProcessPlantEngineKind = ProcessPlantEngine['kind']

const engineKindByModelRef: Readonly<Record<string, ProcessPlantEngineKind>> = {
  [processPlantPwrReferenceModelRef]: 'ts',
  [processPlantLd01ModelRef]: 'native',
}

export const processPlantEngineKindFor = (modelRef: string): ProcessPlantEngineKind => {
  const kind = engineKindByModelRef[modelRef]
  if (kind === undefined) throw new Error(`process plant model ${modelRef} has no engine`)
  return kind
}

/** Whether a Plant Model runs on the native engine; a reference the table does not hold is refused by compiling it. */
export const runsOnNativeEngine = (modelRef: string): boolean => engineKindByModelRef[modelRef] === 'native'
