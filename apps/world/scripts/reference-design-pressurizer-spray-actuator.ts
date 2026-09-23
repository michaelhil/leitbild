/** Offline finite actuator/output-lifecycle reference. No spray hydraulics or plant controller. */
import { createHash } from 'node:crypto'

export const sprayActuatorBasis = {
  controlledRate_per_s: 0.5,
  manualRate_per_s: 0.1,
  openingDuty_W: 1000,
} as const

export type SprayState = { position: number; retainedDemand: number; outputValid: boolean }
export type ManualSprayState = { position: number; target: number }
export type Obstruction = { opening: boolean; closing: boolean }

function fraction(value: number) {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw Error('Opening must be in [0,1]')
}

function interval(dt_s: number) {
  if (!Number.isFinite(dt_s) || dt_s < 0) throw Error('Invalid simulated interval')
}

function travel(position: number, target: number, rate: number, dt_s: number, obstruction: Obstruction) {
  const difference = target - position
  const blocked = difference > 0 ? obstruction.opening : obstruction.closing
  const required_s = Math.abs(difference) / rate
  const motion_s = blocked ? 0 : Math.min(required_s, dt_s)
  const reached = !blocked && dt_s >= required_s
  return { position: reached ? target : position + Math.sign(difference) * rate * motion_s, motion_s, blocked: difference !== 0 && blocked }
}

/** Inputs remain constant over this interval; events split intervals, including power restoration. */
export function advanceControlledSpray(state: SprayState, input: {
  actB: boolean; localOutputAvailable: boolean; dt_s: number; obstruction: Obstruction;
  transferDemand?: number; updateDemand?: number;
}) {
  fraction(state.position)
  fraction(state.retainedDemand)
  interval(input.dt_s)
  if (input.transferDemand !== undefined && input.updateDemand !== undefined) throw Error('Transfer and ordinary update must be separate events')
  const available = input.actB && input.localOutputAvailable
  let outputValid = state.outputValid && available
  let retainedDemand = state.retainedDemand
  if (input.transferDemand !== undefined) {
    fraction(input.transferDemand)
    if (!available) throw Error('Transfer requires actual supported output')
    retainedDemand = input.transferDemand
    outputValid = true
  }
  if (input.updateDemand !== undefined) {
    fraction(input.updateDemand)
    if (!outputValid) throw Error('Ordinary update cannot restore invalid output')
    retainedDemand = input.updateDemand
  }
  const effectiveTarget = outputValid ? retainedDemand : 0
  const moved = travel(state.position, effectiveTarget, sprayActuatorBasis.controlledRate_per_s, input.dt_s, input.obstruction)
  // Requested opening work remains delivered into actuator/losses when mechanically blocked.
  const openingRequested = outputValid && effectiveTarget > state.position
  const poweredDuration_s = openingRequested ? (moved.blocked ? input.dt_s : moved.motion_s) : 0
  return {
    state: { position: moved.position, retainedDemand, outputValid }, effectiveTarget,
    motion_s: moved.motion_s, blocked: moved.blocked,
    openingWork_J: poweredDuration_s * sprayActuatorBasis.openingDuty_W,
  }
}

/** An accepted local hand operation; no ACT/I supply, normal mode or remote measurement implied. */
export function advanceManualSpray(state: ManualSprayState, dt_s: number, obstruction: Obstruction, newTarget?: number | null) {
  fraction(state.position)
  fraction(state.target)
  interval(dt_s)
  // Explicit cancellation stops the local operation at the actual stem, not an acquired pointer.
  const target = newTarget === null ? state.position : newTarget ?? state.target
  fraction(target)
  const moved = travel(state.position, target, sprayActuatorBasis.manualRate_per_s, dt_s, obstruction)
  return { state: { position: moved.position, target }, motion_s: moved.motion_s, blocked: moved.blocked }
}

export function sprayActuatorComparison() {
  const clear = { opening: false, closing: false }
  const supported = { actB: true, localOutputAvailable: true, obstruction: clear }
  const original: SprayState = { position: 0.8, retainedDemand: 0.8, outputValid: true }
  const lost = advanceControlledSpray(original, { ...supported, actB: false, dt_s: 0.5 })
  const recovered = advanceControlledSpray(lost.state, { ...supported, dt_s: 0.5 })
  const restored = advanceControlledSpray(recovered.state, { ...supported, transferDemand: 0.6, dt_s: 0.4 })
  const blocked = advanceControlledSpray(original, { ...supported, actB: false, dt_s: 2, obstruction: { opening: false, closing: true } })
  const copy = JSON.parse(JSON.stringify(recovered.state)) as SprayState
  return {
    scope: 'Constant-input finite actuator intervals and explicit output restoration; no acquired PT/position/FT, protection, nozzle, fluid or thermal qualification',
    basis: sprayActuatorBasis, original, lost, recovered, restored, blocked,
    copiedContinuation: advanceControlledSpray(copy, { ...supported, transferDemand: 0.6, dt_s: 0.4 }),
    manualRetained: advanceManualSpray({ position: 0.01, target: 0.01 }, 10, clear),
    manualClosed: advanceManualSpray({ position: 0.01, target: 0.01 }, 0.1, clear, 0),
  }
}

if (import.meta.main) {
  const [output, ...extra] = process.argv.slice(2)
  if (!output || extra.length) throw Error('Usage: pressurizer-spray-actuator <receipt.json>')
  const source = await Bun.file(import.meta.path).text()
  const hash = (value: string) => createHash('sha256').update(value).digest('hex')
  const result = sprayActuatorComparison()
  if (source !== await Bun.file(import.meta.path).text()) throw Error('Calculation source changed')
  const receipt = { sourceSha256: hash(source), resultSha256: hash(JSON.stringify(result)), result }
  await Bun.write(output, JSON.stringify(receipt, null, 2) + '\n')
  console.log(JSON.stringify({ output, sourceSha256: receipt.sourceSha256, resultSha256: receipt.resultSha256 }))
}
