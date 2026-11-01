/** One joined S2 packet: the compact spine packet with each S2 owner's strict
 * section under its own top-level key. This compiler only composes; every
 * value comes from its owner's strict wiki blocks through that owner's
 * section compiler, and Rust owns every law. The spine sections are
 * unchanged but for the PZR cell's ports (G6), so the network and the
 * joined blocks read the same bytes.
 *
 * Sections: `secondary` (the SG secondary owner, prepareOperatingSecondary),
 * `rods` (the rod owner, compileOperatingRods), `post_trip_domain` (D3 (a),
 * compileOperatingPostTripDomain), `hot_standby_kinetics` (P1, owner R11,
 * compileOperatingHotStandby), `pzrMetal` (the PZR metal and relief
 * owner, G6, joinedPzrSections), whose cell gains the spray and relief
 * ports, and `matrixRebuild` (MR-1, owner request 7 R7-P: the joined solve's
 * forced iteration-matrix rebuild, operating-equations §6's
 * `ld01-joined-matrix-rebuild`, read by the S3 frame driver).
 *
 * The spine is compiled in two passes around the stock-IDA steady solids
 * settle (G18); `settle` produces that steady state. The settle's input
 * carries G6's cell and the PZR owner's section, so the PZR steel settles
 * with the solids (S3-D36) and the packet carries it as `pzrSteel`.
 *
 * Usage: bun reference-design-operating-joined.ts <wiki root> <pinned IF97 directory> <prepare_steady_solids executable> */
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { z } from 'zod'
import { ownedBlock } from './reference-design-operating-pzr'
import { caseSetSections, equipmentOwners, parsePzrHeaterBanks, parsePzrRelief, parsePzrSpray } from './reference-design-operating-pzr-cases'
import { compileOperatingRods } from './reference-design-operating-rods'
import { prepareOperatingSecondary } from './reference-design-operating-sg'
import { compileOperatingHotStandby, compileOperatingPostTripDomain } from './reference-design-operating-source'
import { if97Preparation, parsePreparationWater, type PreparationWater, type SteadySolids } from './reference-design-operating-fluid'
import { nativeSteadySolids, prepareOperatingSpine, type SteadySolidsSettle } from './reference-design-operating-spine'

/** The owners' pages G6 reads, under the LD-01 design root. */
export const pzrMetalPages = {
  equipment: equipmentOwners.heaterBanks.page,
  inventory: equipmentOwners.relief.page,
  thermal: 'systems/primary-coolant/pressurizer-thermal-state.md',
} as const
/** G6's PZR sections (lead plan S2-06): the spine's cell with the spray and
 * relief ports (`caseSetSections`, spray and relief taking no face), and the
 * PZR metal and relief owner's section: the heater banks, heater contact,
 * 304 caloric and shell blocks unchanged (Rust admits them strictly), and the
 * relief receiver at the relief device's calibration backpressure, the
 * containment, held constant as P2's cases hold it. */
export function joinedPzrSections<Cell extends Parameters<typeof caseSetSections>[0]>(
  cell: Cell, pages: Record<keyof typeof pzrMetalPages, string>) {
  const relief = parsePzrRelief(pages.inventory), spray = parsePzrSpray(pages.inventory), banks = parsePzrHeaterBanks(pages.equipment)
  const added = caseSetSections(cell, banks, relief, { relief: { elevation_m: relief.elevation_m }, spray: { elevation_m: spray.elevation_m, bore_m: spray.exitBore_m } })
    .cell.ports.slice(cell.ports.length)
  const ports = [...cell.ports as Cell['ports'][number][], ...added]
  return { cell: { ...cell, ports } as Omit<Cell, 'ports'> & { ports: typeof ports }, pzrMetal: {
    heaterBanks: { banks },
    heaterContact: ownedBlock(pages.equipment, 'Abnormal wall contact and finite heat receivers', 'ld01-pzr-heater-contact'),
    caloric304: ownedBlock(pages.equipment, 'Fixed metal and complementary contact', 'reference-304-caloric'),
    shell: ownedBlock(pages.thermal, 'Shell and head metal', 'ld01-pzr-shell'),
    reliefBackPressure_Pa: relief.calibration.backPressure_Pa } }
}

/** MR-1's owner page and block (owner request 7 R7-P, 17 Oct). */
export const matrixRebuildOwner = {
  page: 'model/operating-equations.md',
  heading: 'Forced iteration-matrix rebuild (owner, R7-P)',
  fence: 'ld01-joined-matrix-rebuild',
} as const
const matrixRebuildSchema = z.object({
  decision: z.string().min(1),
  appliesFrom: z.literal('S3'),
  rebuildEverySteps: z.number().int().positive(),
  mechanism: z.string().min(1),
  adoption: z.string().min(1),
  guard: z.string().min(1),
}).strict()
/** The packet's `matrixRebuild`: the owner's block verbatim (strict), with
 * the page it was read from. Rust's `joined::packet::MatrixRebuild` admits it
 * strictly; the S3 frame driver sets stock IDAS check points every
 * `rebuildEverySteps` steps from it. */
