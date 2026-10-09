import { z } from 'zod'
import type { VariablePath } from '../../graph/index.ts'

// An equipment mimic is a Pack-owned, reviewed drawing of one part of a Plant
// model ("view"), parameterised by loop. The agent chooses the view and loops;
// World owns the drawing, which signal shows each symbol's state, and the
// layout. Symbol states come only from measured or derived variables, never
// from writable commands: a pump's run command stays true without power and a
// valve's demand can read closed while the valve is stuck open.
export const composedMimicViewSchema = z.enum(['feed-to-sg'])
export type ComposedMimicView = z.infer<typeof composedMimicViewSchema>

export const mimicLoopSchema = z.string().regex(/^[A-F]$/)

export const MIMIC_WIDTH = 600

export type MimicSymbol = 'pump' | 'valve' | 'steam-generator' | 'header'

/** How a symbol shows its state, and from which variables. */
export type MimicState =
  /** Running when its speed is above zero: commanded and powered. The command only annotates a mismatch. */
  | { readonly kind: 'pump'; readonly speedPath: VariablePath; readonly commandPath: VariablePath }
  /**
   * Drawn from its actual (effective) position. The operator or controller
   * command only annotates a mismatch, which is how a stuck valve shows.
   */
  | { readonly kind: 'valve'; readonly positionPath: VariablePath; readonly commandPath: VariablePath }
  | { readonly kind: 'level'; readonly levelPath: VariablePath; readonly unit: string }
  | { readonly kind: 'none' }

/** A value printed beside its symbol, chosen by World. */
export interface MimicValue {
  readonly path: VariablePath
  readonly unit: string
  /** Where the tag sits relative to the symbol. */
  readonly side: 'left' | 'right'
}

export interface MimicNode {
  readonly id: string
  readonly componentId: string
  readonly symbol: MimicSymbol
  /** Short operator label, e.g. "FCV B". */
  readonly label: string
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  /** Flow through the symbol runs left to right (horizontal) or bottom to top (vertical). */
  readonly orientation: 'horizontal' | 'vertical'
  readonly state: MimicState
  readonly values: ReadonlyArray<MimicValue>
  /** I&C alarm and trip rules acting on this equipment; an active one frames the symbol. */
  readonly ruleIds: ReadonlyArray<string>
}

export interface MimicPipe {
  readonly id: string
  /** The Plant link this pipe draws. */
  readonly linkId: string
  readonly service: string
  /** Orthogonal polyline in flow direction. */
  readonly points: ReadonlyArray<readonly [number, number]>
  readonly flowPath: VariablePath
  /** Below this magnitude the pipe is drawn without flow ("≈0"). */
  readonly noFlowBelow: number
}

export interface CompiledMimic {
  readonly view: ComposedMimicView
  readonly loops: ReadonlyArray<string>
  readonly width: number
  readonly height: number
  readonly nodes: ReadonlyArray<MimicNode>
  readonly pipes: ReadonlyArray<MimicPipe>
  /** Every variable the mimic reads, for sampling. */
  readonly paths: ReadonlyArray<VariablePath>
}
