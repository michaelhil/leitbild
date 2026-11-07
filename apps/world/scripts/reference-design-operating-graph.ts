/** The LD-01 Plant Model graph and its tag map (r4 shell design §3), compiled from the packets the
 * `ld01-unit` child loads: the joined packet (mechanics regions and faces, the PZR cell and its ports, the SG
 * segments and secondaries, the fission source's regions, the pumps' hydraulic sections, the rod clusters), the
 * IC section (instrument families and their channels, the protection functions, the holding chain) and the ELEC
 * packet (the turbine-generator, the supply consumers), and with a section declaring the DC groups the wiki's
 * `ld01-dc-charging` block, which ld01-unit reads too (the charger inputs a person may select). Every component,
 * link, reading and limit comes from them: regions become coolant volumes, the source's regions one core, each SG's primary region a steam
 * generator, each pump section a pump, the PZR cell a pressurizer; a loop is the regions that lie on a cycle
 * through one SG and no other. Nothing is drawn by hand and nothing lays a Plant out.
 *
 * Each reading is one of the unit's channels, named as ld01-unit.rs `channels()` names them; the tag map binds
 * every graph variable to its channel (or a writable command to its kernel command) and the native engine checks
 * it against CHANNELS at LOAD, refusing any channel the unit does not deliver. IC channels publish their channel
 * ids as tags, their span as the instrument span and the protection functions' setpoints as alarm limits. */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { compilePlantGraph, processPlantComponentRegistry, type PlantGraphSpec, type ProcessUnit } from '../src/packs/process-plant/graph/index.ts'
import { convertLd01Value, ld01ConversionExists, type Ld01Command, type Ld01TagMap } from '../src/packs/process-plant/engine/tag-map.ts'
import { configurationBlock } from './reference-design-source-laws'

const finite = z.number().finite()
const index = z.number().int().nonnegative()

const packetSchema = z.object({
  identity: z.string().min(1),
  mechanics: z.object({
    regions: z.array(z.object({ id: z.string().min(1), volume_m3: finite.positive(), elevation_m: finite }).passthrough()),
    faces: z.array(z.object({ id: z.string().min(1), from: index, to: index }).passthrough()),
  }).passthrough(),
  source_water: z.array(index).min(1),
  thermal: z.object({
    sg_segments: z.array(z.object({ primary: index, secondary: index }).passthrough()).min(1),
  }).passthrough(),
  hydraulics: z.object({
    sections: z.array(z.object({ id: z.string().min(1), region: index, parameters: z.object({ pump: z.unknown() }).passthrough() }).passthrough()),
  }).passthrough(),
  pzr: z.object({
    cell: z.object({
      index,
      bottom_m: finite,
      top_m: finite,
      fluidVolume_m3: finite.positive(),
      ports: z.array(z.object({ id: z.string().min(1), kind: z.string().min(1), face: index.nullable() }).passthrough()),
    }).passthrough(),
  }).passthrough(),
  secondary: z.object({
    steamGenerators: z.array(z.object({ id: z.string().min(1), volume_m3: finite.positive(), steamDemand_kg_s: finite.positive() }).passthrough()).min(1),
  }).passthrough(),
  rods: z.object({ clusters: z.array(z.object({ id: z.string().min(1) }).passthrough()).min(1) }).passthrough(),
  feedback_metadata: z.object({ parameters: z.object({ rod_maximum_travel_m: finite.positive() }).passthrough() }).passthrough(),
  // Plan r4 X4.2: the CVCS section, when the packet composes it (its charging and letdown meet the port region).
  cvcs: z.object({ port: z.object({ region: index, id: z.string().min(1) }).passthrough() }).passthrough().optional(),
}).passthrough()
const feedTrainSchema = z.object({ nominalFlow_kg_s: finite.positive(), headerPressure_Pa: finite.positive(), suctionPressure_Pa: finite.positive() }).passthrough()

const side = z.union([z.object({ at_or_above: finite }).strict(), z.object({ at_or_below: finite }).strict()])
const icSchema = z.object({
  identity: z.string().min(1),
  frame_s: finite.positive(),
  families: z.array(z.object({
    id: z.string().min(1),
    quantity: z.union([
      z.literal('pzr_roof_pressure'),
      z.object({ pzr_level: z.object({}).passthrough() }).strict(),
      z.object({ sg_collapsed_level: z.object({ sg: z.string().min(1) }).passthrough() }).strict(),
      z.object({ sg_apparent_level: z.object({ sg: z.string().min(1) }).passthrough() }).strict(),
      z.object({ loop_flow: z.object({ loop_id: z.string().min(1), face: index, face_id: z.string().min(1) }).passthrough() }).strict(),
      z.object({ current_proxy: z.object({}).passthrough() }).strict(),
      z.object({ pump_speed: z.object({ rotor: index, rotor_id: z.string().min(1) }).strict() }).strict(),
      z.object({ cvcs_flow: z.object({ branch: z.string().min(1) }).strict() }).strict(),
      z.object({ bank_position: z.object({ normal_travel_m: finite.positive() }).strict() }).strict(),
      z.object({ stop_valve_position: z.object({ stop_travel_s: finite.positive() }).strict() }).strict(),
      // PHYS2: only in a section declaring the governor.
      z.literal('admission_position'),
      z.object({ sg_pressure: z.object({ sg: z.string().min(1) }).strict() }).strict(),
      z.object({ sg_flow_lag: z.object({ sg: z.string().min(1), flow: z.enum(['steam', 'feed']), nominal_kg_s: finite.positive() }).strict() }).strict(),
      z.object({ vessel_dp: z.object({ taps: z.array(z.object({}).passthrough()).min(1) }).strict() }).strict(),
      z.object({ plenum_dp: z.object({ region: index, region_id: z.string().min(1), lower_m: finite, upper_m: finite }).strict() }).strict(),
      z.object({ core_exit_temperature: z.object({ cells: z.array(z.object({ region: index, region_id: z.string().min(1) }).strict()).min(1), body_c: z.tuple([finite, finite]) }).strict() }).strict(),
    ]),
    channels: z.array(z.object({ id: z.string().min(1), supply: z.string().min(1) }).strict()).min(1),
    channel: z.object({ min: finite.nullable(), max: finite.nullable() }).passthrough(),
  }).passthrough()).min(1),
  reports: z.array(z.object({ id: z.string().min(1), source: z.union([z.enum(['turbine_retained_trip', 'bank_inserted']),
    // PHYS2's electrical reports (ld01-electrical-reports, PROC T1-T3): the AC routing's state.
    z.object({ bus_available: z.object({ bus: z.string().min(1) }).strict() }).strict(),
    z.object({ source_available: z.object({ source: z.enum(['unit', 'reserve']) }).strict() }).strict(),
    z.object({ source_qualified: z.object({ source: z.enum(['unit', 'reserve']) }).strict() }).strict(),
    z.object({ incoming_closed: z.object({ bus: z.string().min(1), source: z.enum(['unit', 'reserve']) }).strict() }).strict(),
    z.object({ incoming_travel_complete: z.object({ bus: z.string().min(1), source: z.enum(['unit', 'reserve']) }).strict() }).strict(),
    // PROC T5, ELEC's report-only DC groups: only in a section declaring them.
    z.object({ dc_output: z.object({ group: z.string().min(1) }).strict() }).strict(),
    z.object({ dc_charger: z.object({ group: z.string().min(1) }).strict() }).strict(),
    z.object({ dc_battery: z.object({ group: z.string().min(1) }).strict() }).strict(),
    z.object({ dc_cause: z.object({ group: z.string().min(1), cause: z.enum(['Overload', 'InsufficientSupply', 'OutputFailure']) }).strict() }).strict()]),
    supply: z.string().min(1) }).passthrough()),
  // PROC T5's labelled engineering values: for a person's judgement, no criterion reads them.
  engineering: z.array(z.object({ id: z.string().min(1), group: z.string().min(1), field: z.enum(['requested_w', 'delivered_w', 'energy_j', 'depletion_s']), unit: z.string().min(1), label: z.string().min(1) }).strict()).default([]),
  dc: z.object({ declared: z.boolean() }).passthrough().optional(),
  functions: z.array(z.object({
    id: z.string().min(1),
    rule: z.record(z.string(), z.object({ family: z.string().min(1).optional(), side: side.optional() }).passthrough()),
    effects: z.object({ reactor_trip: z.boolean(), cmt_injection: z.boolean(), heater_isolation: z.boolean(), prhr: z.boolean() }).strict(),
  }).passthrough()),
  holding: z.object({
    interface: z.string().min(1),
    divisions: z.array(z.string().min(1)).min(1),
    contacts: z.array(z.string().min(1)),
  }).passthrough(),
}).passthrough()

