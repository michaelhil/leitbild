import { expect, test } from 'bun:test'
import { acousticMesh } from './reference-design-cmt-acoustics.ts'
import { tankGeometry, type GeometryBasis } from './reference-design-cmt-geometry.ts'
import { hydrostaticMesh } from './reference-design-cmt-hydrostatic.ts'

const b: GeometryBasis = { freeWater_m3: 60, bottomDatum_m: 6, top_m: 12, bodyBottom_m: 11.725,
  bodyTop_m: 11.975, bodyOuterDiameter_m: .41, bodyEffectiveInnerDiameter_m: .35,
  feedOuterDiameter_m: .22, feedInnerDiameter_m: .2, mouthDiameter_m: .2,
  balanceWater_m3: 1, distributorGroupWater_m3: .05, hardwareSolid_m3: .02,
  holeDiameter_m: .06153846153846154, holesPerRing: 10, ringElevations_m: [11.925, 11.85, 11.775],
  upperTap_m: 11.95, topProbe_m: 11.25, bottomProbe_m: 6.75,
  probeRadialInset_m: .15, probeAzimuth_deg: 18 }

test('hydrostatic cut pieces use existing acoustic cells and preserve exact volume and vertical moments', () => {
  const g = tankGeometry(b)
  for (const fine of [false, true]) {
    const mesh = hydrostaticMesh(b, fine), old = acousticMesh(b, fine)
    expect(mesh.faces).toEqual(old.faces)
    expect(mesh.cells.map(({ pieces, ...c }) => c)).toEqual(old.cells)
    let total = 0
    for (const c of mesh.cells) {
      let volume = 0, moment = 0
      for (const piece of c.pieces) {
        const [a, d, e] = piece.coefficients as [number, number, number]
        const h = (piece.hi - piece.lo) / 2, m = (piece.hi + piece.lo) / 2
        volume += 2 * h * (a + e / 3)
        moment += 2 * h * (m * (a + e / 3) + h * d / 3)
        // Mid-interval samples avoid one-sided solid-cap endpoint ambiguity.
        expect(a - d / 2 + e / 4).toBeGreaterThanOrEqual(-1e-12)
        expect(a + d / 2 + e / 4).toBeGreaterThanOrEqual(-1e-12)
      }
      expect(Math.abs(volume - c.volume_m3)).toBeLessThan(1e-10)
      expect(moment / volume).toBeGreaterThanOrEqual(g.mouth)
      expect(moment / volume).toBeLessThanOrEqual(b.top_m)
      total += volume
    }
    expect(Math.abs(total - b.freeWater_m3)).toBeLessThan(1e-10)
  }
})
