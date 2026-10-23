import { describe, expect, test } from 'bun:test'
import type { IsoTimestamp, ObjectId, SimulationRunId } from '../src/core/model/index.ts'
import type { Observation } from '../src/core/observation/model.ts'
import type { VignetteSection } from '../src/features/displays/compose/model.ts'
import { bindingRefs, FLOW_ROOM, overviewOf, topologySection } from '../src/features/displays/compose/topology.ts'
import { flowLayout } from '../src/features/displays/topology/flow-sizing.ts'
import { commandsForProcessPlantAction, compileProcessPlant, createPwrReferencePlantDefinition } from '../src/packs/process-plant/index.ts'
import { plantDeclaration } from '../src/packs/process-plant/observation/declarations.ts'
import { readPlant } from '../src/packs/process-plant/observation/read.ts'
import { servedPlantTopology } from '../src/packs/process-plant/observation/topology.ts'
import { createProcessPlantProtectionRunner, createProcessPlantRuntime } from '../src/packs/process-plant/runtime/index.ts'
import type { ProcessPlantRuntimeInstance } from '../src/packs/process-plant/runtime-instance.ts'
import { flowDrawing } from '../src/ui/embed/vignette/flow-symbols.ts'
import { guardPlantTests } from './plant-hang-guard.ts'

guardPlantTests()

// W1.2 (H2, #38, U-13, U-16): the trip verified at a glance on the unit's overview. The core writes its flux on the
// instrument in range (power range in percent at power, the intermediate range's current after a trip), "Rods on
// bottom" once they are, and its rod banks hang in by group; a trip it does not follow reads "Rods off bottom" with
// the trip's command under it. Read as World reads the Plant (read.ts), drawn as the window draws it.

type Topology = Extract<VignetteSection, { kind: 'topology' }>
const objectId = 'plant:core-trip' as ObjectId
const plant = compileProcessPlant(createPwrReferencePlantDefinition({ id: objectId, loopCount: 4 }))
const scoped = overviewOf(servedPlantTopology(objectId, plant))!
const declared = new Map(plantDeclaration(objectId, plant, null).observables.map(observable => [observable.ref, observable]))
const section = topologySection(objectId, 'process-plant', scoped, flowLayout(scoped, FLOW_ROOM)!, 38, ref => declared.get(ref)) as Topology

const started = () => {
  const runtime = createProcessPlantRuntime({ system: plant })
  const protection = createProcessPlantProtectionRunner({ system: plant, protection: plant.automation })
  const system = { plant, runtime, protection } as unknown as ProcessPlantRuntimeInstance
  const run = (seconds: number): void => {
    for (let second = 0; second < seconds; second += 1) {
      runtime.tick(1_000)
      protection.evaluate({ runtime, elapsedMs: runtime.elapsedMs(), simulationRunId: 'run-core-trip' as SimulationRunId, sourceRuntimeId: 'process-plant.local' })
    }
  }
  const act = (actionId: string): void => {
    for (const command of commandsForProcessPlantAction({ actionId, parameters: {}, graph: plant.graph })) runtime.writeCommand({ type: 'setVariable', path: command.path, value: command.value })
  }
  // The drawing's sample: every ref it binds, read as World reads the Plant.
  const sampled = (): ReadonlyArray<Observation> => readPlant({ objectId, system, recording: null, simulationTime: '2026-10-22T12:00:00.000Z' as IsoTimestamp, history: undefined },
    bindingRefs(scoped).map(ref => ref.slice(ref.indexOf('#') + 1))).flatMap(observation => observation ?? [])
  return { run, act, sampled }
}
const core = (observations: ReadonlyArray<Observation>) => {
  const drawing = flowDrawing(section, observations, [], false)
  return { text: drawing.texts.find(text => text.id === 'core')!, vessel: drawing.vessels.find(vessel => vessel.id === 'core')! }
}

describe('the core on the unit overview (W1.2)', () => {
  test('at power: its flux on the power range, in percent with its word, then CET; nothing says it stopped, its banks stand out', () => {
    const plantRun = started()
    plantRun.run(2)
    const { text, vessel } = core(plantRun.sampled())
    const lines = text.lines.map(line => `${line.kind}:${line.text}`)
    expect(lines[0]).toBe('name:Core')
    expect(lines[1]).toMatch(/^reading:PWR 10\d\.\d %$/)
    expect(lines[2]).toMatch(/^reading:3\d\d\.\d °C$/)
    expect(lines).toHaveLength(3)
    expect(vessel.parts).toEqual([[0, 0, 0, 0], [expect.any(Number), expect.any(Number), expect.any(Number), expect.any(Number)]])
    expect(vessel.parts![0]!.every(part => part === 0)).toBe(true)
  })

  test('after the trip: "Rods on bottom", then the intermediate range\'s current in powers of ten, every bank in, both groups', () => {
    const plantRun = started()
    plantRun.run(2)
    plantRun.act('loss-offsite-power')
    plantRun.run(180)
    const { text, vessel } = core(plantRun.sampled())
    const lines = text.lines.map(line => line.text)
    expect(lines.slice(0, 2)).toEqual(['Core', 'Rods on bottom'])
    // Three minutes after a loss of offsite power, as Run A stands: "Rods on bottom 4.4×10⁻⁷ A" (plan v5 W1.2).
    expect(`${lines[1]} ${lines[2]}`).toMatch(/^Rods on bottom \d\.\d×10⁻[¹²³⁴⁵⁶⁷⁸⁹⁰]+ A$/)
    expect(vessel.parts).toEqual([[1, 1, 1, 1], [1, 1, 1, 1]])
  })

  test('a trip it has not followed: "Rods off bottom" with the trip\'s command under it; a flag of the range not known reads "?"', () => {
    const plantRun = started()
    plantRun.run(2)
    const observations = plantRun.sampled()
    const stopped = observations.find(observation => observation.ref === `${objectId}#core.stopped`)!
    const unmet = observations.map(observation => (observation === stopped ? { ...stopped, value: 'off', why: 'CMD trip' } : observation))
    const { text } = core(unmet)
    expect(text.lines.slice(0, 3).map(line => `${line.kind}:${line.text}`)).toEqual(['name:Core', 'word:Rods off bottom', 'command:CMD trip'])
    const unknown = observations.map(observation => (observation.ref === `${objectId}#core.aboveP10` ? { ...observation, quality: 'bad' as const } : observation))
    expect(core(unknown).text.lines[1]!.text).toBe('?')
  })
})
