/** The LD-01 Plant Model graph and its tag map (r4 shell design §3), compiled from the packets the
 * `ld01-unit` child loads: the joined packet (mechanics regions and faces, the PZR cell and its ports, the SG
 * segments and secondaries, the fission source's regions, the pumps' hydraulic sections, the rod clusters), the
 * IC section (instrument families and their channels, the protection functions, the holding chain) and the ELEC
 * packet (the turbine-generator, the RCP supply consumers). Every component, link, reading and limit comes from
 * them: regions become coolant volumes, the source's regions one core, each SG's primary region a steam
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
}).passthrough()

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
      z.object({ loop_flow: z.object({ loop_id: z.string().min(1), face: index, face_id: z.string().min(1) }).passthrough() }).strict(),
      z.object({ current_proxy: z.object({}).passthrough() }).strict(),
      z.object({ pump_speed: z.object({ rotor: index, rotor_id: z.string().min(1) }).strict() }).strict(),
    ]),
    channels: z.array(z.object({ id: z.string().min(1), supply: z.string().min(1) }).strict()).min(1),
    channel: z.object({ min: finite.nullable(), max: finite.nullable() }).passthrough(),
  }).passthrough()).min(1),
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
  readonly tagId?: string
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

/** How each IC quantity reads on its equipment: unit, quantity and label of its channels. */
const familyReading = (family: Family): Omit<Reading, 'path' | 'channel' | 'tagId' | 'limits' | 'label'> & { readonly label: (suffix: string) => string } => {
  const quantity = family.quantity
  if (quantity === 'pzr_roof_pressure') return { kind: 'derived', discipline: 'thermal', quantity: 'pressure', unit: 'MPa', channelUnit: 'Pa', label: suffix => `Pressurizer pressure channel ${suffix}` }
  if ('pzr_level' in quantity) return { kind: 'derived', discipline: 'hydraulic', quantity: 'length', unit: 'm', channelUnit: 'm', label: suffix => `Pressurizer level channel ${suffix}` }
  if ('sg_collapsed_level' in quantity) return { kind: 'derived', discipline: 'hydraulic', quantity: 'length', unit: 'm', channelUnit: 'm', label: suffix => `SG ${quantity.sg_collapsed_level.sg} narrow-range level channel ${suffix}` }
  if ('loop_flow' in quantity) return { kind: 'derived', discipline: 'hydraulic', quantity: 'ratio', unit: 'fraction', measurand: 'flow', channelUnit: '1', label: () => `Loop ${quantity.loop_flow.loop_id} flow channel (of nominal)` }
  if ('current_proxy' in quantity) return { kind: 'derived', discipline: 'nuclear', quantity: 'power', unit: 'percent', channelUnit: '1', label: suffix => `Power proxy channel ${suffix}` }
  return { kind: 'derived', discipline: 'hydraulic', quantity: 'ratio', unit: 'fraction', measurand: 'speed', channelUnit: '1', label: () => `RCP ${lastSegment(quantity.pump_speed.rotor_id)} speed channel (of reference)` }
}

