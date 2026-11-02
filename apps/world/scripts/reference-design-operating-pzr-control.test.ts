import { expect, test } from 'bun:test'
import { compileOperatingPzrControl, pzrContinuousControl, type PzrControlPages } from './reference-design-operating-pzr-control'

// Test-only owner texts in the shapes the compiler reads; not plant evidence.
const fence = (name: string, body: unknown) => '```' + name + '\n' + JSON.stringify(body) + '\n```\n'
const law = { setpoint_Pa: 14864186.8055, sprayStartAboveSetpoint_Pa: 20000, sprayFullAboveSetpoint_Pa: 100000, freshness_s: 2 }
const thermal = { heaterCapacity_W: 3e6, heaterProportionalBand_Pa: 1e5, sprayLength_m: 25 }
const channel = { lag_s: .2, min_pa: 0, max_pa: 2e7, quantum_pa: 1000, sample_s: .1, transport_s: .1 }
const banks = { banks: [
  { id: 'normal', equivalentRods: 32, rodDiameter_m: .02, spanBottomAbovePzrBottom_m: 0, spanTopAbovePzrBottom_m: 1, segments_m: [[0, 1]],
    nominalCapacity_W: 120000, lateralContactArea_m2: 2.010619, solidDisplacement_m3: .0100531, steelMass_kg: 79.620524 },
  { id: 'backup', equivalentRods: 256, rodDiameter_m: .02, spanBottomAbovePzrBottom_m: 0, spanTopAbovePzrBottom_m: 3, segments_m: [[0, 1], [1, 3]],
    nominalCapacity_W: 2880000, lateralContactArea_m2: 48.254863, solidDisplacement_m3: .2412743, steelMass_kg: 1910.892581 }] }
const master = { integralTime_s: 300, smoothingWidth_Pa: 1000, sprayStemTimeConstant_s: .1 }
function pages(over: Partial<{ law: unknown, thermal: unknown, channel: unknown, master: unknown }> = {}, withLaw = true, withMaster = true): PzrControlPages {
  const lawPage = '## Ordinary pressure regulation\n\nProse.\n\n' + (withLaw ? fence('ld01-pzr-pressure-control', over.law ?? law) : '')
    + (withMaster ? fence('ld01-pzr-pressure-master', over.master ?? master) : '') + '\n### Normal demand selection\n'
  return {
    law: lawPage,
    master: lawPage,
    thermal: '## Normal circulation and required thermal duty\n\n' + fence('reference-pressurizer-normal-thermal', over.thermal ?? thermal),
    channel: '### Operating-model observation handoff\n\n' + fence('reference-pzr-pressure-channel', over.channel ?? channel),
    banks: '## Physical banks and displaced inventory\n\n' + fence('ld01-pzr-heater-banks', banks),
  }
}

test('composes the owners\' values unchanged', () => {
  expect(compileOperatingPzrControl(pages())).toEqual({ setpoint_Pa: 14864186.8055, heaterCapacity_W: 3e6, heaterProportionalBand_Pa: 1e5,
    sprayStartAboveSetpoint_Pa: 20000, sprayFullAboveSetpoint_Pa: 100000, freshness_s: 2, sample_s: .1, spanMinimum_Pa: 0, spanMaximum_Pa: 2e7 })
})

test('a missing law block stops with every value it must carry and its prose source', () => {
  expect(() => compileOperatingPzrControl(pages({}, false))).toThrow(/Missing strict block ld01-pzr-pressure-control[\s\S]*setpoint_Pa[\s\S]*sprayStartAboveSetpoint_Pa[\s\S]*sprayFullAboveSetpoint_Pa[\s\S]*freshness_s/)
})

test('refuses unknown or missing keys, a capacity the banks do not install and an inverted spray band', () => {
  expect(() => compileOperatingPzrControl(pages({ law: { ...law, gain: 1 } }))).toThrow()
  const { freshness_s: _, ...noFreshness } = law
  expect(() => compileOperatingPzrControl(pages({ law: noFreshness }))).toThrow()
  expect(() => compileOperatingPzrControl(pages({ thermal: { ...thermal, heaterCapacity_W: 3.1e6 } }))).toThrow(/sum to 3000000 W/)
  expect(() => compileOperatingPzrControl(pages({ law: { ...law, sprayStartAboveSetpoint_Pa: 1e5 } }))).toThrow(/start below/)
  expect(() => compileOperatingPzrControl(pages({ law: { ...law, setpoint_Pa: 2.1e7 } }))).toThrow(/span/)
})

test('the PZR owner\'s continuous master carries the law\'s values, the channel lag and the master block (R4-PZR-PI)', () => {
  expect(pzrContinuousControl(pages())).toEqual({ setpoint_Pa: 14864186.8055, heaterCapacity_W: 3e6, heaterProportionalBand_Pa: 1e5,
    sprayStartAboveSetpoint_Pa: 20000, sprayFullAboveSetpoint_Pa: 100000, lag_s: .2, integralTime_s: 300, smoothingWidth_Pa: 1000,
    sprayStemTimeConstant_s: .1 })
  expect(() => pzrContinuousControl(pages({ channel: { ...channel, lag_s: 0 } }))).toThrow()
  expect(() => pzrContinuousControl(pages({ thermal: { ...thermal, heaterCapacity_W: 3.1e6 } }))).toThrow(/sum to 3000000 W/)
  expect(() => pzrContinuousControl(pages({}, true, false))).toThrow(/Missing strict block ld01-pzr-pressure-master/)
  expect(() => pzrContinuousControl(pages({ master: { ...master, gain: 1 } }))).toThrow()
  expect(() => pzrContinuousControl(pages({ master: { ...master, integralTime_s: 0 } }))).toThrow()
})