export function matrixRebuildSection(page: string) {
  const block = matrixRebuildSchema.parse(ownedBlock(page, matrixRebuildOwner.heading, matrixRebuildOwner.fence))
  return { ...block, provenance: { consumed: [{ name: matrixRebuildOwner.page, sha256: createHash('sha256').update(page).digest('hex') }] } }
}

/** The packet's `pzrSteel` (S3-D36): each PZR steel coordinate's steady
 * energy and temperature from the settle, in the block's layout order and by
 * its label (Rust's `joined::pzr::Steel` admits them strictly), with the
 * settle's PZR receipt. */
export function pzrSteelSection(pzr: NonNullable<SteadySolids['pzr']>) {
  const { stores, frozen, saturation_k, heater_request_w, joule_w, exterior_w, to_fluid_w, stored_energy_change_j, steady, ida } = pzr
  return { stores: stores.map(s => ({ id: s.id, energy_J: s.energy_j, temperature_K: s.temperature_k })),
    provenance: { settle: 'the packet provenance\'s steadySolids (binary, input and output hashes)',
      receipt: { frozen, saturation_K: saturation_k, heaterRequest_W: heater_request_w, joule_W: joule_w, exterior_W: exterior_w,
        toFluid_W: to_fluid_w, storedEnergyChange_J: stored_energy_change_j, steady, ida } } }
}

export async function prepareOperatingJoined(wiki: string, if97: string, settle: SteadySolidsSettle, water: PreparationWater = if97Preparation) {
  const base = join(wiki, 'world/packs/process-plant/reference-designs/ld-01'), names = Object.entries(pzrMetalPages)
  const pages = Object.fromEntries(await Promise.all(names.map(async ([k, p]) => [k, await Bun.file(join(base, p)).text()]))) as Record<keyof typeof pzrMetalPages, string>
  let steel: ReturnType<typeof pzrSteelSection> | undefined
  const spine = await prepareOperatingSpine(wiki, if97, async seed => {
    const g6 = joinedPzrSections(seed.packet.pzr.cell, pages),
      settled = await settle(seed, { pzr: { ...seed.packet.pzr, cell: g6.cell }, pzrMetal: { ...g6.pzrMetal, provenance: {} } })
    if (!settled.steady.pzr) throw Error('The steady solids settle returned no PZR steel for the PZR owner\'s section')
    steel = pzrSteelSection(settled.steady.pzr)
    return settled
  }, water)
  if (!steel) throw Error('The spine compile did not run the steady solids settle')
  const secondary = await prepareOperatingSecondary(wiki)
  const rods = await compileOperatingRods(wiki)
  if (rods.clusters.length !== spine.feedback_reference.achievedRodTravel_m.length)
    throw Error('The rods section must list the source feedback\'s clusters')
  const ids = spine.thermal.secondaries.map(s => s.id)
  if (JSON.stringify(secondary.steamGenerators.map(g => g.id)) !== JSON.stringify(ids))
    throw Error('The secondary section must list the spine thermal secondaries in their order')
  for (const [i, g] of secondary.steamGenerators.entries())
    if (g.volume_m3 !== spine.thermal.secondaries[i]!.volume_m3) throw Error(`SG.${g.id} volume disagrees with its prepared stock`)
  const hash = (s: string) => createHash('sha256').update(s).digest('hex')
  const consumed = names.map(([k, name]) => ({ name, sha256: hash(pages[k as keyof typeof pzrMetalPages]) }))
  const g6 = joinedPzrSections(spine.pzr.cell, pages)
  const matrixRebuild = matrixRebuildSection(await Bun.file(join(base, matrixRebuildOwner.page)).text())
  return { ...spine, identity: 'LD01-JOINED-SPINE-1', secondary, rods, post_trip_domain: await compileOperatingPostTripDomain(wiki),
    hot_standby_kinetics: await compileOperatingHotStandby(wiki), matrixRebuild,
    pzr: { ...spine.pzr, cell: g6.cell, provenance: { ...spine.pzr.provenance, consumed: [...spine.pzr.provenance.consumed, ...consumed] } },
    pzrMetal: { ...g6.pzrMetal, provenance: { consumed } }, pzrSteel: steel,
    provenance: { ...spine.provenance, joinedSourceSha256: hash(await Bun.file(import.meta.path).text()) },
    scope: 'Joined S2 inputs: the compact spine packet, its PZR cell with the spray and relief ports (G6), with the SG secondary, rod, D3 (a) post-trip domain and PZR metal and relief owners\' strict sections, the PZR steel at its steady state (S3-D36), and MR-1\'s forced matrix-rebuild interval (R7-P). No trajectory admission.' }
}

if (import.meta.main) {
  const [wiki, if97, settle, waterArg] = Bun.argv.slice(2)
  // The water method is named on every compile (lead 1 Nov: SBTL is the method of record since the combined re-pin; its
  // archive has no default, so the CLI takes no silent method): --water=sbtl:<archive dir>, or --water=if97 for the reference.
  if (!wiki || !if97 || !settle || !waterArg || Bun.argv.length !== 6) throw Error('Usage: operating-joined <wiki root> <pinned IF97 directory> <prepare_steady_solids executable> --water=sbtl:<archive dir>|--water=if97')
  const water = parsePreparationWater(waterArg)
  console.log(JSON.stringify(await prepareOperatingJoined(wiki, if97, nativeSteadySolids(settle, wiki, water), water)))
}
