import { simulationRunIdSchema, type SimulationRunId } from './ids.ts'

export const newSimulationRunId = (): SimulationRunId => {
  if (!globalThis.crypto?.randomUUID) throw new Error('crypto.randomUUID is not available in this runtime')
  return simulationRunIdSchema.parse(`run-${globalThis.crypto.randomUUID()}`)
}
