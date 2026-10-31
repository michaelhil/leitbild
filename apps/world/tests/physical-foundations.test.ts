import { expect, test } from 'bun:test'
import { createPwrArchitectureUnitArtifacts } from '../src/packs/physical-layout/authoring/pwr-architecture.ts'
import { restorePwrFoundations } from '../src/packs/physical-layout/authoring/pwr-foundations.ts'
import { foundationSolid, type Foundation } from '../src/packs/physical-layout/native/drafting/foundation.ts'
import { solid } from '../src/packs/physical-layout/native/architecture/solid.ts'
import type { Element } from '../src/packs/physical-layout/native/architecture/source.ts'
import type { RenderObject } from '../src/packs/physical-layout/native/explorer/architecture.ts'

type FoundationElement = Element & { foundation?: Foundation }
const faces = (mesh: RenderObject, foundation: boolean) => {
  const values: number[] = [], normals: number[] = [], materials: string[] = []
  for (let at = 0; at < mesh.positions.length; at += 9) if ((mesh.materials[mesh.materialIndices[at / 3]!] === 'plinth') === foundation) {
    values.push(...mesh.positions.slice(at, at + 9)); normals.push(...mesh.normals.slice(at, at + 9)); materials.push(...mesh.materialIndices.slice(at / 3, at / 3 + 3).map(index => mesh.materials[index]!))
  }
  return { values, normals, materials }
}
const topArea = (values: ReadonlyArray<number>, z: number): number => {
  let area = 0
  for (let at = 0; at < values.length; at += 9) if ([at + 2, at + 5, at + 8].every(index => values[index] === z)) area += Math.abs((values[at + 3]! - values[at]!) * (values[at + 7]! - values[at + 1]!) - (values[at + 4]! - values[at + 1]!) * (values[at + 6]! - values[at]!)) / 2
  return area
}

test('explicit source foundations preserve every casing, rib and bolt face and restore the accepted outlines', () => {
  const { source } = createPwrArchitectureUnitArtifacts(), before = source.elements.map(element => ({ element, prior: solid(source, element) }))
  restorePwrFoundations(source)
  const changed = before.filter(({ element }) => (element as FoundationElement).foundation)
  expect(changed.map(({ element }) => element.id)).toEqual(['tg-hp', 'tg-lp-1', 'tg-lp-2', 'tg-lp-3', 'tg-generator', 'tg-exciter'])
  for (const { element, prior } of changed) {
    expect(prior).not.toBeNull()
    const mesh = foundationSolid(source, element as FoundationElement, prior!)
    expect(faces(mesh, false)).toEqual(faces(prior!, false))
    const base = (element as FoundationElement).foundation!, holes = base.holes ?? [], foundation = faces(mesh, true)
    expect(topArea(foundation.values, element.pose.position[2] + base.height)).toBeCloseTo(base.length * base.width - holes.reduce((sum, hole) => sum + hole.length * hole.width, 0), 8)
    const edges = new Map<string, number>()
    const point = (index: number) => foundation.values.slice(index, index + 3).map(value => Math.round(value * 1e6)).join(',')
    for (let at = 0; at < foundation.values.length; at += 9) for (let edge = 0; edge < 3; edge++) { const key = [point(at + edge * 3), point(at + (edge + 1) % 3 * 3)].sort().join('|'); edges.set(key, (edges.get(key) ?? 0) + 1) }
    expect([...edges.values()].every(count => count === 2)).toBe(true)
  }
})

test('LP foundation aperture derives the condenser neck rather than the shorter LP casing footprint', () => {
  const { source } = createPwrArchitectureUnitArtifacts(); restorePwrFoundations(source)
  for (const element of source.elements.filter(element => element.equipmentKind === 'lp') as FoundationElement[]) {
    const base = element.foundation!, hole = base.holes![0]!
    expect(hole.length).toBeCloseTo(6.4, 10)
    expect(hole.width).toBeCloseTo(8.6, 10)
    expect(hole.y).toBeCloseTo(1.3, 10)
    expect(base.offset).toEqual([-.35, 0])
    expect(topArea(faces(foundationSolid(source, element, solid(source, element)!), true).values, 15.3)).toBeCloseTo(53.6, 8)
  }
})
