import { describe, expect, test } from 'bun:test'
import type { SimulationRunId } from '../src/core/model/index.ts'
import {
  commandsForProcessPlantAction,
  compileProcessPlant,
  createProcessPlantProtectionRunner,
  createProcessPlantRuntime,
  createPwrReferencePlantDefinition,
  type VariablePath,
} from '../src/packs/process-plant/index.ts'
import { headerPressureBalance } from '../src/packs/process-plant/runtime/behaviors/junction/header-pressure-balance.ts'
import { resolveProcessPlantSignalBinding } from '../src/packs/process-plant/signals.ts'

// Auxiliary feedwater of the four-loop reference PWR, in three trains kept
// apart as a Westinghouse plant's are (USNRC Westinghouse Technology Systems
// Manual 5.7): motor-driven pump A (440 gpm, 27.6 kg/s) feeds steam
// generators A and B, motor-driven pump B feeds C and D, and the
// turbine-driven pump (880 gpm, 55.2 kg/s) feeds all four. Each pump
// discharges into its own header, which feeds each of its generators by its
// own line with a cavitating venturi; a generator's two lines, its motor-driven
// train's and the turbine-driven train's, pass its auxiliary feedwater valve.
// Each header's pressure settles where its pump's curve delivers what its open
// lines pass. The venturis cavitate at about 240 gpm (15 kg/s) with the pumps
// at their rated head, as Point Beach's (NRC, ML113202356), so a depressurized
// generator cannot draw off the other generators' feed.

const plant = compileProcessPlant(createPwrReferencePlantDefinition({ id: 'plant:afw', loopCount: 4 }))
const graph = plant.graph
const loops = ['A', 'B', 'C', 'D'] as const
const ratedFlowKgPerS = { auxFeedwaterPumpMotor: 27.6, auxFeedwaterPumpMotorB: 27.6, auxFeedwaterPumpTurbine: 55.2 } as const
const pumps = Object.keys(ratedFlowKgPerS) as ReadonlyArray<keyof typeof ratedFlowKgPerS>
const trains = [
  { header: 'auxFeedwaterHeaderA', pump: 'auxFeedwaterPumpMotor', line: (loop: string) => `aux-feedwater-header-to-valve-${loop.toLowerCase()}`, generators: ['A', 'B'] },
  { header: 'auxFeedwaterHeaderB', pump: 'auxFeedwaterPumpMotorB', line: (loop: string) => `aux-feedwater-header-to-valve-${loop.toLowerCase()}`, generators: ['C', 'D'] },
  { header: 'auxFeedwaterHeaderTurbine', pump: 'auxFeedwaterPumpTurbine', line: (loop: string) => `aux-feedwater-turbine-header-to-valve-${loop.toLowerCase()}`, generators: ['A', 'B', 'C', 'D'] },
] as const
const venturiKgPerSPerSqrtMPa = 5

const started = (withIc = true, system = plant) => {
  const runtime = createProcessPlantRuntime({ system })
  const protection = createProcessPlantProtectionRunner({ system, protection: system.automation })
  const read = (path: string): number => Number(runtime.readVariable(path as VariablePath))
  const tag = (tagId: string): number => Number(runtime.readVariable(resolveProcessPlantSignalBinding(graph, { tagId: tagId as never }).path))
  const set = (path: string, value: boolean | number): void => runtime.writeCommand({ type: 'setVariable', path: path as VariablePath, value })
  const run = (seconds: number, each?: () => void): void => {
    for (let second = 0; second < seconds; second += 1) {
      runtime.tick(1_000)
      if (withIc) protection.evaluate({ runtime, elapsedMs: runtime.elapsedMs(), simulationRunId: 'run-afw' as SimulationRunId, sourceRuntimeId: 'process-plant.local' })
      each?.()
    }
  }
  const act = (actionId: string, parameters: Readonly<Record<string, unknown>> = {}): void => {
    for (const command of commandsForProcessPlantAction({ actionId, parameters, graph })) set(command.path, command.value as boolean | number)
  }
  const active = (): ReadonlyArray<string> => {
    const snapshot = protection.snapshot()
    return [...snapshot.alarms, ...snapshot.trips].filter(lifecycle => lifecycle.active).map(lifecycle => lifecycle.id)
  }
  return { runtime, read, tag, set, run, act, active }
}

