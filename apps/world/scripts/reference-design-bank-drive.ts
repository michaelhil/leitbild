/** Bounded, offline LD-01 ordinary-drive boundary/energy check. No runtime registration. */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { z } from 'zod'
import { advanceBank, parseBankBasis, type BankState } from './reference-design-bank-motion'

const ownSource = readFileSync(import.meta.path, 'utf8')
const helperPath = resolve(import.meta.dir, 'reference-design-bank-motion.ts')
const helperSource = readFileSync(helperPath, 'utf8')
const ownerPath = process.argv[2]
const receiptPath = process.argv[3]
if (!ownerPath || !receiptPath) throw Error('Usage: bun reference-design-bank-drive.ts <bank-owner.md> <receipt.json>')
const document = readFileSync(ownerPath, 'utf8')
const basis = parseBankBasis(document)
const blocks = [...document.matchAll(/^```reference-bank-drive\s*\n([\s\S]*?)^```\s*$/gm)]
if (blocks.length !== 1) throw Error('Expected one reference-bank-drive record')
const drive = z.object({
  source: z.literal('LD01.DC.ACT.B'), isolator: z.literal('LD01.CORE.BANK.DRIVE.ISO'),
  isolatorTravel_s: z.number().positive(), controllerDuty_W: z.number().positive(),
  motionDuty_W: z.number().positive(), fullStrokeEnergy_J: z.number().positive(),
  heatReceiver: z.literal('LD01.ROOM.B'),
}).strict().parse(JSON.parse(blocks[0]![1]!))
const dcPath = resolve(dirname(ownerPath), '../electrical/dc-storage.md')
const dcDocument = readFileSync(dcPath, 'utf8')
const dcBlocks = [...dcDocument.matchAll(/^```reference-dc-actuation\s*\n([\s\S]*?)^```\s*$/gm)]
if (dcBlocks.length !== 1) throw Error('Expected one DC input record')
const dc = z.object({ continuousDuty_W: z.number().positive(), outputLimit_W: z.number().positive(),
  chargerLimit_W: z.number().positive(), dischargeEfficiency: z.number().positive().max(1),
  usableEnergy_kWh: z.number().positive(), chargeEfficiency: z.number().positive().max(1),
  converterEfficiency: z.number().positive().max(1),
}).strict().parse(JSON.parse(dcBlocks[0]![1]!))

let checks = 0
function check(condition: boolean, message: string) {
  checks++
  if (!condition) throw Error(message)
}
function near(actual: number, expected: number, tolerance: number, message: string) {
  check(Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance,
    `${message}: ${actual} versus ${expected}`)
}
type Environment = { actB: boolean; isolatorClosed: boolean; driveHealthy: boolean;
  holdingVoltage: boolean; insertionDemand: boolean; releaseAvailable: boolean; insertionStop: number }
const healthy: Environment = { actB: true, isolatorClosed: true, driveHealthy: true,
  holdingVoltage: true, insertionDemand: false, releaseAvailable: true, insertionStop: 0 }
const seed: BankState = { position: basis.referencePosition, mode: 'HOLD',
  requestedPosition: basis.referencePosition, released: false }
type Command = { mode: 'HOLD' } | { mode: 'MANUAL'; target: number }

type Isolator = { closed: boolean; targetClosed: boolean; remaining_s: number }
function requestIsolation(before: Isolator, targetClosed: boolean): Isolator {
  if (targetClosed === before.closed) return { ...before, targetClosed, remaining_s: 0 }
  return targetClosed === before.targetClosed ? { ...before }
    : { ...before, targetClosed, remaining_s: drive.isolatorTravel_s }
}
function advanceIsolation(before: Isolator, dt: number, obstructed = false): Isolator {
  if (!Number.isFinite(dt) || dt < 0) throw Error('Invalid isolator interval')
  if (dt === 0 || obstructed || before.closed === before.targetClosed) return { ...before }
  return dt >= before.remaining_s ? { ...before, closed: before.targetClosed, remaining_s: 0 }
    : { ...before, remaining_s: before.remaining_s - dt }
}

