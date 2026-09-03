import type { CompiledScenario, IsoTimestamp, SimulationClockState } from '../core/model/index.ts'
import type { WorldPackView } from '../core/packs/protocol.ts'
import { simulationTimeAt as interpolate } from '../core/model/time.ts'

export const scenarioUsesSimulationTime = (scenario: CompiledScenario | null, packs: ReadonlyArray<WorldPackView>): boolean =>
  !!scenario && ((scenario.timeline?.cues.length ?? 0) > 0 || packs.some(pack => pack.runtime?.runtimes.some(runtime => runtime.id === scenario.packRuntimes[pack.descriptor.id] && runtime.clock === 'simulation')))

export const simulationTimeAt = (
  clock: SimulationClockState | undefined,
  wallTimeMs: number = Date.now(),
): IsoTimestamp | undefined => {
  if (!clock) return undefined
  return interpolate(clock, wallTimeMs)
}