/** `ld01-dc-charging`: each DC group's normal charging bus, and the alternate a person may select. */
const dcChargingSchema = z.record(z.string().min(1), z.object({ normal: z.string().min(1), alternate: z.string().min(1).optional() }).strict())
type DcCharging = z.infer<typeof dcChargingSchema>
export const parseDcCharging = (dcPage: string): DcCharging => dcChargingSchema.parse(configurationBlock(dcPage, 'ld01-dc-charging'))

const elecSchema = z.object({
  distribution: z.object({ consumers: z.record(z.string().min(1), z.string().min(1)) }).passthrough(),
  slice: z.object({ generator: z.object({}).passthrough(), turbine: z.object({}).passthrough() }).passthrough(),
}).passthrough()

type Packet = z.infer<typeof packetSchema>
type Ic = z.infer<typeof icSchema>
type Elec = z.infer<typeof elecSchema>
type Family = Ic['families'][number]

type Reading = {
  readonly path: string
  readonly label: string
  readonly kind: 'state' | 'derived' | 'discrete'
  readonly discipline: 'hydraulic' | 'thermal' | 'nuclear' | 'electrical' | 'control'
  readonly quantity: string
  readonly unit: ProcessUnit
  readonly measurand?: string
  readonly channel: string
  readonly channelUnit: string
  /** Read in percent of this declared span (a level over its instrument's range), not by unit conversion. */
  readonly span?: { readonly min: number; readonly max: number; readonly declaredBy: string }
  readonly tagId?: string
  /** Other tag ids this reading answers for (a procedure's single tag read on one declared channel). */
  readonly externalRefs?: ReadonlyArray<string>
  readonly limits?: Record<string, unknown>
}
type Command = { readonly path: string; readonly label: string; readonly actuation: 'command' | 'faultInjection'; readonly command: Ld01Command; readonly momentary: boolean }

/** The kernel's protection requests as ld01-unit.rs names their channels, by the IC function effect that raises them. */
const requestChannels: ReadonlyArray<readonly [keyof Ic['functions'][number]['effects'], string, string]> = [
  ['prhr', 'LD01.PROT.PRHR.REQUEST', 'PRHR actuation request'],
  ['cmt_injection', 'LD01.PROT.CMT.REQUEST', 'CMT injection request'],
  ['heater_isolation', 'LD01.PROT.HEATER_ISOLATION.REQUEST', 'PZR heater isolation request'],
]

/** A channel id's last dot segment (LD01.PZR.PT1 → PT1), a reading's local name on its equipment. */
const lastSegment = (id: string): string => id.slice(id.lastIndexOf('.') + 1)

/** A family's protection setpoints as alarm limits: trips on a falling value low then low-low, on a rising one high then high-high. */
const familyLimits = (ic: Ic, family: Family, channelUnit: string, unit: ProcessUnit): Record<string, unknown> | undefined => {
  const sides = ic.functions.flatMap(entry => Object.values(entry.rule).flatMap(rule => rule.family === family.id && rule.side !== undefined ? [rule.side] : []))
  const below = [...new Set(sides.flatMap(entry => 'at_or_below' in entry ? [entry.at_or_below] : []))].sort((a, b) => b - a)
  const above = [...new Set(sides.flatMap(entry => 'at_or_above' in entry ? [entry.at_or_above] : []))].sort((a, b) => a - b)
  if (below.length > 2 || above.length > 2) throw new Error(`${family.id} has more protection setpoints than four alarm limits hold`)
  const convert = (value: number): number => convertLd01Value(channelUnit, unit, value)
  const alarmLimits = {
    ...(below.length === 2 ? { low: convert(below[0]!), lowLow: convert(below[1]!) } : below.length === 1 ? { lowLow: convert(below[0]!) } : {}),
    ...(above.length === 2 ? { high: convert(above[0]!), highHigh: convert(above[1]!) } : above.length === 1 ? { highHigh: convert(above[0]!) } : {}),
  }
  const { min, max } = family.channel
  const instrumentSpan = min === null || max === null ? undefined : { min: convert(min), max: convert(max) }
  const limits = { ...(instrumentSpan === undefined ? {} : { instrumentSpan }), ...(Object.keys(alarmLimits).length === 0 ? {} : { alarmLimits }) }
  return Object.keys(limits).length === 0 ? undefined : limits
}

/** The SG an SG level family measures (collapsed or, with the apparent level, apparent), or null. */
const sgOfLevel = (quantity: Family['quantity']): string | null =>
  typeof quantity !== 'object' ? null : 'sg_collapsed_level' in quantity ? quantity.sg_collapsed_level.sg : 'sg_apparent_level' in quantity ? quantity.sg_apparent_level.sg : null

