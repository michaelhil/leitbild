import { z } from 'zod'
import { variablePathSchema, type CompiledPlantGraph, type CompiledVariable, type ProcessUnit, type VariablePath } from '../graph/index.ts'

// The LD-01 tag map: which `ld01-unit` channel each graph variable reads, and which kernel command each
// command variable sends (scripts/reference-design-operating-graph.ts writes it beside the graph). The native
// engine binds it against the child's CHANNELS at LOAD and refuses any missing channel, any graph variable
// the map does not cover, and any unit pair the closed conversion table below does not hold.

export const ld01CommandKinds = ['TurbineTrip', 'TurbineTripAcquired', 'ManualReactorTrip', 'HoldingLoss', 'ReliefStuckOpen', 'SupplyLoss'] as const
export type Ld01CommandKind = typeof ld01CommandKinds[number]

export const ld01CommandSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.enum(['TurbineTrip', 'TurbineTripAcquired', 'ManualReactorTrip', 'HoldingLoss', 'ReliefStuckOpen']) }).strict(),
  z.object({ kind: z.literal('SupplyLoss'), rotor: z.number().int().nonnegative() }).strict(),
])
export type Ld01Command = z.infer<typeof ld01CommandSchema>

/** A channel read in percent of a span the packet or IC section declares (a level over its instrument's range). */
const spanChannelSchema = z.object({
  channel: z.string().min(1),
  span: z.object({ min: z.number().finite(), max: z.number().finite() }).strict().refine(span => span.max > span.min, 'a span from its min up to its max'),
  /** Where the span is declared, e.g. the IC family whose channels indicate over it. */
  declaredBy: z.string().min(1),
}).strict()
export type Ld01SpanChannel = z.infer<typeof spanChannelSchema>

export const ld01TagMapSchema = z.object({
  /** Graph variable path → the child's channel id, or the channel read in percent of a declared span. */
  channels: z.record(variablePathSchema, z.union([z.string().min(1), spanChannelSchema])),
  /** Writable momentary graph variable path → the kernel command writing true sends. */
  commands: z.record(variablePathSchema, ld01CommandSchema),
}).strict()
export type Ld01TagMap = z.infer<typeof ld01TagMapSchema>

export const ld01ChannelSchema = z.object({
  id: z.string().min(1),
  unit: z.string(),
  quantity: z.string().min(1),
  source: z.string().min(1),
}).strict()
export type Ld01Channel = z.infer<typeof ld01ChannelSchema>

type Conversion =
  | { readonly kind: 'scale'; readonly factor: number; readonly divisor: number; readonly offset: number }
  | { readonly kind: 'flag' }

const scale = (factor: number, divisor = 1, offset = 0): Conversion => ({ kind: 'scale', factor, divisor, offset })

/** The closed table from a channel's unit to a graph variable's unit: SI to the Plant's display units (value × factor ÷ divisor + offset). */
const conversions: Readonly<Record<string, Conversion>> = {
  'Pa->Pa': scale(1),
  'Pa->MPa': scale(1, 1e6),
  'W->MW': scale(1, 1e6),
  'J->MJ': scale(1, 1e6),
  'rad/s->rpm': scale(60, 2 * Math.PI),
  'm->m': scale(1),
  'kg/s->kg/s': scale(1),
  'K->degC': scale(1, 1, -273.15),
  'degC->degC': scale(1),
  's->s': scale(1),
  '1->fraction': scale(1),
  '1->percent': scale(100),
  '%->percent': scale(1),
  '1->count': scale(1),
  '1->boolean': { kind: 'flag' },
}

/** A number in a channel's unit as a graph variable of `variableUnit` reads it (a reading or a setpoint); throws where the table holds no such pair. */
export const convertLd01Value = (channelUnit: string, variableUnit: ProcessUnit, value: number): number => {
  const conversion = conversions[`${channelUnit}->${variableUnit}`]
  if (conversion?.kind !== 'scale') throw new Error(`no LD-01 conversion from ${channelUnit} to ${variableUnit}`)
  return value * conversion.factor / conversion.divisor + conversion.offset
}

/** The channel id a tag map entry reads. */
export const ld01ChannelIdOf = (entry: string | Ld01SpanChannel): string => typeof entry === 'string' ? entry : entry.channel