// Explicit new installed-output boundary; the historical mechanics helper remains unchanged.
function interval(before: BankState, env: Environment, dt: number, command?: Command,
  energyPerStroke = drive.fullStrokeEnergy_J) {
  if (!Number.isFinite(dt) || dt < 0) throw Error('Invalid interval')
  if (dt === 0) return { state: { ...before }, motive_J: 0, electronics_J: 0, heat_J: 0,
    mechanicalChange_J: 0, commandAccepted: command ? false : null }
  const motiveAvailable = env.actB && env.isolatorClosed && env.driveHealthy
  const inhibited = env.insertionDemand || !env.holdingVoltage || before.released
  let state = { ...before }
  if (inhibited) state = { ...state, mode: 'HOLD', requestedPosition: 0 }
  else if (!motiveAvailable) state = { ...state, mode: 'HOLD', requestedPosition: state.position }
  let commandAccepted: boolean | null = null
  if (command?.mode === 'HOLD') {
    state = { ...state, mode: 'HOLD', requestedPosition: inhibited ? 0 : state.position }
    commandAccepted = true
  } else if (command?.mode === 'MANUAL') {
    const validTarget = Number.isFinite(command.target) && command.target >= 0 && command.target <= 1
    commandAccepted = validTarget && motiveAvailable && !inhibited
    if (commandAccepted) state = { ...state, mode: 'MANUAL', requestedPosition: command.target }
  }
  const result = advanceBank(basis, state, { holdingVoltage: env.holdingVoltage,
    ordinaryDrive: motiveAvailable && !env.insertionDemand, releaseAvailable: env.releaseAvailable,
    insertionStop: env.insertionStop }, dt)
  const motive_J = result.segments.reduce((total, segment) => total + (
    motiveAvailable && state.mode === 'MANUAL' && !inhibited && segment.from !== state.requestedPosition
      ? drive.motionDuty_W * segment.duration_s : 0), 0)
  const mechanicalChange_J = energyPerStroke * (result.state.position - before.position)
  const heat_J = motive_J - mechanicalChange_J
  check(heat_J >= -1e-8, 'Negative dissipated energy')
  const electronics_J = env.actB ? drive.controllerDuty_W * dt : 0
  return { state: result.state, motive_J, electronics_J, heat_J, mechanicalChange_J, commandAccepted }
}

check(drive.controllerDuty_W < dc.continuousDuty_W, 'Controller must replace an aggregate portion')
check(dc.continuousDuty_W + drive.motionDuty_W <= dc.outputLimit_W, 'Isolated motion exceeds ACT rating')
check(dc.continuousDuty_W + drive.motionDuty_W <= dc.chargerLimit_W, 'Reference charger cannot serve motion')
check(2 * drive.fullStrokeEnergy_J * basis.ordinaryRate_s < drive.motionDuty_W,
  'Twice-energy lifting candidate exceeds delivered duty')
near((dc.continuousDuty_W - drive.controllerDuty_W) + drive.controllerDuty_W,
  dc.continuousDuty_W, 1e-9, 'No duplicate continuous controller duty')

const rows: Record<string, ReturnType<typeof interval>> = {}
const inputs: Record<string, { state: BankState; env: Environment; duration_s: number; command: Command | null }> = {}
const run = (name: string, state: BankState, env: Environment, dt: number, command?: Command) => {
  inputs[name] = { state: { ...state }, env: { ...env }, duration_s: dt, command: command ?? null }
  return rows[name] = interval(state, env, dt, command)
}
const target = run('target_then_hold', seed, healthy, 10, { mode: 'MANUAL', target: .71 })
near(target.state.position, .71, 1e-12, 'Target reached')
near(target.motive_J, 5000, 1e-6, 'Only actual five-second demand energized')
near(target.heat_J, 4500, 1e-6, 'Lifting loss')
const held = run('at_target', target.state, healthy, 10)
near(held.motive_J, 0, 1e-9, 'No motive demand at target')
const blocked = run('energized_obstruction', { ...seed, position: .4 },
  { ...healthy, insertionStop: .3 }, 100, { mode: 'MANUAL', target: 0 })