/** How each IC quantity reads on its equipment: unit, quantity and label of its channels. */
const familyReading = (family: Family): Omit<Reading, 'path' | 'channel' | 'tagId' | 'limits' | 'label'> & { readonly label: (suffix: string) => string } => {
  const quantity = family.quantity
  if (quantity === 'pzr_roof_pressure') return { kind: 'derived', discipline: 'thermal', quantity: 'pressure', unit: 'MPa', channelUnit: 'Pa', label: suffix => `Pressurizer pressure channel ${suffix}` }
  if (quantity === 'admission_position') return { kind: 'derived', discipline: 'control', quantity: 'ratio', unit: 'percent', measurand: 'position', channelUnit: '%', label: () => 'Turbine admission valve position channel' }
  if ('pzr_level' in quantity) return { kind: 'derived', discipline: 'hydraulic', quantity: 'length', unit: 'm', channelUnit: 'm', label: suffix => `Pressurizer level channel ${suffix}` }
  const sg = sgOfLevel(quantity)
  if (sg !== null) return { kind: 'derived', discipline: 'hydraulic', quantity: 'length', unit: 'm', channelUnit: 'm', label: suffix => `SG ${sg} narrow-range level channel ${suffix}` }
  if ('loop_flow' in quantity) return { kind: 'derived', discipline: 'hydraulic', quantity: 'ratio', unit: 'fraction', measurand: 'flow', channelUnit: '1', label: () => `Loop ${quantity.loop_flow.loop_id} flow channel (of nominal)` }
  if ('current_proxy' in quantity) return { kind: 'derived', discipline: 'nuclear', quantity: 'power', unit: 'percent', channelUnit: '1', label: suffix => `Power proxy channel ${suffix}` }
  if ('cvcs_flow' in quantity) return { kind: 'derived', discipline: 'hydraulic', quantity: 'flowRate', unit: 'kg/s', channelUnit: 'kg/s', label: () => `CVCS ${quantity.cvcs_flow.branch.toLowerCase()} flow channel` }
  if ('bank_position' in quantity) return { kind: 'derived', discipline: 'nuclear', quantity: 'ratio', unit: 'fraction', measurand: 'position', channelUnit: '1', label: () => 'Control bank position channel (of the normal stroke)' }
  if ('stop_valve_position' in quantity) return { kind: 'derived', discipline: 'control', quantity: 'ratio', unit: 'percent', measurand: 'position', channelUnit: '%', label: () => 'Turbine stop valve position channel' }
  // PHYS2's X4 channels, in the units the IC section compiles (SG PT Pa absolute; the FTs fractions of the one-SG nominal feed flow m0).
  if ('sg_pressure' in quantity) return { kind: 'derived', discipline: 'thermal', quantity: 'pressure', unit: 'MPa', channelUnit: 'Pa', label: () => `SG ${quantity.sg_pressure.sg} pressure channel` }
  if ('sg_flow_lag' in quantity) return { kind: 'derived', discipline: 'hydraulic', quantity: 'ratio', unit: 'fraction', measurand: 'flow', channelUnit: '1',
    label: () => quantity.sg_flow_lag.flow === 'steam' ? `SG ${quantity.sg_flow_lag.sg} steam flow channel (of nominal feed flow)` : `SG ${quantity.sg_flow_lag.sg} feed flow channel (of nominal feed flow)` }
  if ('vessel_dp' in quantity) return { kind: 'derived', discipline: 'hydraulic', quantity: 'pressureDelta', unit: 'Pa', channelUnit: 'Pa', label: suffix => `Core differential pressure channel ${suffix}` }
  if ('plenum_dp' in quantity) return { kind: 'derived', discipline: 'hydraulic', quantity: 'pressureDelta', unit: 'Pa', channelUnit: 'Pa', label: suffix => `Upper plenum differential pressure channel ${suffix}` }
  if ('core_exit_temperature' in quantity) return { kind: 'derived', discipline: 'thermal', quantity: 'temperature', unit: 'degC', channelUnit: 'degC', label: suffix => `Core-exit temperature channel ${suffix}` }
  if (!('pump_speed' in quantity)) throw new Error(`IC family ${family.id} has a quantity this compiler does not read`)
  return { kind: 'derived', discipline: 'hydraulic', quantity: 'ratio', unit: 'fraction', measurand: 'speed', channelUnit: '1', label: () => `RCP ${lastSegment(quantity.pump_speed.rotor_id)} speed channel (of reference)` }
}

/** Each channel of a family as a reading with its tag, span and setpoints, and its sample quality code beside it. */
const familyReadings = (ic: Ic, family: Family): ReadonlyArray<Reading> => {
  const shape = familyReading(family)
  const limits = familyLimits(ic, family, shape.channelUnit, shape.unit)
  return family.channels.flatMap(channel => {
    // The two CVCS FTs (LD01.INV.CHARGE.FT, LD01.INV.LETDOWN.FT) share their last segment: each reads by its branch.
    const suffix = typeof family.quantity === 'object' && 'cvcs_flow' in family.quantity ? channel.id.split('.').at(-2)!
      // An SG's steam and feed FTs (LD01.SG.A.FT.STEAM, LD01.FW.A.FT) read on the SG by flow.
      : typeof family.quantity === 'object' && 'sg_flow_lag' in family.quantity ? (family.quantity.sg_flow_lag.flow === 'steam' ? 'FT_STEAM' : 'FW_FT')
        // ADM's and the STOP's positions (LD01.TG.ADM.POS, LD01.TG.STOP.POS) share their last segment and read on one equipment.
        : family.quantity === 'admission_position' ? 'ADM_POS'
          : lastSegment(channel.id)
    const { label, ...rest } = shape
    return [
      { ...rest, path: suffix, label: label(suffix), channel: channel.id, tagId: channel.id, ...(limits === undefined ? {} : { limits }),
        // LD01-E0's single «LD01.CORE.POWER.NUCLEAR» reads the power proxy's division I1 channel (WORLD's declaration;
        // PHYS's tag map leaves the choice to WORLD: no range switching exists, each channel is shown as well).
        ...(typeof family.quantity === 'object' && 'current_proxy' in family.quantity && channel.supply === 'I1' ? { externalRefs: ['LD01.CORE.POWER.NUCLEAR'] } : {}) },
      { path: `${suffix}.quality`, label: `${label(suffix)} sample quality`, kind: 'discrete', discipline: 'control', quantity: 'count', unit: 'count', channel: `${channel.id}.QUALITY`, channelUnit: '1' },
    ] satisfies ReadonlyArray<Reading>
  })
}

const reading = (path: string, label: string, kind: Reading['kind'], discipline: Reading['discipline'], quantity: string, unit: ProcessUnit, channel: string, channelUnit: string, measurand?: string): Reading =>
  ({ path, label, kind, discipline, quantity, unit, channel, channelUnit, ...(measurand === undefined ? {} : { measurand }) })

interface Equipment {
  readonly id: string
  readonly kind: string
  readonly label: string
  readonly parameters: Record<string, unknown>
  readonly readings: Reading[]
  readonly commands: Command[]
  readonly keyValues: string[]
  loopId?: string
  ordinal?: number
}

export interface OperatingGraph {
  readonly graph: PlantGraphSpec
  readonly tagMap: Ld01TagMap
  /**
   * The kernel protection as the Pack's alarm and trip state: one rule per IC function whose condition reads only the
   * kernel's own latch count (`.LATCHED`, divisions holding the cause), and one for the holding voltage. No setpoint, vote
   * or qualification is evaluated here: the kernel decides and acts; these rules only annunciate what it latched.
   */
  readonly automation: Record<string, unknown>
  /** What the graph does not model, stated plainly (the graph file carries it). */
  readonly scope: ReadonlyArray<string>
}

