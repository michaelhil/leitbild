import { z } from 'zod'
import type { LocalVariablePath, PortName, ProcessQuantity, ProcessUnit, VariablePath } from './model.ts'

// Model semantics: what equipment is and does, declared once per component
// kind beside its behaviour and never repeated per Plant instance. They are
// model truth for every reader (command validation, explanations, generated
// displays) and are not part of a Plant's identity: a Plant's digest covers its
// graph spec, not the declarations of its kinds.

/**
 * What writing a writable variable does:
 * - `command`: an operator or controller demand the equipment may not follow
 *   (a pump commanded to run that has lost power);
 * - `faultInjection`: a scenario knob that makes the model fail;
 * - `boundary`: a condition outside the Plant (the offsite grid, a makeup supply).
 */
export const variableActuationSchema = z.enum(['command', 'faultInjection', 'boundary'])
export type VariableActuation = z.infer<typeof variableActuationSchema>

/** What a ratio measures, so a reader can name it ("L LO" for a level). */
export const ratioMeasurandSchema = z.enum([
  'availability',
  'charge',
  'contamination',
  'coverage',
  'depletion',
  'effectiveness',
  'humidity',
  'insertion',
  'leak',
  'level',
  'load',
  'position',
  'quality',
  'served',
  'speed',
  'void',
  'voltage',
])
export type RatioMeasurand = z.infer<typeof ratioMeasurandSchema>

/** The aspects of equipment state an operator reads at a glance. */
export const stateAspectSchema = z.enum(['running', 'position', 'level', 'throughput', 'energized'])
export type StateAspect = z.infer<typeof stateAspectSchema>

/**
 * How a state variable reads as its aspect: running while a speed is above
 * zero, energized or open while true, a position or level as its value, and
 * throughput while a flow is above the no-flow band of its rated flow.
 */
export const aspectReadingSchema = z.enum(['aboveZero', 'true', 'value', 'flow'])
export type AspectReading = z.infer<typeof aspectReadingSchema>

/** What equipment does where its kind alone does not say: a valve modulates, isolates, stops reverse flow or relieves. */
export const equipmentFunctionSchema = z.enum(['modulating', 'isolating', 'nonReturn', 'relieving'])
export type EquipmentFunction = z.infer<typeof equipmentFunctionSchema>

export interface StateAspectDeclaration {
  readonly aspect: StateAspect
  /**
   * The solved variable that is the equipment's state for this aspect. Absent
   * when the model computes none (the PORV's position), so the aspect reads
   * "not measured" and is judged by what the model does solve.
   */
  readonly state?: { readonly variable: LocalVariablePath; readonly reading: AspectReading }
  /** The writable variable that demands this aspect. It only annotates a disagreement, never the state. */
  readonly command?: LocalVariablePath
}

/** Equipment the model bundles inside a component; it sits on the link that leaves one of the component's ports. */
export interface EmbeddedDeviceDeclaration {
  readonly id: string
  /** Generic name of the device ("relief valve"); a Plant may give it a short operator label. */
  readonly label: string
  readonly function: EquipmentFunction
  readonly port: string
  readonly aspects: ReadonlyArray<StateAspectDeclaration>
  /** The host's variables that belong to the device: their alarms concern the device, not the host. */
  readonly variables: ReadonlyArray<string>
}

export interface ComponentSemantics {
  readonly function?: EquipmentFunction
  readonly aspects: ReadonlyArray<StateAspectDeclaration>
  readonly embedded: ReadonlyArray<EmbeddedDeviceDeclaration>
  /** Rated flow out of a port, named by the parameter that holds it: the reference for "no flow" on the links it feeds. */
  readonly ratedOutflow: ReadonlyArray<{ readonly port: string; readonly parameter: string }>
}

/** Declares semantics that do not depend on a component's parameters. */
export const fixedSemantics = (semantics: Partial<ComponentSemantics>): ((parameters: unknown) => ComponentSemantics) => {
  const resolved: ComponentSemantics = { aspects: [], embedded: [], ratedOutflow: [], ...semantics }
  return () => resolved
}

/** A state aspect read from a solved variable, with the command that demands it. */
export const aspect = (
  name: StateAspect,
  state: { readonly variable: string; readonly reading: AspectReading } | undefined,
  command?: string,
): StateAspectDeclaration => ({
  aspect: name,
  ...(state === undefined ? {} : { state: { variable: state.variable as LocalVariablePath, reading: state.reading } }),
  ...(command === undefined ? {} : { command: command as LocalVariablePath }),
})

export interface CompiledStateAspect {
  readonly aspect: StateAspect
  readonly state?: { readonly path: VariablePath; readonly reading: AspectReading }
  readonly command?: VariablePath
}

export interface CompiledEmbeddedDevice {
  readonly id: string
  readonly label: string
  readonly function: EquipmentFunction
  readonly port: PortName
  readonly aspects: ReadonlyArray<CompiledStateAspect>
  readonly variables: ReadonlyArray<VariablePath>
}

export interface CompiledComponentSemantics {
  readonly function?: EquipmentFunction
  readonly aspects: ReadonlyArray<CompiledStateAspect>
  readonly embedded: ReadonlyArray<CompiledEmbeddedDevice>
  readonly ratedOutflow: ReadonlyArray<{ readonly port: PortName; readonly flowKgPerS: number }>
}

/** Which quantities and units each reading accepts. */
export const readingAccepts = (reading: AspectReading, descriptor: { readonly quantity: ProcessQuantity; readonly unit: ProcessUnit }): boolean => {
  if (reading === 'true') return descriptor.quantity === 'boolean'
  if (reading === 'flow') return descriptor.quantity === 'flowRate'
  if (reading === 'aboveZero') return descriptor.quantity === 'rotationalSpeed' || descriptor.quantity === 'flowRate' || descriptor.quantity === 'power'
  return descriptor.quantity === 'ratio'
}
