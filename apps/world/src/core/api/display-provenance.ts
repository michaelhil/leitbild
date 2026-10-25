import { randomUUID } from 'node:crypto'
import type { SimulationRunRuntime } from '../simulation-runs/runtime.ts'

// Runtime identity is issued by World, never inferred from a clock moving backwards.
// A reset/reload creates a new runtime; the weak key retains no closed Run.
const epochs = new WeakMap<SimulationRunRuntime, string>()
export const displayRuntimeIdentity = (runtime: SimulationRunRuntime): { readonly epoch: string; readonly sequence: number } => {
  let epoch = epochs.get(runtime)
  if (epoch === undefined) { epoch = randomUUID(); epochs.set(runtime, epoch) }
  return { epoch, sequence: runtime.snapshot().seq }
}
