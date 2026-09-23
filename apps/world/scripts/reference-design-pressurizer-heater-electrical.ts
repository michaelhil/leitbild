/** Offline electrical/contact selection checks, not a plant controller or thermal model. */
import { createHash } from 'node:crypto'
import { heaterBankBasis } from './reference-design-pressurizer-heater-banks'

export const heaterElectricalBasis = { nominalVoltage_V: 10000, contactDelay_s: 0.05 } as const
export type Modulator = { kind: 'healthy' } | { kind: 'failed-on' } | { kind: 'failed-off' } | { kind: 'stuck'; duty: number }
export type ContactState = { closed: boolean; targetClosed: boolean; elapsed_s: number }

function nonnegative(value: number, name: string) {
  if (!Number.isFinite(value) || value < 0) throw Error(`Invalid ${name}`)
}

export function splitHeaterRequest(request_W: number) {
  nonnegative(request_W, 'heater request')
  const total = heaterBankBasis.normal.capacity_W + heaterBankBasis.backup.capacity_W
  if (request_W > total) throw Error('Heater request exceeds selected nominal range')
  return {
    normal_W: Math.min(request_W, heaterBankBasis.normal.capacity_W),
    backup_W: Math.max(request_W - heaterBankBasis.normal.capacity_W, 0),
  }
}

function achievedDuty(request_W: number, capacity_W: number, stage: Modulator) {
  if (stage.kind === 'healthy') return request_W / capacity_W
  if (stage.kind === 'failed-on') return 1
  if (stage.kind === 'failed-off') return 0
  if (!Number.isFinite(stage.duty) || stage.duty < 0 || stage.duty > 1) throw Error('Invalid stuck duty')
  return stage.duty
}

export function heaterElectricPower(input: {
  request_W: number; voltage_V: number; feederClosed: boolean; isolatorClosed: boolean;
  normal: Modulator; backup: Modulator;
}) {
  const request = splitHeaterRequest(input.request_W)
  nonnegative(input.voltage_V, 'AC voltage')
  const normalDuty = achievedDuty(request.normal_W, heaterBankBasis.normal.capacity_W, input.normal)
  const backupDuty = achievedDuty(request.backup_W, heaterBankBasis.backup.capacity_W, input.backup)
  const supply = input.feederClosed && input.isolatorClosed
    ? (input.voltage_V / heaterElectricalBasis.nominalVoltage_V) ** 2 : 0
  const normal_W = normalDuty * heaterBankBasis.normal.capacity_W * supply
  const backup_W = backupDuty * heaterBankBasis.backup.capacity_W * supply
  return { ...request, normalDuty, backupDuty, actualNormal_W: normal_W, actualBackup_W: backup_W, total_W: normal_W + backup_W }
}

/** Actual contacts, not measurements, cause labels, or powered-evaluator substitutes. */
export function heaterCoilSupported(actB: boolean, validNormalOutput: boolean, feederAvailable: boolean, permits: readonly [boolean, boolean, boolean]) {
  return actB && validNormalOutput && feederAvailable && permits.filter(Boolean).length >= 2
}

/** Constant-input interval. Return transition time so no integrator credits early isolation. */
export function advanceHeaterContact(state: ContactState, requestedClosed: boolean, closeSupported: boolean, dt_s: number, stuck = false) {
  nonnegative(dt_s, 'contact interval')
  nonnegative(state.elapsed_s, 'contact elapsed time')
  const delay = heaterElectricalBasis.contactDelay_s
  if (state.elapsed_s >= delay || (state.targetClosed === state.closed && state.elapsed_s !== 0)) throw Error('Inconsistent contact state')
  const targetClosed = requestedClosed && closeSupported
  if (stuck || targetClosed === state.closed) {
    return { state: { closed: state.closed, targetClosed, elapsed_s: 0 }, transitionAfter_s: null }
  }
  const elapsed = targetClosed === state.targetClosed ? state.elapsed_s : 0
  const remaining = delay - elapsed
  if (dt_s >= remaining) {
    return { state: { closed: targetClosed, targetClosed, elapsed_s: 0 }, transitionAfter_s: remaining }
  }
  return { state: { closed: state.closed, targetClosed, elapsed_s: elapsed + dt_s }, transitionAfter_s: null }
}

export function heaterElectricalComparison() {
  const healthy = { kind: 'healthy' } as const
  const base = { voltage_V: 10000, feederClosed: true, isolatorClosed: true, normal: healthy, backup: healthy }
  const closed: ContactState = { closed: true, targetClosed: true, elapsed_s: 0 }
  const opening = advanceHeaterContact(closed, false, false, 0.02)
  const copied = JSON.parse(JSON.stringify(opening.state)) as ContactState
  const opened = advanceHeaterContact(copied, false, false, 0.04)
  return {
    scope: 'Nominal split, resistive power and effective delayed binary contact only; no acquired protection, electrical network or thermal trajectory',
    basis: { ...heaterElectricalBasis, normal_W: heaterBankBasis.normal.capacity_W, backup_W: heaterBankBasis.backup.capacity_W },
    requests: [0, 120000, 3000000].map(request_W => heaterElectricPower({ ...base, request_W })),
    overvoltage: heaterElectricPower({ ...base, request_W: 3000000, voltage_V: 11000 }),
    failedOnOpening: heaterElectricPower({ ...base, request_W: 0, normal: { kind: 'failed-on' }, isolatorClosed: opening.state.closed }),
    failedOnOpened: heaterElectricPower({ ...base, request_W: 0, normal: { kind: 'failed-on' }, isolatorClosed: opened.state.closed }),
    opening, copiedContinuation: opened,
    reversedOpening: advanceHeaterContact(opening.state, true, true, 0.04),
    stuckClosed: advanceHeaterContact(closed, false, false, 1, true),
    permits: [heaterCoilSupported(true, true, true, [true, true, false]), heaterCoilSupported(true, true, true, [true, false, false])],
    unavailableFeeder: heaterCoilSupported(true, true, false, [true, true, true]),
  }
}

if (import.meta.main) {
  const [output, ...extra] = process.argv.slice(2)
  if (!output || extra.length) throw Error('Usage: pressurizer-heater-electrical <receipt.json>')
  const files = [import.meta.path, new URL('./reference-design-pressurizer-heater-banks.ts', import.meta.url).pathname]
  const sources = await Promise.all(files.map(path => Bun.file(path).text()))
  const hash = (value: string) => createHash('sha256').update(value).digest('hex')
  const result = heaterElectricalComparison()
  for (let i = 0; i < files.length; i++) if (sources[i] !== await Bun.file(files[i]!).text()) throw Error('Calculation source changed')
  const receipt = { sourceSha256: hash(sources[0]!), bankSourceSha256: hash(sources[1]!), resultSha256: hash(JSON.stringify(result)), result }
  await Bun.write(output, JSON.stringify(receipt, null, 2) + '\n')
  console.log(JSON.stringify({ output, sourceSha256: receipt.sourceSha256, resultSha256: receipt.resultSha256 }))
}
