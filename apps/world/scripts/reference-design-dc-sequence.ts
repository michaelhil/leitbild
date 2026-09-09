/** Offline exact piecewise DC energy/support reference. Not a plant runtime. */
import { createHash } from 'node:crypto'
import { z } from 'zod'

const positive = z.number().finite().positive()
const basisSchema = z.object({
  usableEnergy_kWh: positive,
  continuousDuty_W: positive,
  chargerLimit_W: positive,
  outputLimit_W: positive,
  chargeEfficiency: positive.max(1),
  dischargeEfficiency: positive.max(1),
  converterEfficiency: positive.max(1),
}).strict()
export type DcBasis = z.infer<typeof basisSchema>
export function parseDcBasis(page: string): DcBasis {
  const blocks = [...page.matchAll(/^```reference-dc-actuation\s*\n([\s\S]*?)^```\s*$/gm)]
  if (blocks.length !== 1) throw Error('Expected one reference-dc-actuation block')
  return basisSchema.parse(JSON.parse(blocks[0]![1]!))
}

type Inputs = { requested_W: number; chargerAvailable: boolean; batteryAvailable: boolean; outputHealthy: boolean }
type Command = 'reset' | 'close' | 'open'
export type Boundary = { at_s: number; changes?: Partial<Inputs>; commands?: Command[] }
export type DcState = {
  time_s: number; energy_J: number; outputClosed: boolean;
  cause: 'overload' | 'insufficient_supply' | 'output_failure' | null;
  sourceEnergy_J: number; deliveredEnergy_J: number; lossEnergy_J: number;
}
const inputsSchema = z.object({ requested_W: z.number().finite().nonnegative(), chargerAvailable: z.boolean(), batteryAvailable: z.boolean(), outputHealthy: z.boolean() }).strict()
const stateSchema = z.object({ time_s: z.number().finite().nonnegative(), energy_J: z.number().finite().nonnegative(), outputClosed: z.boolean(),
  cause: z.enum(['overload', 'insufficient_supply', 'output_failure']).nullable(), sourceEnergy_J: z.number().finite().nonnegative(),
  deliveredEnergy_J: z.number().finite().nonnegative(), lossEnergy_J: z.number().finite().nonnegative(),
}).strict().refine(s => !(s.outputClosed && s.cause !== null), 'Latched DC output cannot be closed')
const fresh = (basis: DcBasis, energy_J: number): DcState => ({ time_s: 0, energy_J, outputClosed: true, cause: null, sourceEnergy_J: 0, deliveredEnergy_J: 0, lossEnergy_J: 0 })

/** Exact constant-duty intervals. External changes at an energy boundary are
 * applied before deciding whether a real output-support interruption exists. */