near(blocked.state.position, .3, 1e-12, 'Insertion obstruction respected')
near(blocked.motive_J, 100000, 1e-6, 'Blocked remainder retains energized duty')
near(blocked.heat_J, 105000, 1e-6, 'Lowering plus stalled heat')
const pending = run('ordinary_motion', seed, healthy, 1, { mode: 'MANUAL', target: .8 })
const iso: Isolator = { closed: true, targetClosed: true, remaining_s: 0 }
const opening = requestIsolation(iso, false)
const halfOpen = advanceIsolation(opening, drive.isolatorTravel_s / 2)
check(halfOpen.closed && halfOpen.remaining_s > 0, 'Unfinished opening retains electrical delivery')
check(JSON.stringify(requestIsolation(halfOpen, false)) === JSON.stringify(halfOpen),
  'Repeated request cannot restart travel')
const reversed = requestIsolation(halfOpen, true)
check(reversed.closed && reversed.remaining_s === 0, 'Reversal cancels unfinished opening')
const blockedIso = advanceIsolation(halfOpen, 100, true)
check(JSON.stringify(blockedIso) === JSON.stringify(halfOpen), 'Obstruction preserves actual contact/timer')
const closedFault = run('isolator_failed_closed', pending.state,
  { ...healthy, isolatorClosed: blockedIso.closed }, 1)
near(closedFault.state.position, pending.state.position + basis.ordinaryRate_s, 1e-12,
  'Failed isolation leaves actual motive support')
const fullyOpen = advanceIsolation(JSON.parse(JSON.stringify(halfOpen)), drive.isolatorTravel_s / 2)
check(!fullyOpen.closed && fullyOpen.remaining_s === 0, 'Copied remaining opening completes')
const halfClose = advanceIsolation(requestIsolation(fullyOpen, true), drive.isolatorTravel_s / 2)
check(!halfClose.closed, 'Unfinished closure cannot supply motive power')
const loss = run('local_motive_loss', pending.state, { ...healthy, isolatorClosed: false }, .01)
check(loss.state.mode === 'HOLD' && !loss.state.released, 'Motive loss holds without releasing')
near(loss.state.position, pending.state.position, 1e-12, 'Motive loss stops ordinary movement')
near(loss.motive_J, 0, 1e-9, 'No unavailable motive energy')
near(loss.electronics_J, .2, 1e-9, 'Local isolation leaves controller powered')
const restored = run('restoration_without_transfer', loss.state, healthy, 2)
near(restored.state.position, loss.state.position, 1e-12, 'Restored supply cannot replay target')
const fresh = run('new_transfer', restored.state, healthy, 1, { mode: 'MANUAL', target: .8 })
check(fresh.commandAccepted === true, 'Fresh supported transfer accepted')
near(fresh.state.position, restored.state.position + basis.ordinaryRate_s, 1e-12, 'Fresh transfer moves')
const actLoss = run('ACT_B_loss', pending.state, { ...healthy, actB: false }, 1)
near(actLoss.electronics_J + actLoss.motive_J, 0, 1e-9, 'Dead ACT.B supplies no energy')
check(!actLoss.state.released, 'ACT.B loss alone does not remove ACT.A hold')
const trip = run('hold_loss_with_dead_drive', seed,
  { ...healthy, holdingVoltage: false, actB: false, isolatorClosed: false }, 2)
near(trip.state.position, 0, 1e-12, 'Gravity release works without motive supply')
near(trip.heat_J, drive.fullStrokeEnergy_J * seed.position, 1e-6, 'Only retained energy dissipated')
near(trip.motive_J, 0, 1e-9, 'No electrical release work')
const partialTrip = run('obstructed_release', seed,
  { ...healthy, holdingVoltage: false, insertionStop: .3 }, 2)
near(partialTrip.state.position, .3, 1e-12, 'Release obstruction retains position')
near(partialTrip.heat_J, 20000, 1e-6, 'Only achieved released travel dissipates')
const failedRelease = run('failed_release', seed,
  { ...healthy, holdingVoltage: false, releaseAvailable: false }, 2)