export const compileOperatingGraph = (input: { readonly packet: unknown; readonly ic: unknown; readonly elec: unknown; readonly sha8: string; readonly dcCharging?: DcCharging }): OperatingGraph => {
  const packet: Packet = packetSchema.parse(input.packet)
  const ic: Ic = icSchema.parse(input.ic)
  const elec: Elec = elecSchema.parse(input.elec)
  const regions = packet.mechanics.regions
  const regionId = (at: number): string => {
    const region = regions[at]
    if (region === undefined) throw new Error(`region ${at} is not in the mechanics`)
    return region.id
  }
  const cell = packet.pzr.cell
  const core = new Set(packet.source_water)
  const sgBySecondary = new Map<string, number>()
  for (const segment of packet.thermal.sg_segments) {
    const secondary = packet.secondary.steamGenerators[segment.secondary]
    if (secondary === undefined) throw new Error(`SG segment secondary ${segment.secondary} is not a steam generator`)
    const known = sgBySecondary.get(secondary.id)
    if (known !== undefined && known !== segment.primary) throw new Error(`SG ${secondary.id} has segments on regions ${known} and ${segment.primary}`)
    sgBySecondary.set(secondary.id, segment.primary)
  }
  const pumpRegions = new Map(packet.hydraulics.sections.filter(section => section.parameters.pump !== null && section.parameters.pump !== undefined).map(section => [section.region, section.id]))
  for (const at of [...core, ...sgBySecondary.values(), ...pumpRegions.keys(), cell.index]) regionId(at)

  // Every region but the core's is its own equipment; the core's regions are one core.
  const componentOf = (at: number): string => core.has(at) ? 'CORE' : regionId(at)
  const equipment = new Map<string, Equipment>()
  const volume = (at: number): number => regions[at]!.volume_m3
  const coreVolume = [...core].reduce((sum, at) => sum + volume(at), 0)
  equipment.set('CORE', { id: 'CORE', kind: 'nativeReactorCore', label: 'Reactor core', parameters: { volumeM3: coreVolume, powerReading: 'releasedPower' }, readings: [], commands: [], keyValues: ['releasedPower'] })
  for (const [at, region] of regions.entries()) {
    if (core.has(at)) continue
    const secondary = [...sgBySecondary].find(([, primary]) => primary === at)?.[0]
    if (secondary !== undefined) {
      const sg = packet.secondary.steamGenerators.find(entry => entry.id === secondary)!
      equipment.set(region.id, { id: region.id, kind: 'nativeSteamGenerator', label: `Steam generator ${secondary}`, parameters: { primaryVolumeM3: region.volume_m3, secondaryVolumeM3: sg.volume_m3 }, readings: [], commands: [], keyValues: [], loopId: secondary })
    } else if (pumpRegions.has(at)) {
      equipment.set(region.id, { id: region.id, kind: 'nativeCoolantPump', label: `Reactor coolant pump ${lastSegment(region.id)}`, parameters: { speedReading: 'speed' }, readings: [], commands: [], keyValues: ['speed'] })
    } else if (at === cell.index) {
      equipment.set(region.id, { id: region.id, kind: 'nativePressurizer', label: 'Pressurizer', parameters: { volumeM3: cell.fluidVolume_m3, bottomM: cell.bottom_m, topM: cell.top_m }, readings: [], commands: [], keyValues: ['pressure', 'collapsedLevel'] })
    } else {
      equipment.set(region.id, { id: region.id, kind: 'nativeCoolantVolume', label: `Coolant volume ${region.id}`, parameters: { volumeM3: region.volume_m3, elevationM: region.elevation_m }, readings: [], commands: [], keyValues: [] })
    }
  }
  const at = (id: string): Equipment => {
    const found = equipment.get(id)
    if (found === undefined) throw new Error(`no equipment ${id}`)
    return found
  }

  // Coolant links: one per pair of equipment the faces join, the core's own faces inside it.
  const pzrFaces = new Map(cell.ports.flatMap(port => port.face === null ? [] : [[port.face, port.kind] as const]))
  const coolantLinks = new Map<string, { readonly from: string; readonly to: string; readonly toPort: string }>()
  for (const [faceIndex, face] of packet.mechanics.faces.entries()) {
    const from = componentOf(face.from)
    const to = componentOf(face.to)
    if (from === to) continue
    const portKind = face.to === cell.index ? pzrFaces.get(faceIndex) : undefined
    if (face.to === cell.index && portKind !== 'surge' && portKind !== 'spray') throw new Error(`face ${face.id} enters the PZR at no surge or spray port`)
    const toKind = at(to).kind
    const toPort = portKind === 'surge' ? 'surgeLine' : portKind === 'spray' ? 'sprayInlet' : toKind === 'nativeSteamGenerator' ? 'primaryInlet' : toKind === 'nativeCoolantPump' ? 'suction' : 'inlet'
    coolantLinks.set(`${from}->${to}`, { from, to, toPort })
  }
  const fromPort = (id: string): string => ({ nativeSteamGenerator: 'primaryOutlet', nativeCoolantPump: 'discharge', nativePressurizer: 'surgeLine' } as Record<string, string>)[at(id).kind] ?? 'outlet'

  // A loop: the equipment on a cycle through its SG once every other SG is taken out.
  const successors = new Map<string, string[]>()
  for (const link of coolantLinks.values()) successors.set(link.from, [...(successors.get(link.from) ?? []), link.to])
  const reach = (start: string, blocked: ReadonlySet<string>, next: (node: string) => ReadonlyArray<string>): ReadonlySet<string> => {
    const seen = new Set([start])
    const queue = [start]
    while (queue.length > 0) for (const node of next(queue.shift()!)) if (!blocked.has(node) && !seen.has(node)) { seen.add(node); queue.push(node) }
    return seen
  }
  const predecessors = (node: string): ReadonlyArray<string> => [...coolantLinks.values()].filter(link => link.to === node).map(link => link.from)
  const loopsOf = new Map<string, string[]>()
  for (const [loop, primary] of sgBySecondary) {
    const sg = regionId(primary)
    const blocked = new Set([...sgBySecondary.values()].map(regionId).filter(id => id !== sg))
    const forward = reach(sg, blocked, node => successors.get(node) ?? [])
    const backward = reach(sg, blocked, predecessors)
    for (const id of forward) if (backward.has(id)) loopsOf.set(id, [...(loopsOf.get(id) ?? []), loop])
  }
  for (const [id, loops] of loopsOf) if (loops.length === 1) at(id).loopId = loops[0]!
  for (const loop of sgBySecondary.keys()) {
    [...equipment.values()].filter(item => item.kind === 'nativeCoolantPump' && item.loopId === loop).forEach((pump, ordinal) => { pump.ordinal = ordinal })
  }

  // Readings: the unit's channels on the equipment they measure.
  const pzr = at(regionId(cell.index))
  for (const family of ic.families) {
    const quantity = family.quantity
    // The STOP's and ADM's positions read on the turbine-generator, placed with it below.
    if (quantity === 'admission_position' || (typeof quantity === 'object' && 'stop_valve_position' in quantity)) continue
    const owner = quantity === 'pzr_roof_pressure' || 'pzr_level' in quantity ? pzr
      : sgOfLevel(quantity) !== null ? at(regionId(sgBySecondary.get(sgOfLevel(quantity)!) ?? Number.NaN))
        : 'loop_flow' in quantity ? at(componentOf(packet.mechanics.faces[quantity.loop_flow.face]!.from))
          : 'current_proxy' in quantity ? at('CORE')
            : 'pump_speed' in quantity ? at(quantity.pump_speed.rotor_id)
              : 'bank_position' in quantity ? at('CORE')
                : 'cvcs_flow' in quantity ? (packet.cvcs === undefined ? null : at(componentOf(packet.cvcs.port.region)))
                  : 'sg_pressure' in quantity ? at(regionId(sgBySecondary.get(quantity.sg_pressure.sg) ?? Number.NaN))
                    : 'sg_flow_lag' in quantity ? at(regionId(sgBySecondary.get(quantity.sg_flow_lag.sg) ?? Number.NaN))
                      : 'vessel_dp' in quantity || 'core_exit_temperature' in quantity ? at('CORE')
                        : 'plenum_dp' in quantity ? at(componentOf(quantity.plenum_dp.region))
                  : null
    if (owner === null) throw new Error(`IC family ${family.id} measures a quantity the graph places on no equipment`)
    owner.readings.push(...familyReadings(ic, family))
  }
  pzr.readings.push(
    reading('pressure', 'Pressurizer pressure (PT1 tap)', 'state', 'thermal', 'pressure', 'MPa', 'LD01.PZR.PRESSURE', 'Pa'),
    reading('collapsedLevel', 'Pressurizer collapsed level (above the cell bottom)', 'state', 'hydraulic', 'length', 'm', 'LD01.PZR.LEVEL.COLLAPSED', 'm'),
    reading('mixtureLevel', 'Pressurizer mixture level (above the cell bottom)', 'state', 'hydraulic', 'length', 'm', 'LD01.PZR.LEVEL.MIXTURE', 'm'),
    reading('heaterRequest', 'Pressurizer heater request in force', 'derived', 'control', 'power', 'MW', 'LD01.PZR.HEATER.REQUEST', 'W'),
  )
  // The PZR level over the span its LT family indicates over (the IC section declares it), its level aspect.
  const lt = ic.families.find(family => typeof family.quantity === 'object' && 'pzr_level' in family.quantity)
  if (lt !== undefined && lt.channel.min !== null && lt.channel.max !== null) {
    pzr.readings.push({ ...reading('levelPercent', `Pressurizer collapsed level (% of the ${lt.id} span)`, 'state', 'hydraulic', 'ratio', 'percent', 'LD01.PZR.LEVEL.COLLAPSED', 'm', 'level'), span: { min: lt.channel.min, max: lt.channel.max, declaredBy: `IC family ${lt.id}` } })
    pzr.parameters.levelReading = 'levelPercent'
    pzr.keyValues.splice(1, 1, 'levelPercent')
  }
  pzr.commands.push({ path: 'reliefStuckOpen', label: 'Pressurizer relief valve fails open', actuation: 'faultInjection', command: { kind: 'ReliefStuckOpen' }, momentary: false })
  for (const family of ic.families) {
    const quantity = family.quantity
    if (typeof quantity === 'object' && 'loop_flow' in quantity) {
      at(componentOf(packet.mechanics.faces[quantity.loop_flow.face]!.from)).readings.push(reading('flow', `Loop ${quantity.loop_flow.loop_id} mass flow at its cold return`, 'state', 'hydraulic', 'flowRate', 'kg/s', `LD01.RCS.${quantity.loop_flow.loop_id}.FLOW`, 'kg/s'))
      at(componentOf(packet.mechanics.faces[quantity.loop_flow.face]!.from)).keyValues.push('flow')
    }
    const sg = sgOfLevel(quantity)
    if (sg !== null) {
      // ld01-unit.rs delivers an SG's pressure and collapsed level beside its narrow-range family, and its apparent level with one.
      const apparent = typeof quantity === 'object' && 'sg_apparent_level' in quantity
      const generator = at(regionId(sgBySecondary.get(sg)!))
      const level = apparent ? `LD01.SG.${sg}.LEVEL.APPARENT` : `LD01.SG.${sg}.LEVEL.COLLAPSED`
      generator.readings.push(
        reading('pressure', `SG ${sg} secondary pressure`, 'state', 'thermal', 'pressure', 'MPa', `LD01.SG.${sg}.PRESSURE`, 'Pa'),
        reading('collapsedLevel', `SG ${sg} collapsed level (narrow-range area)`, 'state', 'hydraulic', 'length', 'm', `LD01.SG.${sg}.LEVEL.COLLAPSED`, 'm'),
        ...(apparent ? [reading('apparentLevel', `SG ${sg} apparent level (narrow-range area)`, 'state', 'hydraulic', 'length', 'm', level, 'm')] : []),
      )
      // Its level over the narrow-range span the family indicates over, its level aspect.
      if (family.channel.min !== null && family.channel.max !== null) {
        generator.readings.push({ ...reading('levelPercent', `SG ${sg} ${apparent ? 'apparent' : 'collapsed'} level (% of the ${family.id} span)`, 'state', 'hydraulic', 'ratio', 'percent', level, 'm', 'level'), span: { min: family.channel.min, max: family.channel.max, declaredBy: `IC family ${family.id}` } })
        generator.parameters.levelReading = 'levelPercent'
      }
      generator.keyValues.push('pressure', family.channel.min !== null && family.channel.max !== null ? 'levelPercent' : apparent ? 'apparentLevel' : 'collapsedLevel')
    }
    if (typeof quantity === 'object' && 'pump_speed' in quantity) {
      const suffix = lastSegment(quantity.pump_speed.rotor_id)
      const consumers = Object.keys(elec.distribution.consumers).filter(id => lastSegment(id) === suffix)
      if (consumers.length !== 1) throw new Error(`RCP ${quantity.pump_speed.rotor_id} has ${consumers.length} ELEC consumers named ${suffix}`)
      const pump = at(quantity.pump_speed.rotor_id)
      pump.readings.push(reading('speed', `RCP ${suffix} shaft speed`, 'state', 'hydraulic', 'rotationalSpeed', 'rpm', `${consumers[0]}.OMEGA`, 'rad/s'))
      pump.commands.push({ path: 'supplyLoss', label: `RCP ${suffix} supply lost`, actuation: 'faultInjection', command: { kind: 'SupplyLoss', rotor: quantity.pump_speed.rotor }, momentary: false })
    }
  }
  const coreEquipment = at('CORE')
  coreEquipment.readings.push(
    reading('releasedPower', 'Reactor released power', 'state', 'nuclear', 'power', 'MW', 'LD01.CORE.RELEASED_POWER', 'W'),
    ...packet.rods.clusters.map(cluster => reading(`rod.${cluster.id}`, `Rod cluster ${cluster.id} travel`, 'state', 'nuclear', 'length', 'm', `LD01.ROD.${cluster.id}.TRAVEL`, 'm')),
    reading('rodTravelMean', 'Rod cluster mean travel', 'state', 'nuclear', 'length', 'm', 'LD01.ROD.TRAVEL.MEAN', 'm'),
  )
  // Each cluster's travel moves over the packet's maximum travel. The generated displays draw an insertion part by part,
  // at most 16 to a node; the 52 clusters move as one bank (EVT-RODS-BANK), so the core leads with their mean travel instead.
  const maximumTravel = packet.feedback_metadata.parameters.rod_maximum_travel_m
  for (const entry of coreEquipment.readings) {
    if (entry.path.startsWith('rod.')) (entry as { limits?: Record<string, unknown> }).limits = { hardRange: { min: 0, max: maximumTravel } }
  }
  coreEquipment.keyValues.push('rodTravelMean')
  // Leg and plenum temperatures (ld01-unit.rs: mass-weighted over a loop's hot and cold leg regions, the core's inlet
  // the lower plenum, its outlet the upper), each on the first region it is weighted over.
  for (const family of ic.families) {
    const quantity = family.quantity
    if (typeof quantity !== 'object' || !('loop_flow' in quantity)) continue
    const loop = quantity.loop_flow.loop_id
    for (const [leg, prefix, label] of [['THOT', 'HOT', 'hot-leg temperature (Thot)'], ['TCOLD', 'COLD', 'cold-leg temperature (Tcold)']] as const) {
      const region = regions.find(entry => entry.id === `${prefix}.${loop}` || entry.id.startsWith(`${prefix}.${loop}.`))
      if (region === undefined) throw new Error(`loop ${loop} has no ${prefix}.${loop} region`)
      at(componentOf(regions.indexOf(region))).readings.push(reading('temperature', `Loop ${loop} ${label}`, 'state', 'thermal', 'temperature', 'degC', `LD01.RCS.${loop}.${leg}`, 'K'))
      at(componentOf(regions.indexOf(region))).keyValues.push('temperature')
    }
  }
  for (const [region, channel, label] of [['LOWER', 'LD01.CORE.INLET.T', 'Core inlet temperature (lower plenum)'], ['UPPER', 'LD01.CORE.OUTLET.T', 'Core outlet temperature (upper plenum)']] as const) {
    at(region).readings.push(reading('temperature', label, 'state', 'thermal', 'temperature', 'degC', channel, 'K'))
    at(region).keyValues.push('temperature')
  }

  // The turbine-generator of the ELEC slice, fed by every SG's steam.
  const turbine: Equipment = {
    id: 'TG', kind: 'nativeTurbineGenerator', label: 'Turbine-generator', parameters: { powerReading: 'terminalPower', speedReading: 'shaftSpeed' },
    readings: [
      reading('terminalPower', 'Generator terminal export power', 'state', 'electrical', 'power', 'MW', 'LD01.TG.GEN.WT', 'W'),
      reading('shaftSpeed', 'Turbine-generator shaft speed', 'state', 'electrical', 'rotationalSpeed', 'rpm', 'LD01.TG.SHAFT.OMEGA', 'rad/s'),
      reading('breakerClosed', 'Generator breaker closed', 'discrete', 'electrical', 'boolean', 'boolean', 'LD01.TG.GEN.BREAKER.CLOSED', '1'),
      reading('exportEnergy', 'Generator export energy since load', 'state', 'electrical', 'energy', 'MJ', 'LD01.TG.GEN.EXPORT_ENERGY', 'J'),
      reading('fieldProtectionInitiated', 'Field-supply-loss protection initiated', 'discrete', 'control', 'boolean', 'boolean', 'LD01.TG.GEN.FIELD.INITIATED', '1'),
      reading('offsiteLost', 'Offsite connection lost', 'discrete', 'electrical', 'boolean', 'boolean', 'LD01.GRID.OFFSITE_LOST', '1'),
    ],
    // The unit composes the acquired protection, so the manual turbine trip's reactor-trip request travels the acquired
    // path (turbine-state report, division processors, holding contacts): the kernel's TurbineTripAcquired, never S2's.
    commands: [{ path: 'turbineTrip', label: 'Turbine trip', actuation: 'command', command: { kind: 'TurbineTripAcquired' }, momentary: true }],
    keyValues: ['terminalPower', 'shaftSpeed'],
  }
  for (const family of ic.families) {
    if (family.quantity === 'admission_position' || (typeof family.quantity === 'object' && 'stop_valve_position' in family.quantity)) turbine.readings.push(...familyReadings(ic, family))
  }
  equipment.set(turbine.id, turbine)
  // The IC section's state reports (ld01-unit.rs reads each as a 0/1 channel and its quality): the turbine's
  // retained-trip report on the turbine-generator, the complete-bank inserted report on the core.
  // PHYS2's electrical reports (the AC routing's and the report-only DC groups' state) read on the turbine-generator,
  // beside its offsite-connection reading: the graph has no distribution equipment; each keeps its own tag id.
  const dcLabel = (group: string): string => `DC group ${group.replace(/^LD01\.DC\./, '')}`
  const electricalLabel = (source: Exclude<Ic['reports'][number]['source'], string>): string =>
    'bus_available' in source ? `Bus ${source.bus_available.bus} available report`
      : 'source_available' in source ? `${source.source_available.source === 'unit' ? 'Unit' : 'Reserve'} source available report`
        : 'source_qualified' in source ? `${source.source_qualified.source === 'unit' ? 'Unit' : 'Reserve'} source qualified report`
          : 'incoming_closed' in source ? `Bus ${source.incoming_closed.bus} ${source.incoming_closed.source} incoming breaker closed report`
            : 'incoming_travel_complete' in source ? `Bus ${source.incoming_travel_complete.bus} ${source.incoming_travel_complete.source} incoming breaker travel complete report`
              : 'dc_output' in source ? `${dcLabel(source.dc_output.group)} output available report`
                : 'dc_charger' in source ? `${dcLabel(source.dc_charger.group)} charger delivering report`
                  : 'dc_battery' in source ? `${dcLabel(source.dc_battery.group)} battery available report`
                    : `${dcLabel(source.dc_cause.group)} opening cause ${source.dc_cause.cause} report`
  for (const report of ic.reports) {
    const electrical = typeof report.source === 'object'
    const owner = report.source === 'turbine_retained_trip' || electrical ? turbine : coreEquipment
    const suffix = electrical ? report.id.replace(/^LD01\./, '').split('.').join('-') : report.id.split('.').slice(-2).join('-')
    const label = typeof report.source === 'object' ? electricalLabel(report.source)
      : report.source === 'turbine_retained_trip' ? 'Turbine tripped state report' : 'Control bank inserted report (every cluster seated)'
    owner.readings.push(
      { ...reading(suffix, `${label} (supply ${report.supply})`, 'discrete', electrical ? 'electrical' : 'control', 'boolean', 'boolean', report.id, '1'), tagId: report.id },
      reading(`${suffix}.quality`, `${label} sample quality`, 'discrete', 'control', 'count', 'count', `${report.id}.QUALITY`, '1'),
    )
  }

  // PROC T5's engineering values, labelled estimates and indications: no criterion reads them, and each keeps its tag id.
  const engineeringUnits = { W: ['power', 'kW'], J: ['energy', 'MJ'], s: ['time', 's'] } as const satisfies Record<string, readonly [string, ProcessUnit]>
  for (const value of ic.engineering) {
    const units = engineeringUnits[value.unit as keyof typeof engineeringUnits]
    if (units === undefined) throw new Error(`${value.id}: the graph reads no engineering value in ${value.unit}`)
    turbine.readings.push({ ...reading(value.id.replace(/^LD01\./, '').split('.').join('-'), `${dcLabel(value.group)}: ${value.label}`, 'derived', 'electrical', units[0], units[1], value.id, value.unit), tagId: value.id })
  }
  // The operator's local electrical commands (PROC T4, T11, T5): each incoming device the section reports, each supply
  // consumer, and each DC group's OPEN, RESET and CLOSE, RESET and CLOSE separate; the selectable charger inputs from `ld01-dc-charging`.
  const momentary = (path: string, label: string, command: Ld01Command): Command => ({ path, label, actuation: 'command', command, momentary: true })
  for (const report of ic.reports) {
    if (typeof report.source !== 'object' || !('incoming_closed' in report.source)) continue
    const { bus, source } = report.source.incoming_closed
    for (const [verb, target] of [['open', 'Open'], ['close', 'Closed']] as const) {
      turbine.commands.push(momentary(`incoming.${bus}.${source}.${verb}`, `${verb === 'open' ? 'Open' : 'Close'} bus ${bus} ${source} incoming breaker`, { kind: 'IncomingDevice', bus, source, target }))
    }
  }
  for (const consumer of Object.keys(elec.distribution.consumers)) {
    turbine.commands.push(momentary(`start.${consumer}`, `Start ${consumer}`, { kind: 'StartConsumer', consumer }))
  }
  if (ic.dc?.declared === true) {
    if (input.dcCharging === undefined) throw new Error('The section declares the DC groups: the graph needs their ld01-dc-charging block')
    const groups = [...new Set(ic.reports.flatMap(report => typeof report.source === 'object' && 'dc_output' in report.source ? [report.source.dc_output.group] : []))]
    for (const group of groups) {
      const charging = input.dcCharging[group]
      if (charging === undefined) throw new Error(`${group} has no ld01-dc-charging record`)
      for (const [verb, action] of [['open', 'Open'], ['reset', 'Reset'], ['close', 'Close']] as const) {
        turbine.commands.push(momentary(`dc.${group}.${verb}`, `${dcLabel(group)} distribution ${action.toUpperCase()}`, { kind: 'DcDistribution', group, action }))
      }
      if (charging.alternate !== undefined) {
        for (const bus of [charging.normal, charging.alternate]) {
          turbine.commands.push(momentary(`dc.${group}.charger.${bus}`, `${dcLabel(group)} charger input ${bus}`, { kind: 'DcChargerInput', group, bus }))
        }
      }
    }
  }

  // The protection: each function's latch, each division's trip and supply, the permissive contacts, the holding voltage, the requests.
  const protection: Equipment = {
    id: 'PROTECTION', kind: 'nativeProtectionSystem', label: 'Reactor protection', parameters: {},
    readings: [
      ...ic.functions.map(entry => reading(`latched.${entry.id}`, `${entry.id} divisions latched`, 'discrete', 'control', 'count', 'count', `${entry.id}.LATCHED`, '1')),
      ...ic.holding.divisions.flatMap(division => [
        reading(`division.${division}.trip`, `Protection division ${division} tripped`, 'discrete', 'control', 'boolean', 'boolean', `LD01.PROT.${division}.TRIP`, '1'),
        reading(`division.${division}.powered`, `Protection division ${division} supplied`, 'discrete', 'electrical', 'boolean', 'boolean', `LD01.PROT.${division}.POWERED`, '1'),
      ]),
      ...ic.holding.contacts.map(contact => reading(`contact.${contact}`, `Permissive contact ${contact} closed`, 'discrete', 'control', 'boolean', 'boolean', `${contact}.CLOSED`, '1')),
      reading('holdingAvailable', `${ic.holding.interface} holding voltage available`, 'discrete', 'electrical', 'boolean', 'boolean', `${ic.holding.interface}.AVAILABLE`, '1'),
      ...requestChannels.filter(([effect]) => ic.functions.some(entry => entry.effects[effect])).map(([, channel, label]) => reading(`request.${lastSegment(channel.slice(0, channel.lastIndexOf('.')))}`, `${label} (divisions)`, 'discrete', 'control', 'count', 'count', channel, '1')),
    ],
    commands: [
      { path: 'manualReactorTrip', label: 'Manual reactor trip', actuation: 'command', command: { kind: 'ManualReactorTrip' }, momentary: true },
      { path: 'holdingLoss', label: 'Holding supply lost', actuation: 'faultInjection', command: { kind: 'HoldingLoss' }, momentary: false },
    ],
    keyValues: [],
  }
  equipment.set(protection.id, protection)

  // The feed train the packet declares (plan r4 X4.1): its header and each SG's branch control valve, read from the SG
  // owner. The secondary closes through it; the turbine's condensate reaches the header through a condenser and pumps
  // the unit does not model, a link that carries no reading (scope).
  const feedTrain = packet.secondary.feedTrain === undefined ? null : feedTrainSchema.parse(packet.secondary.feedTrain)
  const scope: string[] = []
  if (feedTrain !== null) {
    equipment.set('FW.HEADER', { id: 'FW.HEADER', kind: 'nativeFeedHeader', label: 'Feedwater header', parameters: { nominalFlowKgPerS: 2 * feedTrain.nominalFlow_kg_s, headerPressurePa: feedTrain.headerPressure_Pa }, readings: [], commands: [], keyValues: [] })
    for (const [loop] of sgBySecondary) {
      const valve: Equipment = {
        id: `FW.FCV.${loop}`, kind: 'nativeFeedValve', label: `Feedwater control valve ${loop}`,
        parameters: { positionReading: 'position', flowReading: 'flow', nominalFlowKgPerS: feedTrain.nominalFlow_kg_s },
        readings: [
          reading('position', `Feedwater control valve ${loop} stem position`, 'state', 'control', 'ratio', 'fraction', `LD01.FW.${loop}.FCV.POSITION`, '1', 'position'),
          reading('flow', `Feedwater branch ${loop} flow`, 'state', 'hydraulic', 'flowRate', 'kg/s', `LD01.FW.${loop}.FLOW`, 'kg/s'),
        ],
        commands: [], keyValues: ['flow'], loopId: loop,
      }
      equipment.set(valve.id, valve)
      at(regionId(sgBySecondary.get(loop)!)).readings.push(
        reading('feedNr1', `SG ${loop} level control NR1 (apparent, lagged)`, 'derived', 'control', 'length', 'm', `LD01.FW.${loop}.NR1`, 'm'),
        reading('steamFlow', `SG ${loop} steam flow (level control, lagged)`, 'derived', 'control', 'flowRate', 'kg/s', `LD01.FW.${loop}.STEAM.FLOW`, 'kg/s'),
      )
    }
    scope.push(`The secondary closes through the feed train the packet declares (feedTrain: header ${feedTrain.headerPressure_Pa} Pa, branch nominal ${feedTrain.nominalFlow_kg_s} kg/s). No condenser, condensate or feed-pump flow model joins the turbine to it: the link TG:FW.HEADER (role not-modelled-condensate-return) is structure only and reads nothing; the feed pumps take suction at ${feedTrain.suctionPressure_Pa} Pa as the unit's boundary.`)
  } else {
    scope.push('The packet declares no feed train: the secondary ends at the turbine-generator.')
  }

  for (const item of equipment.values()) {
    for (const entry of item.readings) if (entry.span === undefined && !ld01ConversionExists(entry.channelUnit, entry.unit)) throw new Error(`${item.id}.${entry.path}: the engine converts no ${entry.channelUnit} to ${entry.unit}`)
  }

  const steamLinks = [...sgBySecondary].map(([loop, primary]) => {
    const sg = packet.secondary.steamGenerators.find(entry => entry.id === loop)!
    return {
      id: `${regionId(primary)}:TG`, from: `${regionId(primary)}.steamOutlet`, to: 'TG.steamInlet', connectionKind: 'fluidFlow' as const,
      service: 'mainSteam', nominalFluid: 'steam' as const, designPhase: 'steam' as const, solverModel: 'nativeUnit' as const, physical: { nominalFlowKgPerS: sg.steamDemand_kg_s }, metadata: { loopId: loop }, variables: [],
    }
  })
  const graph: PlantGraphSpec = {
    schemaVersion: 1,
    id: `ld01.${input.sha8}` as PlantGraphSpec['id'],
    title: `LD-01 (${packet.identity}, ${ic.identity})`,
    timestep: { fixedStepMs: Math.round(ic.frame_s * 1_000) },
    components: [...equipment.values()].map(item => ({
      id: item.id as PlantGraphSpec['components'][number]['id'],
      kind: item.kind as PlantGraphSpec['components'][number]['kind'],
      label: item.label,
      parameters: {
        ...item.parameters,
        readings: item.readings.map(({ channel: _channel, channelUnit: _unit, tagId: _tag, externalRefs: _refs, limits: _limits, span: _span, ...rest }) => rest),
        commands: item.commands.map(({ command: _command, momentary: _momentary, ...rest }) => rest),
        keyValues: item.keyValues,
      },
      ...(item.loopId === undefined && item.commands.every(command => !command.momentary) ? {} : {
        metadata: {
          ...(item.loopId === undefined ? {} : { loopId: item.loopId }),
          ...(item.ordinal === undefined ? {} : { ordinal: item.ordinal }),
          ...(item.commands.some(command => command.momentary) ? { presentation: { momentary: item.commands.filter(command => command.momentary).map(command => command.path) } } : {}),
        },
      }),
      variables: item.readings.flatMap(entry => entry.tagId === undefined && entry.limits === undefined ? [] : [{
        path: entry.path, ...(entry.tagId === undefined ? {} : { tagId: entry.tagId }), ...(entry.externalRefs === undefined ? {} : { externalRefs: [...entry.externalRefs] }),
        ...(entry.limits === undefined ? {} : { limits: entry.limits }),
      }]),
    })) as PlantGraphSpec['components'],
    connections: [
      ...[...coolantLinks.values()].map(link => {
        const loops = [at(link.from).loopId, at(link.to).loopId]
        return {
          id: `${link.from}:${link.to}`, from: `${link.from}.${fromPort(link.from)}`, to: `${link.to}.${link.toPort}`, connectionKind: 'fluidFlow' as const,
          service: 'reactorCoolant', nominalFluid: 'water' as const, designPhase: 'liquid' as const, solverModel: 'nativeUnit' as const,
          ...(loops[0] !== undefined && loops[0] === loops[1] ? { metadata: { loopId: loops[0] } } : {}),
          variables: [],
        }
      }),
      ...steamLinks,
      ...(feedTrain === null ? [] : [
        { id: 'TG:FW.HEADER', from: 'TG.condensateReturn', to: 'FW.HEADER.inlet', connectionKind: 'fluidFlow' as const, service: 'feedwater', nominalFluid: 'water' as const, designPhase: 'liquid' as const, solverModel: 'nativeUnit' as const, metadata: { role: 'not-modelled-condensate-return' }, variables: [] },
        ...[...sgBySecondary].flatMap(([loop, primary]) => [
          { id: `FW.HEADER:FW.FCV.${loop}`, from: 'FW.HEADER.outlet', to: `FW.FCV.${loop}.inlet`, connectionKind: 'fluidFlow' as const, service: 'feedwater', nominalFluid: 'water' as const, designPhase: 'liquid' as const, solverModel: 'nativeUnit' as const, physical: { nominalFlowKgPerS: feedTrain.nominalFlow_kg_s }, metadata: { loopId: loop }, variables: [] },
          { id: `FW.FCV.${loop}:${regionId(primary)}`, from: `FW.FCV.${loop}.outlet`, to: `${regionId(primary)}.feedwaterInlet`, connectionKind: 'fluidFlow' as const, service: 'feedwater', nominalFluid: 'water' as const, designPhase: 'liquid' as const, solverModel: 'nativeUnit' as const, physical: { nominalFlowKgPerS: feedTrain.nominalFlow_kg_s }, metadata: { loopId: loop }, variables: [] },
        ]),
      ]),
    ] as unknown as PlantGraphSpec['connections'],
    publishedVariables: [...equipment.values()].flatMap(item => [...item.readings, ...item.commands].map(entry => `${item.id}.${entry.path}`)) as unknown as PlantGraphSpec['publishedVariables'],
  }
  const tagMap: Ld01TagMap = {
    channels: Object.fromEntries([...equipment.values()].flatMap(item => item.readings.map(entry => [`${item.id}.${entry.path}`, entry.span === undefined ? entry.channel : { channel: entry.channel, span: { min: entry.span.min, max: entry.span.max }, declaredBy: entry.span.declaredBy }]))),
    commands: Object.fromEntries([...equipment.values()].flatMap(item => item.commands.map(entry => [`${item.id}.${entry.path}`, entry.command]))),
  }
  // The graph compiles against the registry as a Plant would load it.
  compilePlantGraph(graph, processPlantComponentRegistry)
  const effectWords = (effects: Ic['functions'][number]['effects']): string =>
    [effects.reactor_trip && 'reactor trip', effects.cmt_injection && 'CMT injection', effects.heater_isolation && 'PZR heater isolation', effects.prhr && 'PRHR'].filter(Boolean).join(', ') || 'no actuation'
  const automation = {
    annunciatorSystems: [{ id: 'LD01.PROTECTION', label: 'Reactor protection (kernel)', shortLabel: 'RPS' }],
    rules: [
      ...ic.functions.map(entry => ({
        id: entry.id,
        label: `${entry.id} (kernel protection latch)`,
        ruleClass: entry.effects.reactor_trip ? 'protection' : 'alarm',
        condition: { type: 'comparison', signal: { path: `PROTECTION.latched.${entry.id}` }, operator: '>=', value: 1 },
        latch: false,
        effects: [{
          type: entry.effects.reactor_trip ? 'trip.enter' : 'alarm.enter',
          id: `${entry.id}.ANNUNCIATED`,
          title: entry.id,
          message: `The kernel protection latched ${entry.id} in a division (${effectWords(entry.effects)})`,
          severity: entry.effects.reactor_trip ? 'critical' : 'warning',
          annunciator: { system: 'LD01.PROTECTION', role: 'cause', priority: entry.effects.reactor_trip ? 'urgent' : 'high' },
        }],
      })),
      {
        id: `${ic.holding.interface}.LOST`,
        label: `${ic.holding.interface} holding voltage lost (rods released)`,
        ruleClass: 'protection',
        condition: { type: 'comparison', signal: { path: 'PROTECTION.holdingAvailable' }, operator: '==', value: false },
        latch: false,
        effects: [{
          type: 'trip.enter', id: `${ic.holding.interface}.LOST.ANNUNCIATED`, title: 'Reactor trip',
          message: `The kernel's holding chain ${ic.holding.interface} has no voltage: the rods are released`,
          severity: 'critical', annunciator: { system: 'LD01.PROTECTION', role: 'automaticAction', priority: 'urgent' },
        }],
      },
    ],
  }
  return { graph, tagMap, scope, automation }
}