/** Each train's header balance with the generators' pressures overridden, as if they stood there now. */
const balanceWith = (plantRun: ReturnType<typeof started>, header: string, pressures: ReadonlyMap<string, number>) => {
  const known = new Set(graph.variables.map(variable => variable.path))
  return headerPressureBalance(plant, graph.components[graph.componentIndexById.get(header as never)!]!, {
    has: path => known.has(path),
    readNumber: path => pressures.get(path) ?? plantRun.read(path),
    readBoolean: path => plantRun.runtime.readVariable(path) === true,
  })
}
const branchOf = (train: (typeof trains)[number], loop: string): number => graph.links.find(link => link.id === train.line(loop))!.index

describe('auxiliary feedwater', () => {
  test('keeps its trains apart: each motor-driven pump feeds its own two generators, the turbine-driven pump all four', () => {
    for (const train of trains) {
      const header = graph.componentIndexById.get(train.header as never)!
      const pumpsIn = (graph.incomingLinksByComponent[header] ?? []).map(index => graph.components[graph.links[index]!.fromComponentIndex]!.id)
      expect(pumpsIn).toEqual([train.pump] as never)
      // Each branch is its own line to one generator's auxiliary feedwater valve.
      const onward = (component: number): ReadonlyArray<number> => (graph.outgoingLinksByComponent[component] ?? []).map(next => graph.links[next]!.toComponentIndex)
      const fed = (graph.outgoingLinksByComponent[header] ?? []).map(index => ({
        line: graph.links[index]!.id,
        generator: onward(graph.links[index]!.toComponentIndex).map(generator => graph.components[generator]!.id),
      }))
      expect(fed).toEqual(train.generators.map(loop => ({ line: train.line(loop), generator: [`sg${loop}`] })) as never)
    }
    // A generator's valve takes its motor-driven train's line and the turbine-driven train's, and nothing else.
    for (const loop of loops) {
      const valve = graph.componentIndexById.get(`auxFeedwaterValve${loop}` as never)!
      expect((graph.incomingLinksByComponent[valve] ?? []).map(index => graph.links[index]!.id).sort())
        .toEqual(trains.filter(train => (train.generators as ReadonlyArray<string>).includes(loop)).map(train => train.line(loop)).sort())
    }
    // Each generator's auxiliary feedwater flow, its line's, and the total are signals.
    for (const loop of loops) expect(resolveProcessPlantSignalBinding(graph, { tagId: `AFW-${loop}-FLOW` as never }).path).toBe(`aux-feedwater-valve-${loop.toLowerCase()}-to-sg-${loop.toLowerCase()}.flowKgPerS` as VariablePath)
    expect(resolveProcessPlantSignalBinding(graph, { tagId: 'AFW-FLOW' as never }).path).toBe('auxFeedwaterFlowTotal.totalFlowKgPerS' as VariablePath)
  })

  test('after a loss of main feedwater feeds each generator a quarter of the three pumps\' rated 110 kg/s, half from each of its trains', () => {
    const plantRun = started()
    plantRun.run(5)
    plantRun.act('loss-main-feedwater')
    plantRun.run(300)
    const { tag, read } = plantRun
    const flows = loops.map(loop => tag(`AFW-${loop}-FLOW`))
    // The generators stand at about their 7.6 MPa no-load pressure, where the lines are sized to pass the
    // pumps' rated flow at their 9 MPa rated head.
    for (const loop of loops) expect(read(`sg${loop}.pressureMPa`)).toBeGreaterThan(7.4)
    for (const flow of flows) {
      expect(flow).toBeGreaterThan(25)
      expect(flow).toBeLessThan(30)
      expect(Math.abs(flow - flows[0]!)).toBeLessThan(0.01 * flows[0]!)
    }
    for (const loop of loops) {
      const motor = read(trains.find(train => train.pump !== 'auxFeedwaterPumpTurbine' && (train.generators as ReadonlyArray<string>).includes(loop))!.line(loop) + '.flowKgPerS')
      const turbine = read(trains[2].line(loop) + '.flowKgPerS')
      // Its line into the generator carries both (a solver step behind them).
      expect(motor + turbine).toBeCloseTo(tag(`AFW-${loop}-FLOW`), 3)
      expect(motor / turbine).toBeCloseTo(1, 1)
      // Each generator's feedwater inflow is its auxiliary feedwater, main feedwater being lost.
      expect(read(`sg${loop}.feedwaterFlowKgPerS`)).toBeCloseTo(tag(`AFW-${loop}-FLOW`), 6)
    }
    expect(tag('AFW-FLOW')).toBeCloseTo(flows.reduce((total, flow) => total + flow, 0), 6)
    expect(tag('AFW-FLOW')).toBeGreaterThan(100)
    expect(tag('AFW-FLOW')).toBeLessThan(115)
    // Each pump's discharge is its own signal, and each header stands near the pumps' 9.1 MPa rated discharge.
    expect(tag('AFW-PUMP-A-FLOW')).toBeCloseTo(read('auxFeedwaterPumpMotor.flowKgPerS'), 1)
    expect(tag('AFW-PUMP-T-FLOW')).toBeCloseTo(read('auxFeedwaterPumpTurbine.flowKgPerS'), 1)
    for (const train of trains) {
      expect(read(`${train.header}.pressureNodeMPa`)).toBeGreaterThan(8.8)
      expect(read(`${train.header}.pressureNodeMPa`)).toBeLessThan(9.6)
    }
  })

  test('with one line open, that generator takes what the line passes, and its pump runs back along its curve', () => {
    const plantRun = started(false)
    plantRun.run(5)
    for (const pump of pumps) plantRun.set(`${pump}.running`, true)
    for (const loop of loops) plantRun.set(`auxFeedwaterValve${loop}.positionFraction`, loop === 'B' ? 1 : 0)
    // The turbine-driven pump takes its 30 s run-up to come to speed.
    plantRun.run(60)
    const { read, tag } = plantRun
    // Motor-driven pump A, its other line shut, runs back to what generator B's line passes, which its venturi caps
    // near the pump's shutoff head: about 16 kg/s, not the pump's 27.6. The turbine-driven pump, its other three
    // lines shut, does the same, and motor-driven pump B, both its lines shut, delivers nothing.
    const header = read('auxFeedwaterHeaderA.pressureNodeMPa')
    expect(header).toBeGreaterThan(10)
    expect(read(trains[0].line('B') + '.flowKgPerS')).toBeCloseTo(venturiKgPerSPerSqrtMPa * Math.sqrt(header), 1)
    expect(read(trains[2].line('B') + '.flowKgPerS')).toBeCloseTo(venturiKgPerSPerSqrtMPa * Math.sqrt(read('auxFeedwaterHeaderTurbine.pressureNodeMPa')), 1)
    expect(read('auxFeedwaterPumpMotor.flowKgPerS')).toBeLessThan(0.65 * ratedFlowKgPerS.auxFeedwaterPumpMotor)
    for (const loop of ['A', 'C', 'D']) expect(tag(`AFW-${loop}-FLOW`)).toBe(0)
    expect(read('auxFeedwaterPumpMotorB.flowKgPerS')).toBe(0)
    expect(tag('AFW-B-FLOW')).toBeGreaterThan(30)
    expect(tag('AFW-B-FLOW')).toBeLessThan(36)
    // What the tank gives is what the pumps deliver, and what the generator takes (the lines read a solver step apart).
    const suction = read('aux-feedwater-tank-to-motor-pump.flowKgPerS') + read('aux-feedwater-tank-to-motor-pump-b.flowKgPerS') + read('aux-feedwater-tank-to-turbine-pump.flowKgPerS')
    expect(suction).toBeCloseTo(tag('AFW-B-FLOW'), 2)
    expect(read('auxFeedwaterHeaderA.flowBalanceResidualKgPerS')).toBeCloseTo(0, 2)
  })

  test('a depressurized generator takes no more than its lines\' venturis pass, and the other generators keep their feed', () => {
    const plantRun = started(false)
    plantRun.run(5)
    for (const pump of pumps) plantRun.set(`${pump}.running`, true)
    for (const loop of loops) plantRun.set(`auxFeedwaterValve${loop}.positionFraction`, 1)
    plantRun.run(60)
    // Generator A faulted, at atmospheric pressure behind a broken steam line; the others at no-load pressure.
    const even = new Map(loops.map(loop => [`sg${loop}.pressureMPa`, 7.6]))
    const faulted = new Map(loops.map(loop => [`sg${loop}.pressureMPa`, loop === 'A' ? 0.101 : 7.6]))
    for (const train of [trains[0], trains[2]]) {
      const before = balanceWith(plantRun, train.header, even)
      const after = balanceWith(plantRun, train.header, faulted)
      // The faulted generator's line cavitates at its venturi's flow, about 15 to 17 kg/s, not the 30 to 50 kg/s
      // its valve alone would pass into a dead generator.
      const faultedLine = after.branchFlowKgPerS.get(branchOf(train, 'A'))!
      expect(faultedLine).toBeCloseTo(venturiKgPerSPerSqrtMPa * Math.sqrt(after.pressureMPa), 6)
      expect(faultedLine).toBeLessThan(1.25 * before.branchFlowKgPerS.get(branchOf(train, 'A'))!)
      // The train's intact generators lose some of their feed, not all of it.
      for (const loop of train.generators.filter(other => other !== 'A')) {
        expect(after.branchFlowKgPerS.get(branchOf(train, loop))!).toBeGreaterThan(0.6 * before.branchFlowKgPerS.get(branchOf(train, loop))!)
      }
      // The pump delivers what the lines pass, at a lower header pressure.
      const total = (flows: ReadonlyMap<number, number>): number => [...flows.values()].reduce((sum, flow) => sum + flow, 0)
      expect(total(after.pumpFlowKgPerS)).toBeCloseTo(total(after.branchFlowKgPerS), 3)
      expect(after.pressureMPa).toBeLessThan(before.pressureMPa)
    }
    // Motor-driven pump B's train does not see generator A at all.
    expect(balanceWith(plantRun, 'auxFeedwaterHeaderB', faulted).pressureMPa).toBeCloseTo(balanceWith(plantRun, 'auxFeedwaterHeaderB', even).pressureMPa, 9)
  })

  test('with generator A\'s relief valve stuck open after a loss of main feedwater, its lines cap its feed at their venturis', () => {
    const plantRun = started()
    plantRun.run(5)
    plantRun.act('loss-main-feedwater')
    plantRun.set('steamGeneratorReliefValveA.positionFailureActive', true)
    plantRun.set('steamGeneratorReliefValveA.failedPositionFraction', 1)
    plantRun.run(300)
    const { read, tag } = plantRun
    expect(read('sgA.pressureMPa')).toBeLessThan(read('sgB.pressureMPa') - 0.4)
    for (const train of [trains[0], trains[2]]) {
      const line = read(`${train.line('A')}.flowKgPerS`)
      expect(line).toBeCloseTo(venturiKgPerSPerSqrtMPa * Math.sqrt(read(`${train.header}.pressureNodeMPa`)), 1)
    }
    expect(tag('AFW-A-FLOW')).toBeGreaterThan(tag('AFW-B-FLOW'))
    expect(tag('AFW-A-FLOW')).toBeLessThan(1.15 * tag('AFW-B-FLOW'))
    for (const loop of ['B', 'C', 'D']) expect(tag(`AFW-${loop}-FLOW`)).toBeGreaterThan(25)
  })

  test('with motor-driven pump A failed, generators A and B still take the turbine-driven pump\'s feed, well above the 28 kg/s minimum in all', () => {
    // The heat-sink success criterion: 440 gpm (28 kg/s) in all (USNRC Westinghouse Technology Systems Manual 5.7).
    const plantRun = started()
    plantRun.run(5)
    plantRun.act('loss-main-feedwater')
    plantRun.run(300, () => plantRun.set('auxFeedwaterPumpMotor.running', false))
    const { tag } = plantRun
    for (const loop of ['A', 'B']) {
      expect(tag(`AFW-${loop}-FLOW`)).toBeGreaterThan(12)
      expect(tag(`AFW-${loop}-FLOW`)).toBeLessThan(16)
    }
    for (const loop of ['C', 'D']) expect(tag(`AFW-${loop}-FLOW`)).toBeGreaterThan(25)
    expect(tag('AFW-PUMP-A-FLOW')).toBe(0)
    expect(tag('AFW-FLOW')).toBeGreaterThan(80)
  })

  test('started by one generator\'s low-low level, each motor-driven pump feeds its own two generators, not that one alone', () => {
    // Feedwater control valve B fails to 35 % at full power; generator B boils down to its low-low level.
    const plantRun = started()
    plantRun.run(5)
    plantRun.act('steam-generator-b-feedwater-runback', { positionPercent: 35 })
    let afwStartedAt: number | null = null
    for (let second = 1; second <= 120 && afwStartedAt === null; second += 1) {
      plantRun.run(1)
      if (plantRun.read('auxFeedwaterPumpMotor.runningState') === 1) afwStartedAt = second
    }
    expect(afwStartedAt).not.toBeNull()
    const { tag, read } = plantRun
    // Generator B alone is at low-low level: the turbine-driven pump, which wants two, stays off.
    expect(tag('SG-B-LVL-NR')).toBeLessThan(20)
    expect(loops.filter(loop => tag(`SG-${loop}-LVL-NR`) < 20)).toEqual(['B'])
    expect(read('auxFeedwaterPumpMotorB.runningState')).toBe(1)
    expect(read('auxFeedwaterPumpTurbine.runningState')).toBe(0)
    // Ten seconds on, each motor-driven pump splits its flow between its two generators.
    plantRun.run(10)
    expect(tag('AFW-A-FLOW')).toBeGreaterThan(10)
    expect(tag('AFW-B-FLOW') / tag('AFW-A-FLOW')).toBeGreaterThan(0.9)
    expect(tag('AFW-B-FLOW') / tag('AFW-A-FLOW')).toBeLessThan(1.15)
    expect(tag('AFW-PUMP-A-FLOW')).toBeCloseTo(tag('AFW-A-FLOW') + tag('AFW-B-FLOW'), 0)
    // The reactor trip shrinks the other generators to their low-low level too, and with two of them there the
    // turbine-driven pump joins: a minute on, past its run-up, some 28 kg/s into each.
    let turbinePumpAt: number | null = null
    for (let second = 1; second <= 120 && turbinePumpAt === null; second += 1) {
      plantRun.run(1)
      if (read('auxFeedwaterPumpTurbine.runningState') === 1) turbinePumpAt = second
    }
    expect(turbinePumpAt).not.toBeNull()
    plantRun.run(60)
    for (const loop of loops) {
      expect(tag(`AFW-${loop}-FLOW`)).toBeGreaterThan(25)
      expect(tag(`AFW-${loop}-FLOW`)).toBeLessThan(31)
    }
  })

  test('starts the turbine-driven pump once two generators reach low-low level', () => {
    const plantRun = started()
    plantRun.run(5)
    plantRun.act('loss-main-feedwater')
    let bothLowAt: number | null = null
    let turbinePumpAt: number | null = null
    for (let second = 1; second <= 200 && turbinePumpAt === null; second += 1) {
      plantRun.run(1)
      if (bothLowAt === null && loops.filter(loop => plantRun.tag(`SG-${loop}-LVL-NR`) < 20).length >= 2) bothLowAt = second
      if (plantRun.read('auxFeedwaterPumpTurbine.runningState') === 1) turbinePumpAt = second
    }
    // The motor-driven pumps started with the main feedwater pumps' trip; the turbine-driven one waits for the
    // second generator's low-low level, and its one-second delay.
    expect(bothLowAt).not.toBeNull()
    expect(turbinePumpAt).not.toBeNull()
    expect(turbinePumpAt! - bothLowAt!).toBeGreaterThanOrEqual(1)
    expect(turbinePumpAt! - bothLowAt!).toBeLessThanOrEqual(3)
    expect(plantRun.read('auxFeedwaterPumpMotor.runningState')).toBe(1)
  })

  test('the turbine-driven pump runs up over 30 s and delivers its rated flow within a minute of its start signal', () => {
    // A Terry turbine comes from cold standby to full load within 30 s (NRC RCIC training, ML11258A312); every
    // pump delivers rated flow within a minute of its automatic start (Westinghouse Technology Systems Manual 5.7).
    const plantRun = started()
    plantRun.run(5)
    plantRun.act('loss-main-feedwater')
    let startedAt: number | null = null
    const trace: Array<{ readonly second: number; readonly rpm: number; readonly flow: number }> = []
    for (let second = 1; second <= 200; second += 1) {
      plantRun.run(1)
      if (startedAt === null && plantRun.read('auxFeedwaterPumpTurbine.runningState') === 1) startedAt = second
      if (startedAt !== null) trace.push({ second: second - startedAt, rpm: plantRun.tag('TDAFW-SPEED'), flow: plantRun.read('auxFeedwaterPumpTurbine.flowKgPerS') })
      if (startedAt !== null && second - startedAt >= 60) break
    }
    expect(startedAt).not.toBeNull()
    const at = (second: number) => trace.find(point => point.second === second)!
    // Its speed rises evenly to its rated 3,600 rpm; until its head passes the generators' pressure it delivers nothing.
    expect(at(15).rpm).toBeCloseTo(1_920, -1)
    expect(at(15).flow).toBe(0)
    expect(at(20).flow).toBe(0)
    expect(at(30).rpm).toBeCloseTo(3_600, 0)
    expect(at(60).flow).toBeGreaterThan(0.95 * ratedFlowKgPerS.auxFeedwaterPumpTurbine)
    const fullFlowAt = trace.find(point => point.flow > 0.9 * ratedFlowKgPerS.auxFeedwaterPumpTurbine)!.second
    expect(fullFlowAt).toBeGreaterThan(30)
    expect(fullFlowAt).toBeLessThan(60)
  })

  test('puts every kilogram it feeds into the generator\'s inventory', () => {
    const plantRun = started()
    plantRun.run(5)
    plantRun.act('loss-main-feedwater')
    plantRun.run(120)
    const { read } = plantRun
    const before = read('sgA.secondaryInventoryKg')
    let fed = 0
    let boiled = 0
    plantRun.run(180, () => {
      fed += read('aux-feedwater-valve-a-to-sg-a.flowKgPerS')
      boiled += read('sgA.boilingRateKgPerS')
    })
    // After the trip decay heat boils off less than auxiliary feedwater brings in, and the generator fills.
    expect(fed).toBeGreaterThan(4_000)
    expect(read('sgA.secondaryInventoryKg') - before).toBeGreaterThan(1_000)
    expect(Math.abs(read('sgA.secondaryInventoryKg') - before - (fed - boiled))).toBeLessThan(0.01 * fed)
  })
})