near(failedRelease.heat_J, 0, 1e-9, 'Failed release retains mechanical energy')
for (const [name, env] of Object.entries({ active_demand: { ...healthy, insertionDemand: true },
  lost_hold: { ...healthy, holdingVoltage: false }, unavailable_drive: { ...healthy, actB: false } })) {
  const rejected = run(name, pending.state, env, .1, { mode: 'MANUAL', target: 1 })
  check(rejected.commandAccepted === false && rejected.state.mode === 'HOLD', `${name} rejects transfer`)
}
const half = run('half_release', seed, { ...healthy, holdingVoltage: false }, .5)
const restoredDuringDrop = run('restore_during_release', half.state, healthy, 1,
  { mode: 'MANUAL', target: 1 })
check(restoredDuringDrop.commandAccepted === false, 'Restored holding cannot recapture/replay')
near(restoredDuringDrop.state.position, 0, 1e-12, 'Release continues after restoration')
const copied = interval(JSON.parse(JSON.stringify(half.state)), healthy, 1, { mode: 'MANUAL', target: 1 })
check(JSON.stringify(copied) === JSON.stringify(restoredDuringDrop), 'Copy retains release and ledger')

const sensitivity = []
for (const factor of [.5, 1, 2]) {
  const start: BankState = { position: 0, mode: 'HOLD', requestedPosition: 0, released: false }
  const up = interval(start, healthy, 1 / basis.ordinaryRate_s,
    { mode: 'MANUAL', target: 1 }, drive.fullStrokeEnergy_J * factor)
  const drop = interval(up.state, { ...healthy, holdingVoltage: false }, 1 / basis.insertionRate_s,
    undefined, drive.fullStrokeEnergy_J * factor)
  near(up.state.position, 1, 1e-12, 'Full lift reaches upper stop')
  near(drop.state.position, 0, 1e-12, 'Full drop reaches lower stop')
  near(up.heat_J + drop.heat_J, up.motive_J, 1e-6, 'Closed lift/drop energy cycle')
  sensitivity.push({ factor, liftHeat_J: up.heat_J, releaseHeat_J: drop.heat_J, input_J: up.motive_J })
}
let split = { ...seed }
let splitEnergy = 0
for (let i = 0; i < 40; i++) {
  const step = interval(split, { ...healthy, holdingVoltage: false }, .05)
  split = step.state; splitEnergy += step.heat_J
}
near(split.position, trip.state.position, 1e-12, 'Subdivision endpoint')
near(splitEnergy, trip.heat_J, 1e-6, 'Subdivision retained mechanical energy')
check(JSON.stringify(interval(pending.state, { ...healthy, actB: false }, 0).state)
  === JSON.stringify(pending.state), 'Pause is not a new support event')

const sha = (text: string) => createHash('sha256').update(text).digest('hex')
check(readFileSync(ownerPath, 'utf8') === document && readFileSync(dcPath, 'utf8') === dcDocument
  && readFileSync(import.meta.path, 'utf8') === ownSource && readFileSync(helperPath, 'utf8') === helperSource,
  'Owner or calculation source changed during check')
const receipt = { scope: 'Offline installed-output boundary and energy ledger with prescribed supports; not coupled DC or plant behavior',
  version: Bun.version, owner_sha256: sha(document), dc_owner_sha256: sha(dcDocument),
  calculation_sha256: sha(ownSource), mechanics_sha256: sha(helperSource), basis, drive, dc, checks, inputs, rows,
  sensitivity, nominalACTLoadWhileMoving_W: dc.continuousDuty_W + drive.motionDuty_W,
  incrementalBatteryEnergyForFullStroke_J: drive.motionDuty_W / basis.ordinaryRate_s / dc.dischargeEfficiency }
await Bun.write(receiptPath, JSON.stringify(receipt, null, 2) + '\n')
console.log(JSON.stringify({ checks, cases: Object.keys(rows).length, sensitivity, receiptPath }))