const sha256 = (bytes: string | Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

if (import.meta.main) {
  const [packetPath, icPath, elecPath, outputDirectory, ...rest] = Bun.argv.slice(2)
  if (!packetPath || !icPath || !elecPath || !outputDirectory || rest.length > 1) {
    throw new Error('Usage: reference-design-operating-graph <joined packet> <ic section> <elec packet> <new output directory> [<DC page, with a section declaring the DC groups>]')
  }
  const dcPage = rest[0] === undefined ? undefined : readFileSync(rest[0], 'utf8')
  const [packetText, icText, elecText] = [packetPath, icPath, elecPath].map(path => readFileSync(path, 'utf8')) as [string, string, string]
  const sources = { packet: sha256(packetText), ic: sha256(icText), elec: sha256(elecText), ...(dcPage === undefined ? {} : { dcPage: sha256(dcPage) }) }
  const compiled = compileOperatingGraph({ packet: JSON.parse(packetText), ic: JSON.parse(icText), elec: JSON.parse(elecText), sha8: sha256(JSON.stringify(sources)).slice(0, 8), ...(dcPage === undefined ? {} : { dcCharging: parseDcCharging(dcPage) }) })
  const text = `${JSON.stringify({ format: 'ld01-plant-graph', sources, scope: compiled.scope, graph: compiled.graph, tagMap: compiled.tagMap, automation: compiled.automation }, null, 1)}\n`
  if (existsSync(outputDirectory)) throw new Error(`${outputDirectory} exists: the compiler writes only into a new directory`)
  mkdirSync(outputDirectory, { recursive: true })
  const file = join(outputDirectory, `ld01-graph-${sha256(text).slice(0, 8)}.json`)
  writeFileSync(file, text)
  writeFileSync(join(outputDirectory, 'RECEIPT.txt'), [
    `ld01-graph ${sha256(text)} ${file}`,
    `packet ${sources.packet} ${packetPath}`,
    `ic ${sources.ic} ${icPath}`,
    `elec ${sources.elec} ${elecPath}`,
    ...(rest[0] === undefined ? [] : [`dc page ${sources.dcPage} ${rest[0]}`]),
    `components ${compiled.graph.components.length} connections ${compiled.graph.connections.length} channels ${Object.keys(compiled.tagMap.channels).length} commands ${Object.keys(compiled.tagMap.commands).length}`,
    '',
  ].join('\n'))
  console.log(file)
}