export function dcSequence(basis: DcBasis, duration_s: number, events: Boundary[], initialEnergy_J = basis.usableEnergy_kWh * 3.6e6,
  restored?: { state: DcState; inputs: Inputs }) {
  basisSchema.parse(basis)
  const capacity = basis.usableEnergy_kWh * 3.6e6
  if (!Number.isFinite(duration_s) || duration_s <= 0 || !Number.isFinite(initialEnergy_J) || initialEnergy_J < 0 || initialEnergy_J > capacity) throw Error('Invalid DC interval/storage')
  if (events.some((e, i) => !Number.isFinite(e.at_s) || e.at_s < 0 || e.at_s > duration_s || (i > 0 && e.at_s <= events[i - 1]!.at_s))) throw Error('DC boundaries must be finite, distinct and increasing')
  const state = restored ? stateSchema.parse(restored.state) : fresh(basis, initialEnergy_J)
  let inputs: Inputs = restored ? inputsSchema.parse(restored.inputs) : { requested_W: basis.continuousDuty_W, chargerAvailable: false, batteryAvailable: true, outputHealthy: true }
  if (state.energy_J > capacity) throw Error('Retained DC energy exceeds selected capacity')
  if (state.time_s >= duration_s || events.some(e => e.at_s < state.time_s)) throw Error('Boundary precedes retained DC state')
  const referenceEnergy = state.energy_J + state.deliveredEnergy_J + state.lossEnergy_J - state.sourceEnergy_J
  const rows: Array<DcState & { supplied: boolean; requested_W: number; commands: Array<{ command: Command; accepted: boolean }> }> = []
  let index = 0
  function sufficient() {
    const power = (inputs.chargerAvailable ? basis.chargerLimit_W : 0) + (inputs.batteryAvailable && state.energy_J > 0 ? basis.outputLimit_W : 0)
    return inputs.outputHealthy && inputs.requested_W <= basis.outputLimit_W && inputs.requested_W <= power
  }
  function settle(event?: Boundary) {
    inputs = inputsSchema.parse({ ...inputs, ...event?.changes })
    if (state.outputClosed && !sufficient()) {
      state.outputClosed = false
      state.cause = !inputs.outputHealthy ? 'output_failure' : inputs.requested_W > basis.outputLimit_W ? 'overload' : 'insufficient_supply'
    }
    const commands: Array<{ command: Command; accepted: boolean }> = []
    for (const command of event?.commands ?? []) {
      let accepted = true
      if (command === 'open') state.outputClosed = false
      else if (command === 'reset') { accepted = sufficient(); if (accepted) state.cause = null }
      else { accepted = state.cause === null && sufficient(); if (accepted) state.outputClosed = true }
      commands.push({ command, accepted })
    }
    rows.push({ ...state, supplied: state.outputClosed && sufficient(), requested_W: inputs.requested_W, commands })
  }
  settle(events[index]?.at_s === state.time_s ? events[index++] : undefined)
  while (state.time_s < duration_s) {
    const load = state.outputClosed ? inputs.requested_W : 0
    const charger = inputs.chargerAvailable ? Math.min(basis.chargerLimit_W, load + (inputs.batteryAvailable && state.energy_J < capacity ? basis.chargerLimit_W : 0)) : 0
    const surplus = Math.max(0, charger - load), deficit = Math.max(0, load - charger)
    const rate = basis.chargeEfficiency * surplus - deficit / basis.dischargeEfficiency
    const storageTime = rate > 0 ? (capacity - state.energy_J) / rate : rate < 0 ? state.energy_J * basis.dischargeEfficiency / deficit : Infinity
    const target = Math.min(duration_s, events[index]?.at_s ?? Infinity)
    // Equivalent arithmetic for the same exact event may differ by a few ULPs.
    // This is a floating-point coincidence test, not an equipment debounce time.
    const tied = Math.abs(state.time_s + storageTime - target) <= 4 * Number.EPSILON * Math.max(1, Math.abs(target))
    const dt = tied ? target - state.time_s : Math.min(target - state.time_s, storageTime)
    if (!(dt > 0)) throw Error('Zero-duration DC boundary: unresolved storage event')
    const reachesStorage = tied || dt === storageTime
    state.energy_J = reachesStorage ? (rate > 0 ? capacity : 0) : state.energy_J + rate * dt
    state.time_s = dt === target - state.time_s ? target : state.time_s + dt
    const ac = charger / basis.converterEfficiency
    const losses = ac - charger + (1 - basis.chargeEfficiency) * surplus + deficit * (1 / basis.dischargeEfficiency - 1)
    state.sourceEnergy_J += ac * dt
    state.deliveredEnergy_J += load * dt
    state.lossEnergy_J += losses * dt
    const residual = state.energy_J + state.deliveredEnergy_J + state.lossEnergy_J - state.sourceEnergy_J - referenceEnergy
    if (!Number.isFinite(residual) || Math.abs(residual) > 1e-6 * Math.max(1, referenceEnergy / 1e6)) throw Error(`DC energy residual ${residual} J`)
    settle(events[index]?.at_s === state.time_s ? events[index++] : undefined)
  }
  return { rows, state, inputs, energyResidual_J: state.energy_J + state.deliveredEnergy_J + state.lossEnergy_J - state.sourceEnergy_J - referenceEnergy }
}

