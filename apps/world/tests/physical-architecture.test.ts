import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import normalOperation from '../src/scenarios/halden-normal-operation.scenario.json'
import powerComplex from '../src/scenarios/halden-power-complex.scenario.json'
import restoration from '../src/scenarios/halden-offsite-power-restoration.scenario.json'
import { scenarioDefinitionSchema } from '../src/core/scenarios/definition.ts'
import { compileScenarioDefinition } from '../src/core/scenarios/compiler.ts'
import { packPhysicalSceneSchema } from '../src/core/packs/scene.ts'
import { createDirectRoutingAdapter } from '../src/routing/direct-adapter.ts'
import { processPlantPack } from '../src/packs/process-plant/pack.ts'
import { electricGridPack } from '../src/packs/electric-grid/pack.ts'
import { weatherPack } from '../src/packs/weather/pack.ts'
import { physicalLayoutPack } from '../src/packs/physical-layout/pack.ts'
import { architecturePhysicalCompilerFiles, architecturePhysicalCompilerRef } from '../src/packs/physical-layout/compiler-identity.ts'
import { canonicalPhysicalJson, architectureLayoutDataSchema } from '../src/packs/physical-layout/model.ts'
import { pwrArchitectureUnitPhysicalDesignRef, pwrArchitectureCampusPhysicalDesignRef, pwrExplorerUnitPhysicalDesignRef, resolvePhysicalDesign } from '../src/packs/physical-layout/design.ts'
import { createPwrArchitectureUnitArtifacts } from '../src/packs/physical-layout/authoring/pwr-architecture.ts'
import { physicalSourceSchema, physicalSourceFacts } from '../src/packs/physical-layout/native/architecture/source.ts'
import { compilePhysicalObjects, compilePlanAnnotations, compilePhysicalScene } from '../src/packs/physical-layout/native/architecture/compile-scene.ts'
import { solid } from '../src/packs/physical-layout/native/architecture/solid.ts'
import { physicalSceneShapeFacts } from '../src/packs/physical-layout/source-validation.ts'
import { buildVisibleMeshes } from '../src/ui/map/physical-scene/geometry.ts'
import { defaultPhysicalSceneView } from '../src/ui/map/physical-scene/types.ts'
import { compileRetainedPhysicalSource } from '../src/packs/physical-layout/source-compile.ts'
import { compilePhysicalSourceInWorker } from '../src/packs/physical-layout/source-loader.ts'
import { physicalLayoutDependencyFailure } from '../src/packs/physical-layout/dependencies.ts'

const hash = (value: unknown) => createHash('sha256').update(canonicalPhysicalJson(value)).digest('hex')
const artifacts = createPwrArchitectureUnitArtifacts()
const scene = () => compilePhysicalScene('test', { ...artifacts, design: { digest: 'test' }, owner: { objectId: 'plant:test' }, placement: { anchor: [0, 0], bearing: 0 }, bounds: { min: [-10000, -10000, -10000], max: [10000, 10000, 10000] } })
const withArchitecture = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(withArchitecture)
  if (value === null || typeof value !== 'object') return value
  const object = value as Record<string, unknown>
  if (object.type === 'site-layout') return { ...object, design: (object.design as { id: string }).id === 'pwr-campus' ? pwrArchitectureCampusPhysicalDesignRef : pwrArchitectureUnitPhysicalDesignRef }
  return Object.fromEntries(Object.entries(object).map(([key, child]) => [key, withArchitecture(child)]))
}

