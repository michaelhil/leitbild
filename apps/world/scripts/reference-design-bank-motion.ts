/** Offline equivalent-bank mechanics, not an installed actuator or protection processor. */
import { z } from 'zod'

const fraction = z.number().finite().min(0).max(1)
const bankSchema = z.object({ referencePosition: fraction, ordinaryRate_s: z.number().finite().positive(),
  insertionRate_s: z.number().finite().positive(), worthPerStroke: z.number().finite().positive() }).strict()
export type BankBasis = z.infer<typeof bankSchema>
const stateSchema = z.object({ position: fraction, mode: z.enum(['HOLD', 'MANUAL']), requestedPosition: fraction,
  released: z.boolean() }).strict().refine(s => !s.released || (s.mode === 'HOLD' && s.requestedPosition === 0),
    'Released bank must retain HOLD and zero ordinary request')
export type BankState = z.infer<typeof stateSchema>
const supportSchema = z.object({ holdingVoltage: z.boolean(), ordinaryDrive: z.boolean(),
  releaseAvailable: z.boolean(), insertionStop: fraction }).strict()
export type BankSupport = z.infer<typeof supportSchema>
export type BankSegment = { duration_s: number; from: number; to: number }

export function parseBankBasis(document: string): BankBasis {
  const blocks = [...document.matchAll(/^```reference-bank-motion\s*\n([\s\S]*?)^```\s*$/gm)]
  if (blocks.length !== 1) throw Error('Expected one reference-bank-motion record')
  return bankSchema.parse(JSON.parse(blocks[0]![1]!))
}

/** Inputs are actual support states. A software trip request is deliberately not an input. */
export function advanceBank(basis: BankBasis, before: BankState, support: BankSupport, dt: number) {
  bankSchema.parse(basis); stateSchema.parse(before); supportSchema.parse(support)
  if (!Number.isFinite(dt) || dt < 0) throw Error('Invalid bank interval')
  if (support.insertionStop > before.position) throw Error('Obstruction is above the current bank position')
  const state = { ...before }
  // An empty interval advances neither mechanics nor discrete loss/recovery state.
  if (dt === 0) return { state, segments: [] as BankSegment[] }
  if (!support.holdingVoltage) {
    state.mode = 'HOLD'; state.requestedPosition = 0
    if (support.releaseAvailable) state.released = true
  }
  // Selected latch has no mid-travel recapture. The holding owner authorizes rearm.
  if (state.position === 0 && support.holdingVoltage) state.released = false
  const target = state.released ? support.insertionStop
    : support.holdingVoltage && support.ordinaryDrive && state.mode === 'MANUAL'
      ? Math.max(support.insertionStop, state.requestedPosition) : state.position
  const rate = state.released ? basis.insertionRate_s : basis.ordinaryRate_s
  const travel = Math.min(dt, Math.abs(target - state.position) / rate)
  const end = travel === Math.abs(target - state.position) / rate ? target
    : state.position + Math.sign(target - state.position) * rate * travel
  const segments: BankSegment[] = []
  if (travel > 0) segments.push({ duration_s: travel, from: state.position, to: end })
  if (travel < dt) segments.push({ duration_s: dt - travel, from: end, to: end })
  state.position = end
  if (end === 0 && support.holdingVoltage) state.released = false
  return { state, segments }
}
