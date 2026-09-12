/** Offline LD-01 command arithmetic, not a controller runtime or pressure-response model. */
import { createHash } from 'node:crypto'

export type PressureSample = {
  pressure_Pa: number | null
  sampledAt_s: number
  quality: 'usable' | 'unavailable' | 'below-range' | 'above-range'
}

// Applied to the lagged, biased/electronically faulted pressure, not directly to plant truth.
// Absolute-pressure half bins round upward. Check range before rounding.
export function acquirePressure(value_Pa: number): number | null {
  if (!Number.isFinite(value_Pa) || value_Pa < 0 || value_Pa > 20e6) return null
  return Math.floor(value_Pa / 1000 + 0.5) * 1000
}

export function pressureDemand(sample: PressureSample, now_s: number, setpoint_Pa: number,
  heaterCapacity_W: number, heaterBand_Pa: number) {
  if (![now_s, setpoint_Pa, heaterCapacity_W, heaterBand_Pa].every(Number.isFinite)
    || heaterCapacity_W <= 0 || heaterBand_Pa <= 0) throw Error('Invalid control arithmetic inputs')
  const age = now_s - sample.sampledAt_s
  const usable = sample.quality === 'usable' && Number.isFinite(age) && age >= 0 && age <= 2
    && sample.pressure_Pa !== null && Number.isFinite(sample.pressure_Pa)
    && sample.pressure_Pa >= 0 && sample.pressure_Pa <= 20e6
  if (!usable) return { usable: false, heaterRequest_W: 0, controlledSprayRequest: 0 }
  const pressure = sample.pressure_Pa!
  const clamp = (value: number) => Math.max(0, Math.min(1, value))
  return { usable: true, heaterRequest_W: heaterCapacity_W * clamp((setpoint_Pa - pressure) / heaterBand_Pa),
    controlledSprayRequest: clamp((pressure - setpoint_Pa - 20000) / 80000) }
}

export function compareNormalDuty(normal: { physicalPressureTap_Pa: number; commissionedSetpoint_Pa: number;
  requiredHeater_W: number }, heaterCapacity_W: number, heaterBand_Pa: number) {
  if (acquirePressure(normal.physicalPressureTap_Pa) === null || !Number.isFinite(normal.requiredHeater_W)
    || normal.requiredHeater_W < 0) throw Error('Invalid normal required-duty inputs')
  const lowerBin = Math.floor(normal.physicalPressureTap_Pa / 1000) * 1000
  const commands = [lowerBin, lowerBin + 1000].map(pressure_Pa => ({ pressure_Pa,
    ...pressureDemand({ pressure_Pa, sampledAt_s: 0, quality: 'usable' }, 0,
      normal.commissionedSetpoint_Pa, heaterCapacity_W, heaterBand_Pa) }))
  const higher = commands[0]!.heaterRequest_W, lower = commands[1]!.heaterRequest_W
  return { acquiredNormalPressure_Pa: acquirePressure(normal.physicalPressureTap_Pa), commands,
    requiredMeanHeater_W: normal.requiredHeater_W,
    adjacentCommandsBracketDuty: lower <= normal.requiredHeater_W && normal.requiredHeater_W <= higher,
    higherCommandTimeFractionIfSuchACycleOccurs: higher === lower ? null : (normal.requiredHeater_W - lower) / (higher - lower),
    scope: 'Algebraic mean-duty feasibility only. No duty-cycle modulator, pressure trajectory, stability or achieved power is inferred.' }
}

if (import.meta.main) {
  const [receiptPath, thermalPagePath, ...extra] = Bun.argv.slice(2)
  if (!receiptPath || !thermalPagePath || extra.length) throw Error('Usage: pressurizer-control.ts <normal-thermal-receipt> <thermal-wiki-page>')
  const { parseNormalThermal } = await import('./reference-design-pressurizer-normal-thermal')
  const receiptText = await Bun.file(receiptPath).text(), page = await Bun.file(thermalPagePath).text()
  const receipt = JSON.parse(receiptText), config = parseNormalThermal(page)
  const normal = receipt.cases[0]
  if (!normal?.hydraulicAdmission || !normal.energyAccountingAdmission) throw Error('Normal required-duty receipt is not admitted')
  const hash = (text: string) => createHash('sha256').update(text).digest('hex')
  console.log(JSON.stringify({ sourceSha256: hash(await Bun.file(import.meta.path).text()),
    receiptSha256: hash(receiptText), thermalPageSha256: hash(page),
    ...compareNormalDuty(normal, config.heaterCapacity_W, config.heaterProportionalBand_Pa) }, null, 2))
}