/** Physical majority/hold logic only; no neutron, actuator or recorder model. */
export function holdingContinuity(actPowered: boolean, rearmed: boolean, manualClosed: boolean, actualContacts: [boolean, boolean, boolean]) {
  return actPowered && rearmed && manualClosed && actualContacts.filter(Boolean).length >= 2
}

export function evaluateDcCases(basis: DcBasis) {
  const exhaustion = basis.usableEnergy_kWh * 3.6e6 * basis.dischargeEfficiency / basis.continuousDuty_W
  const depleted = dcSequence(basis, exhaustion + 3, [])
  const restored = dcSequence(basis, exhaustion + 20, [
    { at_s: exhaustion + 5, changes: { chargerAvailable: true } },
    { at_s: exhaustion + 10, commands: ['reset', 'close'] },
  ])
  const seamless = dcSequence(basis, exhaustion + 3, [{ at_s: exhaustion, changes: { chargerAvailable: true } }])
  const highDuty = dcSequence(basis, 10, [
    { at_s: 0, changes: { requested_W: 15000, chargerAvailable: true } },
    { at_s: 1, commands: ['close'] },
    { at_s: 2, commands: ['reset', 'close'] },
  ], 0)
  const split = dcSequence(basis, exhaustion / 2, [])
  const copied = dcSequence(basis, exhaustion + 3, [], undefined, JSON.parse(JSON.stringify({ state: split.state, inputs: split.inputs })))
  const copyDifferences = Object.fromEntries((['time_s', 'energy_J', 'sourceEnergy_J', 'deliveredEnergy_J', 'lossEnergy_J'] as const).map(key => [key, Math.abs(copied.state[key] - depleted.state[key])]))
  const checks = {
    nominalHours: exhaustion / 3600,
    depletionOpens: depleted.rows.some(r => r.time_s === exhaustion && !r.supplied && r.cause === 'insufficient_supply'),
    restorationNoAutoClose: restored.rows.find(r => r.time_s === exhaustion + 5)?.outputClosed === false,
    explicitRestore: restored.rows.find(r => r.time_s === exhaustion + 10)?.supplied === true,
    exactChargerArrivalNoOutage: seamless.rows.every(r => r.supplied),
    highDutyInitiallyRejected: highDuty.rows[0]?.cause === 'insufficient_supply',
    rechargeDoesNotReset: highDuty.rows.find(r => r.time_s === 1)?.commands[0]?.accepted === false,
    restoredPowerNotEndurance: highDuty.rows.find(r => r.time_s === 2)?.supplied === true,
    copyEquivalent: copied.state.outputClosed === depleted.state.outputClosed && copied.state.cause === depleted.state.cause && Object.values(copyDifferences).every(x => x <= 1e-6),
    contactLoss: !holdingContinuity(true, true, true, [true, false, false]),
    singleContactLossRetainsHold: holdingContinuity(true, true, true, [true, true, false]),
    noAutomaticRearm: !holdingContinuity(true, false, true, [true, true, true]),
    manualInterruptIndependent: !holdingContinuity(true, true, false, [true, true, true]),
    actuatorPowerCannotBeVotedIn: !holdingContinuity(false, true, true, [true, true, true]),
  }
  if (Object.entries(checks).some(([k, v]) => k !== 'nominalHours' && v !== true)) throw Error(JSON.stringify(checks))
  return { checks, copyDifferences, depleted, restored, seamless, highDuty, copied }
}

if (import.meta.main) {
  const [owner, ...extra] = process.argv.slice(2)
  if (!owner || extra.length) throw Error('Usage: reference-design-dc-sequence.ts dc-storage.md')
  const basis = parseDcBasis(await Bun.file(owner).text())
  const hash = (text: string) => createHash('sha256').update(text).digest('hex')
  console.log(JSON.stringify({ scope: 'Offline exact routed DC duty and physical hold continuity; no plant or protection runtime', input: basis,
    inputHash: hash(JSON.stringify(basis)), sourceHash: hash(await Bun.file(import.meta.path).text()), bun: Bun.version, liveModelInstalled: false,
    ...evaluateDcCases(basis) }, null, 2))
}
