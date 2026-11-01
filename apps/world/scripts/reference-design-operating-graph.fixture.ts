// Packets with the joined packet's, the IC section's and the ELEC packet's shape, for the LD-01 graph compiler's tests
// and the LD-01 shell's (scripts/reference-design-operating-graph.ts). Test-only.
// A two-loop spine with the joined packet's shape: one core region, a plenum each side, per loop a hot leg, an SG
// primary, one pump and a cold leg, and the PZR on loop A's hot leg through its surge line.
const ids = ['CORE.1', 'DOWN', 'LOWER', 'UPPER', 'HOT.A', 'SG.A.PRIMARY', 'PUMP.A1', 'COLD.A', 'HOT.B', 'SG.B.PRIMARY', 'PUMP.B1', 'COLD.B', 'SURGE', 'PZR']
const at = (id: string): number => ids.indexOf(id)
const faces = [
  ['DOWN', 'LOWER'], ['LOWER', 'CORE.1'], ['CORE.1', 'UPPER'],
  ['UPPER', 'HOT.A'], ['HOT.A', 'SG.A.PRIMARY'], ['SG.A.PRIMARY', 'PUMP.A1'], ['PUMP.A1', 'COLD.A'], ['COLD.A', 'DOWN'],
  ['UPPER', 'HOT.B'], ['HOT.B', 'SG.B.PRIMARY'], ['SG.B.PRIMARY', 'PUMP.B1'], ['PUMP.B1', 'COLD.B'], ['COLD.B', 'DOWN'],
  ['HOT.A', 'SURGE'], ['SURGE', 'PZR.SURGE.MOUTH'],
].map(([from, to]) => ({ id: `${from}->${to}`, from: at(from!), to: to === 'PZR.SURGE.MOUTH' ? at('PZR') : at(to!) }))
export const packet = {
  identity: 'TEST-SPINE',
  mechanics: { regions: ids.map((id, index) => ({ id, volume_m3: 1 + index, elevation_m: 0 })), faces },
  source_water: [at('CORE.1'), at('CORE.1')],
  thermal: { sg_segments: [{ primary: at('SG.A.PRIMARY'), secondary: 0 }, { primary: at('SG.B.PRIMARY'), secondary: 1 }] },
  hydraulics: { sections: [{ id: 'PUMP.A1', region: at('PUMP.A1'), parameters: { pump: { a: 1 } } }, { id: 'PUMP.B1', region: at('PUMP.B1'), parameters: { pump: { a: 1 } } }, { id: 'DOWN', region: at('DOWN'), parameters: { pump: null } }] },
  pzr: { cell: { index: at('PZR'), bottom_m: 6.5, top_m: 18.5, fluidVolume_m3: 60, ports: [{ id: 'PZR.SURGE.MOUTH', kind: 'surge', face: faces.length - 1 }, { id: 'PZR.RELIEF', kind: 'relief', face: null }] } },
  secondary: {
    steamGenerators: [{ id: 'A', volume_m3: 120, steamDemand_kg_s: 820 }, { id: 'B', volume_m3: 120, steamDemand_kg_s: 820 }],
    feedTrain: { nominalFlow_kg_s: 819.8, suctionPressure_Pa: 101325, headerPressure_Pa: 7_200_000 },
  },
  rods: { clusters: [{ id: 'LD01.CR.001' }, { id: 'LD01.CR.002' }] },
  feedback_metadata: { parameters: { rod_maximum_travel_m: 4 } },
}
const channelSpec = { lag_s: 0.2, quantum: null, indeterminate_band: null, sample_s: 0.1, transport_s: 0.1 }
export const ic = {
  identity: 'test-ic',
  frame_s: 0.1,
  families: [
    { id: 'LD01.PZR.PT', quantity: 'pzr_roof_pressure', channels: [1, 2, 3].map(n => ({ id: `LD01.PZR.PT${n}`, supply: `I${n}` })), channel: { ...channelSpec, min: 0, max: 20_000_000 } },
    { id: 'LD01.SG.A.LT.NR', quantity: { sg_apparent_level: { sg: 'A', area_m2: 12 } }, channels: [{ id: 'LD01.SG.A.LT.NR1', supply: 'unselected' }], channel: { ...channelSpec, min: 4, max: 9 } },
    { id: 'LD01.RCS.A.FT', quantity: { loop_flow: { loop_id: 'A', face: 7, face_id: 'COLD.A->DOWN' } }, channels: [{ id: 'LD01.RCS.A.FT', supply: 'I1' }], channel: { ...channelSpec, min: -1.5, max: 1.5 } },
    { id: 'LD01.CORE.POWER.P', quantity: { current_proxy: { weights: [1] } }, channels: [{ id: 'LD01.CORE.POWER.P1', supply: 'I1' }], channel: { ...channelSpec, min: null, max: null } },
    { id: 'LD01.RCP.A1.SPEED', quantity: { pump_speed: { rotor: 0, rotor_id: 'PUMP.A1' } }, channels: [{ id: 'LD01.RCP.A1.SPEED', supply: 'I1' }], channel: { ...channelSpec, min: 0, max: 1.5 } },
    { id: 'LD01.RCP.B1.SPEED', quantity: { pump_speed: { rotor: 1, rotor_id: 'PUMP.B1' } }, channels: [{ id: 'LD01.RCP.B1.SPEED', supply: 'I2' }], channel: { ...channelSpec, min: 0, max: 1.5 } },
  ],
  reports: [{ id: 'LD01.TG.TRIP.REPORT', source: 'turbine_retained_trip', supply: 'ACT.B' }],
  functions: [
    { id: 'LD01.PROT.PZR.HIGH_PRESSURE', rule: { voted: { family: 'LD01.PZR.PT', side: { at_or_above: 15_898_400 }, qualification_s: 0.2 } }, effects: { reactor_trip: true, cmt_injection: false, heater_isolation: true, prhr: false } },
    { id: 'LD01.PROT.PZR.LOW_PRESSURE', rule: { voted: { family: 'LD01.PZR.PT', side: { at_or_below: 13_000_000 }, qualification_s: 0.5 } }, effects: { reactor_trip: true, cmt_injection: false, heater_isolation: false, prhr: false } },
    { id: 'LD01.PROT.PZR.S_PRESSURE', rule: { voted: { family: 'LD01.PZR.PT', side: { at_or_below: 12_477_415 }, qualification_s: 0.5 } }, effects: { reactor_trip: true, cmt_injection: true, heater_isolation: false, prhr: true } },
    { id: 'LD01.PROT.RCS.A.LOW_FLOW', rule: { armed: { family: 'LD01.RCS.A.FT', side: { at_or_below: 0.87 }, qualification_s: 1, arming_family: 'LD01.CORE.POWER.P', arming: { above: 0.2 } } }, effects: { reactor_trip: true, cmt_injection: false, heater_isolation: false, prhr: false } },
  ],
  holding: { interface: 'LD01.TRIP.HOLD', supply: 'LD01.DC.ACT.A', manual_interrupt: 'LD01.TRIP.MANUAL', divisions: ['I1', 'I2', 'I3'], contacts: ['LD01.TRIP.PERM.I1'] },
}
export const elec = {
  distribution: { consumers: { 'LD01.P.A1': 'AC.A', 'LD01.FW.P1': 'AC.A', 'LD01.P.B1': 'AC.B' } },
  slice: { generator: {}, turbine: {} },
}