describe('Model-driven native architecture restoration', () => {
  test('every bundled PWR site explicitly admits the complete new unit/campus Design pair', async () => {
    for (const source of [normalOperation, powerComplex, restoration]) {
      const definition = scenarioDefinitionSchema.parse(source)
      const items = definition.packs.find(pack => pack.id === 'physical-layout')!.items
      expect(items).toHaveLength(5)
      for (const item of items) expect(item.design).toEqual(item.id === 'layout:halden-campus' ? pwrArchitectureCampusPhysicalDesignRef : pwrArchitectureUnitPhysicalDesignRef)
      const compiled = await compileScenarioDefinition(definition, [processPlantPack, electricGridPack, weatherPack, physicalLayoutPack], { routing: createDirectRoutingAdapter() })
      const layouts = compiled.initialObjects.filter(object => object.packId === 'physical-layout')
      expect(layouts).toHaveLength(5)
      for (const layout of layouts) expect(architectureLayoutDataSchema.parse(layout.packData).design).toEqual(layout.id === 'layout:halden-campus' ? pwrArchitectureCampusPhysicalDesignRef : pwrArchitectureUnitPhysicalDesignRef)
    }
  })
  test('new compiler closure is exact and previous explorer Design remains independently resolvable', async () => {
    const compiler = createHash('sha256')
    for (const name of architecturePhysicalCompilerFiles) compiler.update(name).update('\0').update(new Uint8Array(await Bun.file(new URL(`../src/packs/physical-layout/native/${name}`, import.meta.url)).arrayBuffer()))
    expect(compiler.digest('hex')).toBe(architecturePhysicalCompilerRef.digest)
    expect((await resolvePhysicalDesign(pwrExplorerUnitPhysicalDesignRef)).profile).toBe('explorer')
    expect((await resolvePhysicalDesign(pwrArchitectureUnitPhysicalDesignRef)).profile).toBe('architecture')
    expect(pwrArchitectureUnitPhysicalDesignRef).not.toEqual(pwrExplorerUnitPhysicalDesignRef)
  })

  test('authored I sections are closed section extrusions, not overlapping flange boxes', () => {
    const element = artifacts.source.elements.find(element => element.id === 'column/0/0.4')!, object = solid(artifacts.source, element)!
    expect(element.member?.kind).toBe('i-section')
    const edges = new Map<string, number>()
    for (let index = 0; index < object.positions.length; index += 9) {
      const points = [0, 3, 6].map(offset => object.positions.slice(index + offset, index + offset + 3).join(','))
      for (let edge = 0; edge < 3; edge++) { const key = [points[edge]!, points[(edge + 1) % 3]!].sort().join('/'); edges.set(key, (edges.get(key) ?? 0) + 1) }
    }
    expect([...edges.values()].every(count => count === 2)).toBe(true)
    expect(object.positions.length / 9).toBe(44)
    expect(object.bounds.max[2] - object.bounds.min[2]).toBe(31.2)
    for (const id of ['column/0/0.4', 'structure/runway/2.5', 'structure/roof-beam/0']) {
      const value = solid(artifacts.source, artifacts.source.elements.find(element => element.id === id)!)!
      let signedVolume = 0
      let outwardNormals = true
      for (let index = 0; index < value.positions.length; index += 9) {
        const [ax, ay, az, bx, by, bz, cx, cy, cz] = value.positions.slice(index, index + 9) as [number, number, number, number, number, number, number, number, number]
        signedVolume += (ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx)) / 6
        const normal = value.normals.slice(index, index + 3)
        const cross = [(by - ay) * (cz - az) - (bz - az) * (cy - ay), (bz - az) * (cx - ax) - (bx - ax) * (cz - az), (bx - ax) * (cy - ay) - (by - ay) * (cx - ax)]
        outwardNormals &&= cross.reduce((sum, coordinate, axis) => sum + coordinate * normal[axis]!, 0) < 0
      }
      // Retained Y-up -> Z-up adapter supplies outward normals with opposite winding.
      expect(signedVolume).toBeLessThan(0)
      expect(outwardNormals).toBe(true)
    }
  })

  test('full source restores actual architectural detail without manufacturing operational crane state', () => {
    const compiled = scene(), objects = new Map(compiled.objects.map(object => [object.id, object]))
    for (const id of ['structure/runway/2.5', 'structure/crane/trolley', 'structure/shaftline', 'structure/bearing/30/housing', 'structure/stair/upper-east', 'structure/exhaust-transition/condenser-1']) expect(objects.has(id)).toBe(true)
    expect(compiled.objects.some(object => object.id.includes('structure/glazing/') && object.materials?.[object.materialIndices?.[0] ?? 0] === 'glass')).toBe(true)
    expect(objects.get('structure/shaftline')!.subjectIds).toEqual(['turbine'])
    expect(objects.get('structure/crane/trolley')!.subjectIds).toEqual([])
    expect(new Set(artifacts.bindings.map(binding => binding.elementId)).size).toBe(108)
  })

  test('Plan cuts a filled I section and presentation choices leave physical fingerprints unchanged', () => {
    const source = structuredClone(artifacts.source), before = hash(physicalSourceFacts(source)), objects = compilePhysicalObjects({ ...artifacts, source })
    const shape = hash(physicalSceneShapeFacts(objects)), column = source.elements.find(element => element.id === 'column/0/0.4')!
    column.planDisplay = 'projection'
    column.inspectionBoundary = { outward: [0, -1, 0] }
    expect(hash(physicalSourceFacts(source))).toBe(before)
    expect(hash(physicalSceneShapeFacts(compilePhysicalObjects({ ...artifacts, source })))).toBe(shape)
    const value = scene(), object = value.objects.find(object => object.id === column.id)!
    const mesh = buildVisibleMeshes({ ...value, objects: [object] }, { ...defaultPhysicalSceneView(value.levels), levelId: 'operating' })[0]!
    let capArea = 0
    for (let index = 0; index < mesh.vertices.length; index += 21) {
      const a = mesh.vertices.slice(index, index + 3), b = mesh.vertices.slice(index + 7, index + 10), c = mesh.vertices.slice(index + 14, index + 17)
      if ([a, b, c].every(point => Math.abs(point[2]! - 16.2) < 1e-8)) capArea += Math.abs((b[0]! - a[0]!) * (c[1]! - a[1]!) - (b[1]! - a[1]!) * (c[0]! - a[0]!)) / 2
    }
    expect(capArea).toBeCloseTo(2 * .8 * .12 + (.8 - 2 * .12) * .12, 6)
  })

  test('high bay uses authored floor volumes, not an unrelated refuelling deck height', () => {
    const compiled = scene(), crane = compiled.objects.find(object => object.id === 'structure/crane/trolley')!
    expect(crane.levelIds).toEqual(['operating'])
    expect(crane.inspectionLevels).toEqual([{ levelId: 'lower', low: 0, high: 15 }, { levelId: 'operating', low: 15, high: 31.55 }])
    expect(compiled.scopes!.find(scope => scope.id === 'building/turbine-hall')!.levelIds).toEqual(['lower', 'operating'])
    expect(compiled.scopes!.find(scope => scope.id === 'assembly/turbine-hall-crane')!.levelIds).toEqual(['operating'])
    expect(compiled.objects.find(object => object.id === 'slab/lower')!.levelIds).toContain('lower')
    expect(compiled.objects.find(object => object.id === 'slab/operating')!.levelIds).toContain('operating')
    for (const object of compiled.objects.filter(object => object.id.startsWith('structure/runway/'))) expect(Math.hypot(...object.inspectionBoundary!.outward)).toBe(1)
  })

  test('Plan labels resolve source identity, dimensions derive parameters and annotations do not alter physical applicability', () => {
    const source = structuredClone(artifacts.source), first = compilePlanAnnotations(source)
    const id = 'annotation/dimension/space/turbine-hall/length', dimension = first.find(annotation => annotation.id === id)!
    expect(dimension.kind).toBe('dimension')
    if (dimension.kind !== 'dimension') throw new Error('Missing source-derived dimension')
    expect(Math.hypot(...dimension.to.map((value, axis) => value - dimension.from[axis]!))).toBe(88)
    const before = hash(physicalSourceFacts(source)), full = hash(source)
    source.planAnnotations!.find(annotation => annotation.kind === 'label')!.layerId = 'plan-dimensions'
    expect(hash(physicalSourceFacts(source))).toBe(before)
    expect(hash(source)).not.toBe(full)
    source.elements.find(element => element.id === 'space/turbine-hall')!.dimensions!.length = 90
    const updated = compilePlanAnnotations(source).find(annotation => annotation.id === id)!
    if (updated.kind !== 'dimension') throw new Error('Missing updated dimension')
    expect(updated.to[0] - updated.from[0]).toBe(90)
    expect(hash(physicalSourceFacts(source))).not.toBe(before)
    expect(compilePhysicalObjects(artifacts).some(object => object.id.startsWith('annotation/'))).toBe(false)
  })

  test('source and delivery reject broken references, open polygons and invalid floor volumes', () => {
    const source = structuredClone(artifacts.source)
    const label = source.planAnnotations!.find(annotation => annotation.kind === 'label')!
    if (label.kind !== 'label') throw new Error('Missing label')
    label.anchor.elementId = 'does-not-exist'
    expect(physicalSourceSchema.safeParse(source).success).toBe(false)
    const compiled = scene(), hatch = compiled.planAnnotations!.find(annotation => annotation.kind === 'hatch')!
    if (hatch.kind !== 'hatch') throw new Error('Missing hatch')
    hatch.outline.pop()
    expect(packPhysicalSceneSchema.safeParse(compiled).success).toBe(false)
    const invalid = scene(); invalid.objects[0]!.inspectionLevels = [{ levelId: 'missing-floor', low: 0, high: 1 }]
    expect(packPhysicalSceneSchema.safeParse(invalid).success).toBe(false)
    const invalidScope = scene(); invalidScope.planAnnotations![0]!.scopeIds = ['missing-room']
    expect(packPhysicalSceneSchema.safeParse(invalidScope).success).toBe(false)
    const invalidLayer = scene(); invalidLayer.planAnnotations![0]!.layerId = 'missing-layer'
    expect(packPhysicalSceneSchema.safeParse(invalidLayer).success).toBe(false)
    const impossible = structuredClone(artifacts.source), guard = impossible.elements.find(element => element.member?.kind === 'guardrail')!
    if (guard.member?.kind !== 'guardrail') throw new Error('Missing guardrail')
    guard.member.postSpacing = Number.MIN_VALUE
    expect(physicalSourceSchema.safeParse(impossible).success).toBe(false)
  })

  test('the complete four-unit site admits coherently, compiles in worker and preserves independent owner bindings', async () => {
    const compiled = await compileScenarioDefinition(scenarioDefinitionSchema.parse(withArchitecture(normalOperation)), [processPlantPack, electricGridPack, weatherPack, physicalLayoutPack], { routing: createDirectRoutingAdapter() })
    const layouts = compiled.initialObjects.filter(object => object.packId === 'physical-layout').map(object => ({ object, data: architectureLayoutDataSchema.parse(object.packData) }))
    expect(layouts).toHaveLength(5)
    const unit = layouts.find(layout => layout.object.id === 'layout:halden-1')!, campus = layouts.find(layout => layout.object.id === 'layout:halden-campus')!
    expect(physicalLayoutDependencyFailure(campus.data, layouts)).toBeNull()
    const direct = await compileRetainedPhysicalSource(unit.data), worker = await compilePhysicalSourceInWorker(unit.data)
    expect(worker.objects.length).toBe(direct.objects.length)
    expect(worker.planAnnotations).toEqual(direct.planAnnotations)
    expect(worker.objects.find(object => object.id === 'structure/crane/trolley')!.inspectionLevels).toEqual(direct.objects.find(object => object.id === 'structure/crane/trolley')!.inspectionLevels)
    const corrupt = structuredClone(unit.data); corrupt.source.planAnnotations![0]!.scopeIds = ['unit']
    await expect(compileRetainedPhysicalSource(corrupt)).rejects.toThrow('source/binding digest mismatch')
  })
})
