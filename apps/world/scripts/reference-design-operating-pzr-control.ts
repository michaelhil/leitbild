/** The S3 normal PZR pressure control section (`pzrControl`): the AUTO law's
 * values from their owners' strict wiki blocks, unchanged. Rust owns the law
 * (`operating/src/control/pzr_pressure.rs`); this compiler only reads,
 * checks and composes. A missing block stops the compiler with the values it
 * would have carried and where the wiki states them in prose: no value is
 * defaulted, derived from a receipt or typed in here.
 *
 * - `ld01-pzr-pressure-control`: setpoint, spray offsets, freshness;
 * - `reference-pressurizer-normal-thermal`: heater capacity and
 *   proportional band (the gain the current owners retain);
 * - `reference-pzr-pressure-channel`: the PT1 span and its sample, which is
 *   the control frame;
 * - `ld01-pzr-heater-banks`: the banks' nominal capacities must sum to the
 *   heater capacity the law modulates.
 *
 * Usage: bun reference-design-operating-pzr-control.ts <wiki root> */
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { z } from 'zod'
import { ownedBlock } from './reference-design-operating-pzr'
import { equipmentOwners, parsePzrHeaterBanks } from './reference-design-operating-pzr-cases'

export const pzrControlOwners = {
  law: { page: 'systems/primary-coolant/pressure-and-inventory.md', heading: 'Ordinary pressure regulation', fence: 'ld01-pzr-pressure-control' },
  thermal: { page: 'systems/primary-coolant/pressurizer-thermal-state.md', heading: 'Normal circulation and required thermal duty', fence: 'reference-pressurizer-normal-thermal' },
  channel: { page: 'systems/instrumentation/operational-observations.md', heading: 'Operating-model observation handoff', fence: 'reference-pzr-pressure-channel' },
  banks: equipmentOwners.heaterBanks,
} as const

/** What the law block carries, and where the wiki states each value in prose
 * when the block is missing. */
export const lawValues = [
  { key: 'setpoint_Pa', prose: 'systems/primary-coolant/pressurizer-thermal-state.md#acquisition-and-initial-intent ("Retain the pressure setpoint 14,864,186.8055 Pa")' },
  { key: 'sprayStartAboveSetpoint_Pa', prose: 'systems/primary-coolant/pressure-and-inventory.md#ordinary-pressure-regulation ("spray begins 0.172369 MPa above target", R12-D3)' },
  { key: 'sprayFullAboveSetpoint_Pa', prose: 'systems/primary-coolant/pressure-and-inventory.md#ordinary-pressure-regulation ("reaches full at +0.517107 MPa", R12-D3)' },
  { key: 'freshness_s', prose: 'systems/primary-coolant/pressure-and-inventory.md#ordinary-pressure-regulation ("the shared 2 s simulation-time freshness rule")' },
] as const

const positive = z.number().finite().positive()
const lawSchema = z.object({ setpoint_Pa: positive, sprayStartAboveSetpoint_Pa: z.number().finite().nonnegative(),
  sprayFullAboveSetpoint_Pa: positive, freshness_s: positive }).strict()
const thermalSchema = z.object({ heaterCapacity_W: positive, heaterProportionalBand_Pa: positive }).passthrough()
const channelSchema = z.object({ lag_s: positive, min_pa: z.number().finite(), max_pa: positive, quantum_pa: positive,
  sample_s: positive, transport_s: z.number().finite().nonnegative() }).strict()

export type PzrControlPages = Record<keyof typeof pzrControlOwners, string>

function hasBlock(text: string, fence: string) {
  return new RegExp('^```' + fence + '\\s*$', 'm').test(text)
}

/** The `pzrControl` section from the owners' page texts. */
export function compileOperatingPzrControl(pages: PzrControlPages) {
  const o = pzrControlOwners
  if (!hasBlock(pages.law, o.law.fence))
    throw Error(`Missing strict block ${o.law.fence} under "${o.law.heading}" (${o.law.page}); the values it must carry are stated only in prose:\n`
      + lawValues.map(v => `  ${v.key}: ${v.prose}`).join('\n'))
  const law = lawSchema.parse(ownedBlock(pages.law, o.law.heading, o.law.fence))
  const thermal = thermalSchema.parse(ownedBlock(pages.thermal, o.thermal.heading, o.thermal.fence))
  const channel = channelSchema.parse(ownedBlock(pages.channel, o.channel.heading, o.channel.fence))
  const banks = parsePzrHeaterBanks(pages.banks)
  const installed = banks.reduce((sum, b) => sum + b.nominalCapacity_W, 0)
  if (installed !== thermal.heaterCapacity_W)
    throw Error(`The banks' nominal capacities sum to ${installed} W, not the law's ${thermal.heaterCapacity_W} W`)
  if (!(law.sprayStartAboveSetpoint_Pa < law.sprayFullAboveSetpoint_Pa))
    throw Error('The spray demand must start below its full point')
  if (!(channel.min_pa < law.setpoint_Pa && law.setpoint_Pa < channel.max_pa))
    throw Error('The setpoint must lie inside the PT1 channel span')
  return {
    setpoint_Pa: law.setpoint_Pa,
    heaterCapacity_W: thermal.heaterCapacity_W,
    heaterProportionalBand_Pa: thermal.heaterProportionalBand_Pa,
    sprayStartAboveSetpoint_Pa: law.sprayStartAboveSetpoint_Pa,
    sprayFullAboveSetpoint_Pa: law.sprayFullAboveSetpoint_Pa,
    freshness_s: law.freshness_s,
    sample_s: channel.sample_s,
    spanMinimum_Pa: channel.min_pa,
    spanMaximum_Pa: channel.max_pa,
  }
}

export async function prepareOperatingPzrControl(wiki: string) {
  const base = join(wiki, 'world/packs/process-plant/reference-designs/ld-01')
  const names = Object.entries(pzrControlOwners) as [keyof typeof pzrControlOwners, { page: string, fence: string }][]
  const pages = Object.fromEntries(await Promise.all(names.map(async ([k, o]) => [k, await Bun.file(join(base, o.page)).text()]))) as PzrControlPages
  const hash = (s: string) => createHash('sha256').update(s).digest('hex')
  return { ...compileOperatingPzrControl(pages), provenance: {
    consumed: names.map(([k, o]) => ({ page: o.page, fence: o.fence, sha256: hash(pages[k]) })),
    sourceSha256: hash(await Bun.file(import.meta.path).text()) } }
}

if (import.meta.main) {
  const [wiki] = Bun.argv.slice(2)
  if (!wiki || Bun.argv.length !== 3) throw Error('Usage: operating-pzr-control <wiki root>')
  console.log(JSON.stringify(await prepareOperatingPzrControl(wiki)))
}