/** A channel's unit as ld01-unit.rs `channels()` gives it, by its id's form. */
export const unitOf = (channel: string): string => {
  if (channel.endsWith('RELEASED_POWER') || channel.endsWith('.WT') || channel.endsWith('HEATER.REQUEST')) return 'W'
  if (channel.endsWith('.QUALITY') || channel.endsWith('.LATCHED') || channel.endsWith('.REQUEST') || channel.includes('.FT') || channel.includes('.SPEED') || channel.includes('POWER.P')) return '1'
  if (/\.(TRIP|POWERED|CLOSED|AVAILABLE|INITIATED|OFFSITE_LOST)$/u.test(channel)) return '1'
  if (channel.endsWith('.REPORT') || channel.endsWith('.INSERTED')) return '1'
  if (channel.includes('PT') || channel.endsWith('PRESSURE')) return 'Pa'
  if (channel.endsWith('.FLOW')) return 'kg/s'
  if (channel.endsWith('OMEGA')) return 'rad/s'
  if (/\.(THOT|TCOLD|INLET\.T|OUTLET\.T)$/u.test(channel)) return 'K'
  if (channel.endsWith('FCV.POSITION')) return '1'
  if (channel.endsWith('EXPORT_ENERGY')) return 'J'
  return 'm'
}
