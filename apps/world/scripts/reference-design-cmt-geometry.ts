/** Offline LD-01 tank geometry and conservative partition check; no flow or mixing solver. */
import { createHash } from 'node:crypto'
import { z } from 'zod'

const positive = z.number().finite().positive()
const schema = z.object({ freeWater_m3: positive, bottomDatum_m: z.number().finite(), top_m: positive,
  bodyBottom_m: positive, bodyTop_m: positive, bodyOuterDiameter_m: positive, bodyEffectiveInnerDiameter_m: positive,
  feedOuterDiameter_m: positive, feedInnerDiameter_m: positive, mouthDiameter_m: positive,
  balanceWater_m3: positive, distributorGroupWater_m3: positive, hardwareSolid_m3: positive,
  holeDiameter_m: positive, holesPerRing: z.literal(10), ringElevations_m: z.tuple([positive, positive, positive]),
  upperTap_m: positive, topProbe_m: positive, bottomProbe_m: positive }).strict()
export type GeometryBasis = z.infer<typeof schema>
export function parseGeometryBasis(document: string): GeometryBasis {
  const blocks = [...document.matchAll(/^```reference-cmt-geometry\s*\n([\s\S]*?)^```\s*$/gm)]
  if (blocks.length !== 1) throw new Error('Expected one reference-cmt-geometry block')
  const b = schema.parse(JSON.parse(blocks[0]![1]!))
  if (!(b.bottomDatum_m < b.bottomProbe_m && b.bottomProbe_m < b.topProbe_m && b.topProbe_m < b.bodyBottom_m &&
    b.bodyBottom_m < b.bodyTop_m && b.bodyTop_m < b.top_m && b.upperTap_m < b.top_m &&
    b.upperTap_m > b.bodyBottom_m && b.bodyEffectiveInnerDiameter_m < b.bodyOuterDiameter_m &&
    b.feedInnerDiameter_m < b.feedOuterDiameter_m && b.feedOuterDiameter_m < b.bodyOuterDiameter_m &&
    b.distributorGroupWater_m3 < b.balanceWater_m3 && b.ringElevations_m.every((v, i) =>
      (i === 0 || b.ringElevations_m[i - 1]! - v > b.holeDiameter_m) &&
      v - b.holeDiameter_m / 2 > b.bodyBottom_m && v + b.holeDiameter_m / 2 < b.bodyTop_m)))
    throw new Error('Inconsistent selected CMT geometry or inventory')
  if (b.bodyEffectiveInnerDiameter_m * Math.sin(pi / b.holesPerRing) <= b.holeDiameter_m)
    throw new Error('Circular apertures overlap circumferentially at the selected inner-body radius')
  return b
}

const pi = Math.PI
const unique = (x: number[]) => [...new Set(x)].sort((a, b) => a - b)
function bisect(f: (x: number) => number, lo: number, hi: number) {
  if (f(lo) * f(hi) >= 0) throw new Error('Geometry root not bracketed')
  for (let i = 0; i < 80; i++) { const mid = (lo + hi) / 2; if (f(mid) < 0) lo = mid; else hi = mid }
  return (lo + hi) / 2
}