describe('condensate storage tank', () => {
  // 450,000 gal (1,700 m3), whose lowest 280,000 gal (62 %) are the Technical Specification reserve for auxiliary
  // feedwater (USNRC Westinghouse Technology Systems Manual 5.7; Sequoyah keeps 240,000 of its 385,000 gal).
  test('at the pumps\' full flow falls about 0.4 % a minute, so its reserve lasts hours, and alarms as the level enters it', () => {
    const plantRun = started()
    plantRun.run(5)
    plantRun.act('loss-main-feedwater')
    plantRun.run(180)
    const { read, tag } = plantRun
    expect(read('auxFeedwaterTank.inventoryKg') / read('auxFeedwaterTank.levelPercent') * 100).toBeCloseTo(1_690_000, -3)
    const before = tag('CST-LVL')
    plantRun.run(120)
    const fallPerMinute = (before - tag('CST-LVL')) / 2
    expect(tag('AFW-FLOW')).toBeGreaterThan(100)
    expect(fallPerMinute).toBeGreaterThan(0.35)
    expect(fallPerMinute).toBeLessThan(0.45)
    // The reserve alone feeds the pumps' full flow for over two hours.
    expect(0.62 * 1_690_000 / tag('AFW-FLOW') / 3_600).toBeGreaterThan(2.4)
    expect(plantRun.active()).not.toContain('alarm:condensate-storage-tank-level-low:level-low')
  })

  test('alarms as auxiliary feedwater draws the level into the reserve', () => {
    const drawnDown = compileProcessPlant(createPwrReferencePlantDefinition({
      id: 'plant:afw-cst',
      loopCount: 4,
      valueOverrides: { 'auxFeedwaterTank.inventoryKg': 0.63 * 1_690_000, 'auxFeedwaterTank.levelPercent': 63 },
    }))
    const plantRun = started(true, drawnDown)
    plantRun.run(5)
    expect(plantRun.active()).not.toContain('alarm:condensate-storage-tank-level-low:level-low')
    plantRun.act('loss-main-feedwater')
    let alarmedAt: number | null = null
    for (let second = 1; second <= 400 && alarmedAt === null; second += 1) {
      plantRun.run(1)
      if (plantRun.active().includes('alarm:condensate-storage-tank-level-low:level-low')) alarmedAt = second
    }
    expect(alarmedAt).not.toBeNull()
    expect(plantRun.tag('CST-LVL')).toBeLessThan(62)
    expect(plantRun.tag('CST-LVL')).toBeGreaterThan(61.5)
  })
})
