/** TEST ONLY current-owner geometry fixture. No EOS preparation, nominal solve,
 * reached-state conversion or physical pressure-manifold qualification. */
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import { primaryWaterOwnerFiles, parsePrimaryWaterInputs } from './reference-design-source-water'
import { fuelHandlingChecks } from './reference-design-fuel-handling'
import { controlAbsorberGeometry } from './reference-design-control-absorber'
import { currentColdGeometry } from './reference-design-current-cold-parent'
import { parseHydraulicBasis } from './reference-design-hydraulics'
import { parseSurgeRoute, resolveSurgeRoute } from './reference-design-surge-route'
import { surgeConnectionGeometry } from './reference-design-pressurizer-surge-connection'
import { heaterBankBasis, heaterBankGeometry } from './reference-design-pressurizer-heater-banks'
import { coldReturnGeometry, foldedGeometry, type CurrentPrimaryGraphInput,
  type CurrentPrimarySupportGeometry } from './reference-design-primary-mechanics'

/** Current selected original, stationary fully-inserted cold occupancy only.
 * A declared uniform density is a STRUCTURAL algebra fixture, not a generated
 * native thermodynamic state. Geometry/moments below consume physical owners. */
export async function currentPrimaryGraphFixture(wiki = resolve(import.meta.dir,
  '../../../../Leitbild-wiki/world/packs/process-plant/reference-designs/ld-01')) {
  const extra = ['model/primary-hydraulic-basis.md', 'systems/primary-coolant/surge-route.md',
    'systems/primary-coolant/pressure-and-inventory.md']
  const names = [...primaryWaterOwnerFiles, ...extra]
  const docs = await Promise.all(names.map(p => Bun.file(join(wiki, p)).text()))
  const d = parsePrimaryWaterInputs(docs.slice(0, primaryWaterOwnerFiles.length)),
    hb = parseHydraulicBasis(docs[primaryWaterOwnerFiles.length]!),
    surge = resolveSurgeRoute(parseSurgeRoute(docs[primaryWaterOwnerFiles.length + 1]!)),
    f = d.fuel, h = d.handling, c = d.control, fg = fuelHandlingChecks(h, f).freshGeometry,
    cg = controlAbsorberGeometry(c, f, h), current = currentColdGeometry(c, d.attachment, f, h, d.gates, d.head, d.cold)
  const identity = names.map((name, i) => ({ name, sha256: createHash('sha256').update(docs[i]!).digest('hex') }))
  const source = (i: number) => identity[i]!.name + '#' + identity[i]!.sha256
  // Piecewise constant material displacement is integrated independently of
  // graph assembly; small collar/stub intervals are never replaced by area at
  // a convenient centre. This is the current owner's declared axial geometry.
  type Piece = { lo: number; hi: number; area: number }
  const integral = (pieces: Piece[]) => {
    const volume = pieces.reduce((a, p) => a + p.area * (p.hi - p.lo), 0),
      moment = pieces.reduce((a, p) => a + p.area * (p.hi - p.lo) * (p.lo + p.hi) / 2, 0)
    return { volume, moment, mean: moment / volume }
  }
  const remove = (base: Piece[], objects: Piece[]) => base.flatMap(q => {
    const cuts = [...new Set([q.lo, q.hi, ...objects.flatMap(o => [o.lo, o.hi]).filter(z => z > q.lo && z < q.hi)])].sort((a, b) => a - b)
    return cuts.slice(1).map((hi, i) => {
      const lo = cuts[i]!, mid = (lo + hi) / 2,
        area = q.area - objects.filter(o => mid > o.lo && mid < o.hi).reduce((a, o) => a + o.area, 0)
      if (!(area > 0)) throw Error('Current occupied test geometry lost positive area')
      return { lo, hi, area }
    })
  })
  const lower = integral(remove([{ lo: -4, hi: -2, area: d.initialization.volumes_m3[1] / 2 }], [
    { lo: h.seatedBottom_m, hi: -2, area: fg.guideOuterArea_m2 + fg.lower.fittingDisplacement_m3 / (-2 - h.seatedBottom_m) },
    { lo: h.sourceThimbleBottom_m, hi: h.seatedBottom_m, area: fg.sourceArea_m2 },
  ]))
  const upper = integral(remove([
    { lo: 2, hi: 2 + f.plenumLength_m, area: d.initialization.volumes_m3[4] / 2 - fg.guideOuterArea_m2 - fg.upper.sealedRodPlenumDisplacement_m3 / f.plenumLength_m },
    { lo: 2 + f.plenumLength_m, hi: current.faTop_m, area: d.initialization.volumes_m3[4] / 2 - fg.guideOuterArea_m2 - fg.upper.fittingDisplacement_m3 / (current.faTop_m - 2 - f.plenumLength_m) },
    { lo: current.faTop_m, hi: h.sourceThimbleTop_m, area: d.initialization.volumes_m3[4] / 2 - fg.sourceArea_m2 },
    { lo: h.sourceThimbleTop_m, hi: 4, area: d.initialization.volumes_m3[4] / 2 },
  ], current.intruders.filter(p => p.name !== '1248 actual bodies')))
  const collars = current.housing.collarBottoms.map(lo => ({ lo, hi: lo + current.housing.collarHeight, area: current.housing.collarArea }))
  const housing = integral([
    ...remove([{ lo: current.housing.mainLo, hi: current.housing.mainHi, area: current.housing.mainArea }], current.intruders),
    ...remove([{ lo: current.housing.mainHi, hi: current.housing.neckHi, area: current.housing.neckArea }], [...current.intruders, ...collars]),
  ])
  const H = heaterBankBasis, heater = heaterBankGeometry(H.vesselHeight_m),
    pzrV = H.vesselArea_m2 * H.vesselHeight_m - heater.totalSolid_m3,
    pzrMoment = H.vesselArea_m2 * H.vesselHeight_m * (H.bottom_m + H.vesselHeight_m / 2)
      - (['normal', 'backup'] as const).reduce((a, bank) => a + heater.banks[bank].solidVolume_m3 * (H.bottom_m + H[bank].length_m / 2), 0),
    sg = foldedGeometry(d.primary.sgDevelopedLength_m, hb.hotPort_m, hb.SGturn_m, hb.coldPort_m),
    ret = coldReturnGeometry(d.primary, d.barrel, d.initialization.volumes_m3[0])
  const support = (volume: number, z: number, src: string, area?: number, inlet?: number, outlet?: number): CurrentPrimarySupportGeometry => ({
    volume_m3: volume, meanElevation_m: z, sourceIdentity: src,
    ...(area === undefined ? {} : { area_m2: area }), ...(inlet === undefined ? {} : { inletElevation_m: inlet }),
    ...(outlet === undefined ? {} : { outletElevation_m: outlet }),
  })
  const coreArea = fg.active.externalFreeVolume_m3 / f.activeLength_m, hotArea = Math.PI * d.primary.hotInsideDiameter_m ** 2 / 4,
    geometry: CurrentPrimaryGraphInput['geometry'] = {
      DOWNCOMER: support(d.initialization.volumes_m3[0], (d.primary.downcomerBottom_m + d.primary.downcomerTop_m) / 2, source(6),
        d.initialization.volumes_m3[0] / (d.primary.downcomerTop_m - d.primary.downcomerBottom_m), d.primary.downcomerTop_m, d.primary.downcomerBottom_m),
      LOWER: support(lower.volume, lower.mean, source(1) + ';' + source(3)),
      'CORE.1': support(coreArea * (hb.coreMid_m - hb.coreInlet_m), (hb.coreMid_m + hb.coreInlet_m) / 2, source(0) + ';' + source(1), coreArea, hb.coreInlet_m, hb.coreMid_m),
      'CORE.2': support(coreArea * (hb.coreOutlet_m - hb.coreMid_m), (hb.coreOutlet_m + hb.coreMid_m) / 2, source(0) + ';' + source(1), coreArea, hb.coreMid_m, hb.coreOutlet_m),
      UPPER: support(upper.volume, upper.mean, source(1) + ';' + source(2) + ';' + source(3)),
      'HOT.A': support(d.initialization.volumes_m3[5], hb.hotPort_m, source(6), hotArea, hb.hotPort_m, hb.hotPort_m),
      'HOT.B': support(d.initialization.volumes_m3[6], hb.hotPort_m, source(6), hotArea, hb.hotPort_m, hb.hotPort_m),
      'SG.A.PRIMARY': support(d.initialization.volumes_m3[7], sg.meanElevation_m, source(6), d.initialization.volumes_m3[7] / d.primary.sgDevelopedLength_m, hb.hotPort_m, hb.coldPort_m),
      'SG.B.PRIMARY': support(d.initialization.volumes_m3[8], sg.meanElevation_m, source(6), d.initialization.volumes_m3[8] / d.primary.sgDevelopedLength_m, hb.hotPort_m, hb.coldPort_m),
      'COLD.A': support(d.primary.coldHeaderVolume_m3, hb.coldPort_m, source(6)),
      'COLD.B': support(d.primary.coldHeaderVolume_m3, hb.coldPort_m, source(6)),
      PZR: support(pzrV, pzrMoment / pzrV, 'reference-design-pressurizer-heater-banks.ts#heaterBankBasis'),
    }
  if (Math.abs(c.insertedBodyBottom_m - h.seatedBottom_m) > 1e-14
    || Math.abs(c.insertedBodyBottom_m + c.bodyLength_m - current.faTop_m) > 1e-14)
    throw Error('Constant-annulus test reduction no longer matches actual inserted geometry')
  const total = f.assemblies * f.guidesPerAssembly, body = cg.rodlets, thimble = 1,
    L = current.faTop_m - h.seatedBottom_m, boreA = Math.PI * (h.guideInnerDiameter_m / 2) ** 2,
    cohorts: CurrentPrimaryGraphInput['guideCohorts']['cohorts'] = (['EMPTY', 'BODY', 'THIMBLE'] as const).map(id => {
      const count = id === 'EMPTY' ? total - body - thimble : id === 'BODY' ? body : thimble,
        A = boreA - (id === 'BODY' ? Math.PI * (c.bodyDiameter_m / 2) ** 2 : id === 'THIMBLE' ? fg.sourceArea_m2 : 0)
      return { id, count, singleArea_m2: A, singleVolume_m3: A * L, bottom_m: h.seatedBottom_m,
        top_m: current.faTop_m, meanElevation_m: (h.seatedBottom_m + current.faTop_m) / 2 }
    }), housings = cg.sites.map((_, i) => ({ id: 'HOUSING.' + String(i + 1).padStart(3, '0'),
      volume_m3: housing.volume / c.clusters, meanElevation_m: housing.mean,
      openingElevation_m: c.headBottom_m, sourceIdentity: source(2) + ';' + source(3) }))
  // Build the explicit finite snapshot map, independently of graph production.
  const volumes: Record<string, number> = Object.fromEntries(Object.entries(geometry).filter(([id]) => id !== 'HOT.A').map(([id, q]) => [id, q.volume_m3]))
  // Current HOT.A owner: the selected one-metre midpoint intersection, NOT an
  // invented extra cavity. The matching length is stated in the current owner.
  const teeGeometry = surgeConnectionGeometry(parseSurgeRoute(docs[primaryWaterOwnerFiles.length + 1]!)),
    teeLength = teeGeometry.hot.nodeLength_m, teeV = hotArea * teeLength
  volumes['HOT.A.BEFORE'] = volumes['HOT.A.AFTER'] = (geometry['HOT.A'].volume_m3 - teeV) / 2
  volumes['HOT.A.J'] = teeV
  for (const loop of ['A', 'B']) {
    for (const j of [1, 2]) volumes[`P.${loop}${j}.PASSAGE`] = d.primary.pumpPassageVolume_m3
    volumes['RETURN.' + loop] = ret.volumePerTrain_m3
  }
  for (const g of cohorts) volumes['GUIDE.' + g.id] = g.count * g.singleVolume_m3
  for (const q of housings) volumes[q.id] = q.volume_m3
  volumes.SURGE = surge.liquidVolume_m3
  const rho = 997, masses = Object.fromEntries(Object.entries(volumes).map(([id, V]) => [id, {
    mass_kg: rho * V, massRate_kg_s: 0, density_kg_m3: rho, densityRate_kg_m3_s: 0,
  }]))
  const input: CurrentPrimaryGraphInput = { selection: d.primary, barrel: d.barrel, surge, geometry,
    snapshotIdentity: 'TEST ONLY uniform997kg/m3 cold structural snapshot; no EOS/native-original qualification',
    hotATee: { length_m: teeLength, meanElevation_m: hb.hotPort_m, sourceIdentity: source(primaryWaterOwnerFiles.length + 2) },
    guideCohorts: { mode: 'stationary-fully-inserted-homogeneous-cold', sourceIdentity: source(0) + ';' + source(1) + ';' + source(2),
      population: { total, body, thimble }, cohorts }, housingPopulation: c.clusters, housings, masses }
  const expectedGuide = fg.active.boreVolume_m3 + fg.lower.boreVolume_m3 + fg.upper.boreVolume_m3 - cg.poses[0]!.guideWaterDisplacement_m3,
    additionalUpperDisplacement = current.intruders.filter(q => q.name !== '1248 actual bodies').reduce((a, q) => a + q.area * Math.max(0, Math.min(4, q.hi) - Math.max(2, q.lo)), 0),
    expectedExterior = fg.active.externalFreeVolume_m3 + fg.lower.externalFreeVolume_m3 + fg.upper.externalFreeVolume_m3 - additionalUpperDisplacement,
    expectedMain = d.initialization.volumes_m3[0] + expectedExterior + geometry['HOT.A'].volume_m3 + geometry['HOT.B'].volume_m3
      + geometry['SG.A.PRIMARY'].volume_m3 + geometry['SG.B.PRIMARY'].volume_m3
      + 4 * d.primary.pumpPassageVolume_m3 + 2 * d.primary.coldHeaderVolume_m3,
    expectedTotal = expectedMain + expectedGuide + housing.volume + ret.addedMainVolume_m3 + surge.liquidVolume_m3 + pzrV
  return { input, identity, expectedGuideVolume_m3: expectedGuide, expectedExteriorVolume_m3: expectedExterior,
    expectedHousingVolume_m3: housing.volume, expectedTotalVolume_m3: expectedTotal,
    expectedFreeVolumeMoment_m4: lower.moment + upper.moment + housing.moment,
    expectedLowerVolume_m3: fg.lower.externalFreeVolume_m3,
    scope: 'Actual current physical records, fresh fully inserted stationary geometry; uniform-density structural fixture only. No EOS/native original preparation, heated cohort homogeneity or installed complete-primary admission.' }
}