/** Each channel of a family as a reading with its tag, span and setpoints, and its sample quality code beside it. */
const familyReadings = (ic: Ic, family: Family): ReadonlyArray<Reading> => {
  const shape = familyReading(family)
  const limits = familyLimits(ic, family, shape.channelUnit, shape.unit)
  return family.channels.flatMap(channel => {
    const suffix = lastSegment(channel.id)
    const { label, ...rest } = shape
    return [
      { ...rest, path: suffix, label: label(suffix), channel: channel.id, tagId: channel.id, ...(limits === undefined ? {} : { limits }) },
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
}

export const compileOperatingGraph = (input: { readonly packet: unknown; readonly ic: unknown; readonly elec: unknown; readonly sha8: string }): OperatingGraph => {
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
    const owner = quantity === 'pzr_roof_pressure' || 'pzr_level' in quantity ? pzr
      : 'sg_collapsed_level' in quantity ? at(regionId(sgBySecondary.get(quantity.sg_collapsed_level.sg) ?? Number.NaN))
        : 'loop_flow' in quantity ? at(componentOf(packet.mechanics.faces[quantity.loop_flow.face]!.from))
          : 'current_proxy' in quantity ? at('CORE')
            : at(quantity.pump_speed.rotor_id)
    owner.readings.push(...familyReadings(ic, family))
  }
  pzr.readings.push(
    reading('pressure', 'Pressurizer pressure (PT1 tap)', 'state', 'thermal', 'pressure', 'MPa', 'LD01.PZR.PRESSURE', 'Pa'),
    reading('collapsedLevel', 'Pressurizer collapsed level (above the cell bottom)', 'state', 'hydraulic', 'length', 'm', 'LD01.PZR.LEVEL.COLLAPSED', 'm'),
    reading('mixtureLevel', 'Pressurizer mixture level (above the cell bottom)', 'state', 'hydraulic', 'length', 'm', 'LD01.PZR.LEVEL.MIXTURE', 'm'),
    reading('heaterRequest', 'Pressurizer heater request in force', 'derived', 'control', 'power', 'MW', 'LD01.PZR.HEATER.REQUEST', 'W'),
  )
  pzr.commands.push({ path: 'reliefStuckOpen', label: 'Pressurizer relief valve fails open', actuation: 'faultInjection', command: { kind: 'ReliefStuckOpen' }, momentary: false })
  for (const family of ic.families) {
    const quantity = family.quantity
    if (typeof quantity === 'object' && 'loop_flow' in quantity) {
      at(componentOf(packet.mechanics.faces[quantity.loop_flow.face]!.from)).readings.push(reading('flow', `Loop ${quantity.loop_flow.loop_id} mass flow at its cold return`, 'state', 'hydraulic', 'flowRate', 'kg/s', `LD01.RCS.${quantity.loop_flow.loop_id}.FLOW`, 'kg/s'))
      at(componentOf(packet.mechanics.faces[quantity.loop_flow.face]!.from)).keyValues.push('flow')
    }
    if (typeof quantity === 'object' && 'sg_collapsed_level' in quantity) {
      const sg = quantity.sg_collapsed_level.sg
      // ld01-unit.rs delivers an SG's pressure and collapsed level beside its narrow-range family.
      const generator = at(regionId(sgBySecondary.get(sg)!))
      generator.readings.push(
        reading('pressure', `SG ${sg} secondary pressure`, 'state', 'thermal', 'pressure', 'MPa', `LD01.SG.${sg}.PRESSURE`, 'Pa'),
        reading('collapsedLevel', `SG ${sg} collapsed level (narrow-range area)`, 'state', 'hydraulic', 'length', 'm', `LD01.SG.${sg}.LEVEL.COLLAPSED`, 'm'),
      )
      generator.keyValues.push('pressure', 'collapsedLevel')
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
    ...packet.rods.clusters.map(cluster => reading(`rod.${cluster.id}`, `Rod cluster ${cluster.id} travel`, 'state', 'nuclear', 'length', 'm', `LD01.ROD.y[${cluster.id}]`, 'm')),
  )

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
    commands: [{ path: 'turbineTrip', label: 'Turbine trip', actuation: 'command', command: { kind: 'TurbineTrip' }, momentary: true }],
    keyValues: ['terminalPower', 'shaftSpeed'],
  }
  equipment.set(turbine.id, turbine)

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

  for (const item of equipment.values()) {
    for (const entry of item.readings) if (!ld01ConversionExists(entry.channelUnit, entry.unit)) throw new Error(`${item.id}.${entry.path}: the engine converts no ${entry.channelUnit} to ${entry.unit}`)
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
        readings: item.readings.map(({ channel: _channel, channelUnit: _unit, tagId: _tag, limits: _limits, ...rest }) => rest),
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
        path: entry.path, ...(entry.tagId === undefined ? {} : { tagId: entry.tagId }), ...(entry.limits === undefined ? {} : { limits: entry.limits }),
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
    ] as unknown as PlantGraphSpec['connections'],
    publishedVariables: [...equipment.values()].flatMap(item => [...item.readings, ...item.commands].map(entry => `${item.id}.${entry.path}`)) as unknown as PlantGraphSpec['publishedVariables'],
  }
  const tagMap: Ld01TagMap = {
    channels: Object.fromEntries([...equipment.values()].flatMap(item => item.readings.map(entry => [`${item.id}.${entry.path}`, entry.channel]))),
    commands: Object.fromEntries([...equipment.values()].flatMap(item => item.commands.map(entry => [`${item.id}.${entry.path}`, entry.command]))),
  }
  // The graph compiles against the registry as a Plant would load it.
  compilePlantGraph(graph, processPlantComponentRegistry)
  return { graph, tagMap }
}

const sha256 = (bytes: string | Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

if (import.meta.main) {
  const [packetPath, icPath, elecPath, outputDirectory, ...rest] = Bun.argv.slice(2)
  if (!packetPath || !icPath || !elecPath || !outputDirectory || rest.length > 0) {
    throw new Error('Usage: reference-design-operating-graph <joined packet> <ic section> <elec packet> <new output directory>')
  }
  const [packetText, icText, elecText] = [packetPath, icPath, elecPath].map(path => readFileSync(path, 'utf8')) as [string, string, string]
  const sources = { packet: sha256(packetText), ic: sha256(icText), elec: sha256(elecText) }
  const compiled = compileOperatingGraph({ packet: JSON.parse(packetText), ic: JSON.parse(icText), elec: JSON.parse(elecText), sha8: sha256(JSON.stringify(sources)).slice(0, 8) })
  const text = `${JSON.stringify({ format: 'ld01-plant-graph', sources, graph: compiled.graph, tagMap: compiled.tagMap }, null, 1)}\n`
  if (existsSync(outputDirectory)) throw new Error(`${outputDirectory} exists: the compiler writes only into a new directory`)
  mkdirSync(outputDirectory, { recursive: true })
  const file = join(outputDirectory, `ld01-graph-${sha256(text).slice(0, 8)}.json`)
  writeFileSync(file, text)
  writeFileSync(join(outputDirectory, 'RECEIPT.txt'), [
    `ld01-graph ${sha256(text)} ${file}`,
    `packet ${sources.packet} ${packetPath}`,
    `ic ${sources.ic} ${icPath}`,
    `elec ${sources.elec} ${elecPath}`,
    `components ${compiled.graph.components.length} connections ${compiled.graph.connections.length} channels ${Object.keys(compiled.tagMap.channels).length} commands ${Object.keys(compiled.tagMap.commands).length}`,
    '',
  ].join('\n'))
  console.log(file)
}
