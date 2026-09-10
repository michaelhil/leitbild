import { expect, test } from 'bun:test'
import { acousticCoordinates } from './reference-design-cmt-acoustics.ts'
import { hydrostaticMesh } from './reference-design-cmt-hydrostatic.ts'
import { reconstructionMesh } from './reference-design-cmt-reconstruction.ts'
import { tankGeometry, type GeometryBasis } from './reference-design-cmt-geometry.ts'

const b: GeometryBasis = { freeWater_m3: 60, bottomDatum_m: 6, top_m: 12, bodyBottom_m: 11.725,
  bodyTop_m: 11.975, bodyOuterDiameter_m: .41, bodyEffectiveInnerDiameter_m: .35,
  feedOuterDiameter_m: .22, feedInnerDiameter_m: .2, mouthDiameter_m: .2,
  balanceWater_m3: 1, distributorGroupWater_m3: .05, hardwareSolid_m3: .02,
  holeDiameter_m: .06153846153846154, holesPerRing: 10, ringElevations_m: [11.925, 11.85, 11.775],
  upperTap_m: 11.95, topProbe_m: 11.25, bottomProbe_m: 6.75 }

test('reconstruction pressure traces use actual open faces without changing material or acoustic geometry', () => {
  const g = tankGeometry(b)
  for (const fine of [false, true]) {
    const mesh = reconstructionMesh(b, fine), old = hydrostaticMesh(b, fine), { rr, zz } = acousticCoordinates(b, fine)
    expect(mesh.cells).toEqual(old.cells)
    expect(mesh.faces.map(({ sampleHeights_m, ...f }) => f)).toEqual(old.faces)
    for (const face of mesh.faces) {
      const cell = mesh.cells[face.left]!, next = mesh.cells[face.right]!
      expect(face.sampleHeights_m.length).toBeGreaterThan(0)
      if (face.direction === 1) {
        expect(face.sampleHeights_m).toEqual([zz[cell.zIndex]!])
        expect(next.zIndex).toBe(cell.zIndex + 1)
      } else {
        const r = rr[cell.rIndex]!, heights = face.sampleHeights_m
        let measuredArea = 0
        for (let i = 1; i < heights.length; i++) measuredArea += g.radialFace(r, heights[i - 1]!, heights[i]!)
        expect(Math.abs(measuredArea - face.area_m2)).toBeLessThan(1e-10)
        for (const z of heights) {
          expect(z).toBeGreaterThanOrEqual(zz[cell.zIndex - 1]!)
          expect(z).toBeLessThanOrEqual(zz[cell.zIndex]!)
          expect(g.shellR2(z) - r * r).toBeGreaterThanOrEqual(-1e-12)
        }
      }
    }
  }
})