/** Whether the table converts a channel's unit to a graph variable's unit (the compiler emits only such pairs). */
export const ld01ConversionExists = (channelUnit: string, variableUnit: ProcessUnit): boolean =>
  conversions[`${channelUnit}->${variableUnit}`] !== undefined

export type Ld01BoundVariable =
  | { readonly kind: 'channel'; readonly variable: CompiledVariable; readonly channel: number; readonly conversion: Conversion }
  | { readonly kind: 'span'; readonly variable: CompiledVariable; readonly channel: number; readonly span: { readonly min: number; readonly max: number } }
  | { readonly kind: 'command'; readonly variable: CompiledVariable; readonly command: Ld01Command }

export interface Ld01Binding {
  readonly byPath: ReadonlyMap<VariablePath, Ld01BoundVariable>
  readonly channelCount: number
}

/** Binds the tag map to the graph and the child's channels; throws with every reason it does not hold. */
export const bindLd01TagMap = (graph: CompiledPlantGraph, tagMap: Ld01TagMap, channels: ReadonlyArray<Ld01Channel>): Ld01Binding => {
  const channelIndex = new Map(channels.map((channel, index) => [channel.id, index]))
  const problems: string[] = []
  const byPath = new Map<VariablePath, Ld01BoundVariable>()
  for (const variable of graph.variables) {
    const entry = tagMap.channels[variable.path]
    const channelId = entry === undefined ? undefined : ld01ChannelIdOf(entry)
    const command = tagMap.commands[variable.path]
    if (channelId !== undefined && command !== undefined) {
      problems.push(`${variable.path} is mapped to channel ${channelId} and to command ${command.kind}`)
      continue
    }
    if (command !== undefined) {
      if (!variable.descriptor.writable || variable.descriptor.quantity !== 'boolean') problems.push(`${variable.path} sends ${command.kind} but is not a writable boolean`)
      else byPath.set(variable.path, { kind: 'command', variable, command })
      continue
    }
    if (channelId === undefined) {
      problems.push(`${variable.path} has no channel or command in the tag map`)
      continue
    }
    const index = channelIndex.get(channelId)
    if (index === undefined) {
      problems.push(`${variable.path} reads channel ${channelId}, which the unit does not deliver`)
      continue
    }
    if (variable.descriptor.writable) problems.push(`${variable.path} reads channel ${channelId} but is writable`)
    const channel = channels[index]!
    if (typeof entry === 'object') {
      if (variable.descriptor.unit !== 'percent' || channel.unit !== 'm') problems.push(`${variable.path} reads ${channelId} (${channel.unit}) in percent of a span in metres, but is in ${variable.descriptor.unit}`)
      else byPath.set(variable.path, { kind: 'span', variable, channel: index, span: entry.span })
      continue
    }
    const conversion = conversions[`${channel.unit}->${variable.descriptor.unit}`]
    if (conversion === undefined) {
      problems.push(`${variable.path} (${variable.descriptor.unit}) has no conversion from channel ${channelId} (${channel.unit})`)
      continue
    }
    if ((conversion.kind === 'flag') !== (variable.descriptor.quantity === 'boolean')) problems.push(`${variable.path} is ${variable.descriptor.quantity} but channel ${channelId} converts as ${conversion.kind}`)
    byPath.set(variable.path, { kind: 'channel', variable, channel: index, conversion })
  }
  const variablePaths = new Set<string>(graph.variables.map(variable => variable.path))
  for (const path of [...Object.keys(tagMap.channels), ...Object.keys(tagMap.commands)]) {
    if (!variablePaths.has(path)) problems.push(`the tag map names ${path}, which the graph does not declare`)
  }
  if (problems.length > 0) throw new Error(`LD-01 tag map does not bind to the unit's channels: ${problems.join('; ')}`)
  return { byPath, channelCount: channels.length }
}

/** A channel sample as its graph variable reads it. A flag is exactly 0 or 1; anything else is a fault, never a guess. */
export const convertLd01Channel = (bound: Exclude<Ld01BoundVariable, { kind: 'command' }>, sample: number): number | boolean => {
  if (bound.kind === 'span') return (sample - bound.span.min) / (bound.span.max - bound.span.min) * 100
  if (bound.conversion.kind === 'flag') {
    if (sample === 0) return false
    if (sample === 1) return true
    throw new Error(`${bound.variable.path} reads flag ${sample}, neither 0 nor 1`)
  }
  return sample * bound.conversion.factor / bound.conversion.divisor + bound.conversion.offset
}