export function tankGeometry(b: GeometryBasis) {
  const H = b.top_m - b.bottomDatum_m, rb = b.bodyOuterDiameter_m / 2, rf = b.feedOuterDiameter_m / 2
  const rm = b.mouthDiameter_m / 2, feedHeight = b.top_m - b.bodyTop_m
  const capHeight = (R: number, r: number) => (R / 2) * (1 - Math.sqrt(1 - (r / R) ** 2))
  const cap = (R: number, x: number) => pi * R * R * (x * x / (R / 2) - x ** 3 / (3 * (R / 2) ** 2))
  const intrusion = (R: number, r: number) => {
    const x = Math.min(feedHeight, capHeight(R, r))
    return cap(R, x) + pi * r * r * (feedHeight - x)
  }
  const bodyVolume = pi * rb * rb * (b.bodyTop_m - b.bodyBottom_m)
  const free = (R: number) => pi * R * R * (H - R / 3) - cap(R, capHeight(R, rm)) - bodyVolume - intrusion(R, rf)
  const R = bisect(r => free(r) - b.freeWater_m3, Math.max(rb, rf, rm) * 1.01, H * .999)
  const a = R / 2, mouth = b.bottomDatum_m + capHeight(R, rm)
  const roof = (r: number) => b.top_m - capHeight(R, r)
  const shellR2 = (z: number) => {
    if (z < b.bottomDatum_m || z > b.top_m) return 0
    const x = Math.min(z - b.bottomDatum_m, b.top_m - z)
    return x >= a ? R * R : R * R * (2 * x / a - (x / a) ** 2)
  }
  // Closed surfaces at each body cap: an interior numerical z-face must not cross the cap.
  const obstructionR2 = (z: number) => z >= b.bodyBottom_m && z <= b.bodyTop_m ? rb * rb : z > b.bodyTop_m ? rf * rf : 0
  if (roof(rb) <= b.bodyTop_m || b.bodyBottom_m < b.bottomDatum_m + a || Math.sqrt(shellR2(b.upperTap_m)) <= rb)
    throw new Error('Body/tank-side upper tap does not fit selected head')
  const area = (z: number, r0 = 0, r1 = R) => z < mouth || z > b.top_m ? 0 :
    pi * Math.max(0, Math.min(shellR2(z), r1 * r1) - Math.max(obstructionR2(z), r0 * r0))
  const breaks = (radii: number[]) => unique([mouth, b.top_m, b.bottomDatum_m + a, b.top_m - a,
    b.bodyBottom_m, b.bodyTop_m, ...radii.filter(r => r >= 0 && r <= R).flatMap(r =>
      [b.bottomDatum_m + capHeight(R, r), roof(r)])])
  function volume(z0 = mouth, z1 = b.top_m, r0 = 0, r1 = R) {
    // On each cut interval the open annular area is quadratic or constant. Two-point Gauss is exact.
    const cuts = unique([Math.max(mouth, z0), Math.min(b.top_m, z1), ...breaks([r0, r1, rb, rf])])
      .filter(z => z >= Math.max(mouth, z0) && z <= Math.min(b.top_m, z1))
    let v = 0
    for (let i = 1; i < cuts.length; i++) {
      const m = (cuts[i]! + cuts[i - 1]!) / 2, h = (cuts[i]! - cuts[i - 1]!) / 2
      v += h * (area(m - h / Math.sqrt(3), r0, r1) + area(m + h / Math.sqrt(3), r0, r1))
    }
    return v
  }
  function radialFace(r: number, z0: number, z1: number) {
    if (r <= 0 || r >= R) return 0
    const cuts = unique([z0, z1, ...breaks([r])]).filter(z => z >= z0 && z <= z1)
    let h = 0
    for (let i = 1; i < cuts.length; i++) {
      const z = (cuts[i]! + cuts[i - 1]!) / 2
      if (z >= mouth && z <= b.top_m && shellR2(z) > r * r && obstructionR2(z) < r * r) h += cuts[i]! - cuts[i - 1]!
    }
    return 2 * pi * r * h
  }
  const bodyWater = pi * (b.bodyEffectiveInnerDiameter_m / 2) ** 2 * (b.bodyTop_m - b.bodyBottom_m)
  const feedWater = intrusion(R, b.feedInnerDiameter_m / 2), feedOuter = intrusion(R, rf)
  const internalBAL = bodyWater + feedWater, internalSolid = bodyVolume + feedOuter - internalBAL
  if (internalBAL >= b.distributorGroupWater_m3 || internalSolid <= 0 || internalSolid >= b.hardwareSolid_m3)
    throw new Error('Internal effective BAL/metal allocation exceeds existing budgets')
  return { R, a, mouth, roof, area, volume, radialFace, shellR2, breaks, b,
    inventories: { virtualTipEnvelope_m3: pi * R * R * (H - R / 3), removedLowerCap_m3: cap(R, capHeight(R, rm)),
      truncatedGrossDomain_m3: pi * R * R * (H - R / 3) - cap(R, capHeight(R, rm)),
      bodyExclusion_m3: bodyVolume, feedExclusion_m3: feedOuter, internalBAL_m3: internalBAL,
      effectiveBodyWater_m3: bodyWater, feedWater_m3: feedWater, internalSolid_m3: internalSolid,
      externalGroupWater_m3: b.distributorGroupWater_m3 - internalBAL,
      externalBAL_m3: b.balanceWater_m3 - internalBAL, externalHardware_m3: b.hardwareSolid_m3 - internalSolid,
      freeWater_m3: volume() } }
}

export function ringArea(b: GeometryBasis, center: number, z0: number, z1: number) {
  const r = b.holeDiameter_m / 2
  const primitive = (z: number) => {
    const y = Math.max(-r, Math.min(r, z - center))
    return y * Math.sqrt(Math.max(0, r * r - y * y)) + r * r * Math.asin(y / r)
  }
  return b.holesPerRing * (primitive(z1) - primitive(z0))
}

