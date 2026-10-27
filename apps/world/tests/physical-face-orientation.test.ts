import { expect, test } from 'bun:test'
import { createPwrArchitectureUnitArtifacts } from '../src/packs/physical-layout/authoring/pwr-architecture.ts'
import { restorePwrFoundations } from '../src/packs/physical-layout/authoring/pwr-foundations.ts'
import { solid } from '../src/packs/physical-layout/native/architecture/solid.ts'
import { foundationSolid, type Foundation } from '../src/packs/physical-layout/native/drafting/foundation.ts'
import { orientPhysicalFaces } from '../src/packs/physical-layout/native/drafting/orientation.ts'
import type { Element } from '../src/packs/physical-layout/native/architecture/source.ts'
import type { RenderObject } from '../src/packs/physical-layout/native/explorer/architecture.ts'

const facing = (mesh: RenderObject) => {
  let positive = 0, negative = 0
  for (let i = 0; i < mesh.positions.length; i += 9) {
    const p = mesh.positions, n = mesh.normals, a = [p[i + 3]! - p[i]!, p[i + 4]! - p[i + 1]!, p[i + 5]! - p[i + 2]!], b = [p[i + 6]! - p[i]!, p[i + 7]! - p[i + 1]!, p[i + 8]! - p[i + 2]!]
    const cross = [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!], dot = cross.reduce((sum, value, axis) => sum + value * (n[i + axis]! + n[i + 3 + axis]! + n[i + 6 + axis]!), 0)
    if (dot > 0) positive++; if (dot < 0) negative++
  }
  return { positive, negative }
}
const associations = (mesh: RenderObject) => {
  const vertices: string[] = []
  for (let i = 0; i < mesh.positions.length; i += 3) vertices.push(JSON.stringify([mesh.positions.slice(i, i + 3), mesh.normals.slice(i, i + 3), mesh.materialIndices[i / 3]]))
  return vertices.sort()
}
test('all inherited faces and explicit foundations retain the same vertex/normal/material associations with canonical outward winding', () => {
  const { source } = createPwrArchitectureUnitArtifacts(); restorePwrFoundations(source)
  let negativeBefore = 0, positiveAfter = 0
  for (const element of source.elements) {
    const prior = solid(source, element)
    if (!prior) continue
    const foundation = foundationSolid(source, element as Element & { foundation?: Foundation }, prior), result = orientPhysicalFaces(foundation)
    negativeBefore += facing(foundation).negative; positiveAfter += facing(result).positive
    expect(facing(result).negative).toBe(0)
    expect(associations(result)).toEqual(associations(foundation))
    expect(result.linePositions).toBe(foundation.linePositions)
    expect(result.bounds).toBe(foundation.bounds)
    expect(orientPhysicalFaces(result)).toBe(result)
  }
  expect(negativeBefore).toBeGreaterThan(100_000)
  expect(positiveAfter).toBeGreaterThan(100_000)
})
