import type { PhysicalSceneObject } from '../../src/core/packs/scene.ts'

/** Closed controlled test geometry, never a production component recipe. */
export const scopeRouteFixture = (): PhysicalSceneObject & { clipToScope: true; spatialPath: { points: [number, number, number][]; radius: number } } => {
  const positions: number[] = [], normals: number[] = [], sides = 16, radius = .5
  const ring = (x: number, side: number) => [x, Math.cos(side * Math.PI * 2 / sides) * radius, 1 + Math.sin(side * Math.PI * 2 / sides) * radius] as [number, number, number]
  const radial = (side: number) => [0, Math.cos(side * Math.PI * 2 / sides), Math.sin(side * Math.PI * 2 / sides)] as [number, number, number]
  const vertex = (point: number[], normal: number[]) => { positions.push(...point); normals.push(...normal) }
  for (let side = 0; side < sides; side++) {
    for (const [x, s] of [[-4, side], [-4, side + 1], [4, side + 1], [-4, side], [4, side + 1], [4, side]]) vertex(ring(x!, s!), radial(s!))
    vertex([-4, 0, 1], [-1, 0, 0]); vertex(ring(-4, side + 1), [-1, 0, 0]); vertex(ring(-4, side), [-1, 0, 0])
    vertex([4, 0, 1], [1, 0, 0]); vertex(ring(4, side), [1, 0, 0]); vertex(ring(4, side + 1), [1, 0, 0])
  }
  return { id: 'pipe', label: 'Graph-owned supply route', kind: 'pipe', levelId: 'floor', levelIds: ['floor'], inspectionLevels: [{ levelId: 'floor', low: 0, high: 3 }], positions, normals, material: 'pipe', subjectIds: ['supply-edge'], scopeIds: ['unit'], edgePolicy: 'none', bounds: { min: [-4, -.5, .5], max: [4, .5, 1.5] }, clipToScope: true, spatialPath: { points: [[-4, 0, 1], [4, 0, 1]], radius } }
}