export function checkGeometry(b: GeometryBasis) {
  const g = tankGeometry(b), checks: { name: string; residual: number; tolerance: number }[] = []
  const check = (name: string, residual: number, tolerance = 1e-10) => {
    if (!Number.isFinite(residual) || Math.abs(residual) > tolerance) throw new Error(`${name}: ${residual}`)
    checks.push({ name, residual, tolerance })
  }
  const inv = g.inventories
  check('independent piecewise-volume versus selected free-water', inv.freeWater_m3 - b.freeWater_m3)
  check('physical gross domain occupancy closure', inv.truncatedGrossDomain_m3 - inv.bodyExclusion_m3 - inv.feedExclusion_m3 - inv.freeWater_m3)
  check('total BAL allocation unchanged', inv.internalBAL_m3 + inv.externalBAL_m3 - b.balanceWater_m3)
  check('distributor group allocation unchanged', inv.internalBAL_m3 + inv.externalGroupWater_m3 - b.distributorGroupWater_m3)
  check('hardware allocation unchanged', inv.internalSolid_m3 + inv.externalHardware_m3 - b.hardwareSolid_m3)
  check('actual bottom mouth area', g.area(g.mouth) - pi * (b.mouthDiameter_m / 2) ** 2)
  const baseZ = unique([g.mouth, b.top_m, ...g.breaks([]), b.bottomProbe_m, b.topProbe_m,
    b.bottomDatum_m + 1, b.bottomDatum_m + 2, b.upperTap_m,
    ...b.ringElevations_m.flatMap(z => [z - b.holeDiameter_m / 2, z, z + b.holeDiameter_m / 2])])
    .filter(z => z >= g.mouth && z <= b.top_m)
  const baseR = unique([0, b.mouthDiameter_m / 2, b.feedOuterDiameter_m / 2, b.bodyOuterDiameter_m / 2, g.R / 2, g.R])
  const refine = (x: number[]) => unique([...x, ...x.slice(1).map((v, i) => (v + x[i]!) / 2)])
  const partitions = [false, true].map(fine => {
    const zz = fine ? refine(baseZ) : baseZ, rr = fine ? refine(baseR) : baseR
    let total = 0, activeCells = 0, verticalFaces = 0, radialFaces = 0
    const cells = new Map<string, { i: number; j: number }>()
    for (let j = 1; j < zz.length; j++) for (let i = 1; i < rr.length; i++) {
      const v = g.volume(zz[j - 1]!, zz[j]!, rr[i - 1]!, rr[i]!)
      total += v; if (v > 1e-15) { activeCells++; cells.set(`${i}:${j}`, { i, j }) }
    }
    // Undirected geometry only: a positive shared face connects existing water, not a prescribed flow.
    const seen = new Set<string>(), queue: string[] = []
    for (const [key, { i, j }] of cells) if (j === 1 && g.area(g.mouth, rr[i - 1]!, rr[i]!) > 0) {
      seen.add(key); queue.push(key)
    }
    for (let q = 0; q < queue.length; q++) {
      const { i, j } = cells.get(queue[q]!)!
      const adjacent: [number, number, number][] = [
        [i - 1, j, g.radialFace(rr[i - 1]!, zz[j - 1]!, zz[j]!)],
        [i + 1, j, g.radialFace(rr[i]!, zz[j - 1]!, zz[j]!)],
        [i, j - 1, g.area(zz[j - 1]!, rr[i - 1]!, rr[i]!)],
        [i, j + 1, g.area(zz[j]!, rr[i - 1]!, rr[i]!)],
      ]
      for (const [ni, nj, face] of adjacent) {
        const key = `${ni}:${nj}`
        if (face > 0 && cells.has(key) && !seen.has(key)) { seen.add(key); queue.push(key) }
      }
    }
    check(`${fine ? 'fine' : 'base'} every water cell geometrically reaches mouth`, seen.size - cells.size, 0)
    const ringRecipients = [...cells].filter(([, { i, j }]) => rr[i - 1] === b.bodyOuterDiameter_m / 2 &&
      b.ringElevations_m.some(z => ringArea(b, z, zz[j - 1]!, zz[j]!) > 0))
    if (!ringRecipients.length) throw new Error('No geometric recipient cells at actual ring apertures')
    check(`${fine ? 'fine' : 'base'} every ring recipient geometrically reaches mouth`,
      ringRecipients.filter(([key]) => !seen.has(key)).length, 0)
    for (const z of zz.slice(1, -1)) {
      const sum = rr.slice(1).reduce((s, r, i) => s + g.area(z, rr[i]!, r), 0)
      check(`${fine ? 'fine' : 'base'} vertical face coverage at ${z}`, sum - g.area(z))
      verticalFaces += sum
    }
    for (const r of rr.slice(1, -1)) {
      const sum = zz.slice(1).reduce((s, z, j) => s + g.radialFace(r, zz[j]!, z), 0)
      check(`${fine ? 'fine' : 'base'} radial face coverage at ${r}`, sum - g.radialFace(r, g.mouth, b.top_m))
      radialFaces += sum
    }
    let apertures = 0
    for (const center of b.ringElevations_m) {
      const sum = zz.slice(1).reduce((s, z, j) => s + ringArea(b, center, zz[j]!, z), 0)
      check(`${fine ? 'fine' : 'base'} circular aperture vertical coverage at ${center}`, sum - b.holesPerRing * pi * (b.holeDiameter_m / 2) ** 2)
      apertures += sum
    }
    check(`${fine ? 'fine' : 'base'} full-domain cell volume`, total - b.freeWater_m3)
    return { refinement: fine ? 'midpoint refined r/z' : 'geometry aligned r/z', activeCells,
      cellsReachableFromMouth: seen.size, ringAdjacentRecipientCells: ringRecipients.length,
      volume_m3: total, totalInternalVerticalFaceArea_m2: verticalFaces, totalInternalRadialFaceArea_m2: radialFaces,
      apertureArea_m2: apertures }
  })
  return { scope: 'Selected fictional geometry and meridional partition; no flow, mixing, pressure-vessel or instrument qualification',
    shell: { radius_m: g.R, barrelArea_m2: pi * g.R ** 2, headDepth_m: g.a, barrelHeight_m: b.top_m - b.bottomDatum_m - 2 * g.a,
      lowerHeadJoin_m: b.bottomDatum_m + g.a, upperHeadJoin_m: b.top_m - g.a, mouth_m: g.mouth,
      freeFluidUpperTermination_m: g.roof(b.feedOuterDiameter_m / 2),
      mouthArea_m2: g.area(g.mouth), upperTapWallRadius_m: Math.sqrt(g.shellR2(b.upperTap_m)),
      actualTapSpan_m: b.upperTap_m - g.mouth, fullColdIndicatedDepth_m: b.upperTap_m - b.bottomDatum_m,
      upperTapBlindWater_m3: g.volume(b.upperTap_m, b.top_m) }, inventories: inv,
    planes: [b.bottomProbe_m, b.bottomDatum_m + 1, b.bottomDatum_m + 2, b.topProbe_m, b.bodyBottom_m, ...b.ringElevations_m, b.bodyTop_m, b.upperTap_m]
      .map(z => ({ elevation_m: z, freeArea_m2: g.area(z), freeWaterBelow_m3: g.volume(g.mouth, z), freeWaterAbove_m3: g.volume(z, b.top_m) })),
    rings: b.ringElevations_m.map(z => ({ elevation_m: z,
      innerCircumferentialChord_m: b.bodyEffectiveInnerDiameter_m * Math.sin(pi / b.holesPerRing),
      roofClearanceAboveUpperEdge_m: g.roof(b.bodyOuterDiameter_m / 2) - z - b.holeDiameter_m / 2,
      radialWallClearance_m: Math.sqrt(g.shellR2(z)) - b.bodyOuterDiameter_m / 2,
      upperClearanceInHoleDiameters: (g.roof(b.bodyOuterDiameter_m / 2) - z - b.holeDiameter_m / 2) / b.holeDiameter_m,
      sourceArea_m2: ringArea(b, z, z - b.holeDiameter_m / 2, z + b.holeDiameter_m / 2),
      oldOneDiameterPatchVolume_m3: pi * ((b.bodyOuterDiameter_m / 2 + b.holeDiameter_m) ** 2 - (b.bodyOuterDiameter_m / 2) ** 2) * .075 })),
    partitions, checks, numericalGeometryPassed: true, transportImplemented: false }
}

if (import.meta.main) {
  const [owner] = process.argv.slice(2)
  if (!owner || process.argv.length !== 3) throw new Error('Usage: reference-design-cmt-geometry.ts owner.md')
  const input = parseGeometryBasis(await Bun.file(owner).text())
  const hash = (s: string) => createHash('sha256').update(s).digest('hex')
  console.log(JSON.stringify({ input, inputHash: hash(JSON.stringify(input)),
    sourceHash: hash(await Bun.file(import.meta.path).text()), bunVersion: Bun.version, ...checkGeometry(input) }, null, 2))
}
