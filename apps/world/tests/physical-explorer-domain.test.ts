import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import normalOperation from '../src/scenarios/halden-normal-operation.scenario.json'
import powerComplex from '../src/scenarios/halden-power-complex.scenario.json'
import restoration from '../src/scenarios/halden-offsite-power-restoration.scenario.json'
import { scenarioDefinitionSchema } from '../src/core/scenarios/definition.ts'
import { compileScenarioDefinition } from '../src/core/scenarios/compiler.ts'
import { createDirectRoutingAdapter } from '../src/routing/direct-adapter.ts'
import { processPlantPack } from '../src/packs/process-plant/pack.ts'
import { electricGridPack } from '../src/packs/electric-grid/pack.ts'
import { weatherPack } from '../src/packs/weather/pack.ts'
import { physicalLayoutPack } from '../src/packs/physical-layout/pack.ts'
import { canonicalPhysicalJson, explorerLayoutDataSchema } from '../src/packs/physical-layout/model.ts'
import { currentPwrPhysicalDesignRef, pwrFullUnitPhysicalDesignRef, pwrCampusPhysicalDesignRef, pwrExplorerUnitPhysicalDesignRef, pwrExplorerCampusPhysicalDesignRef, resolvePhysicalDesign } from '../src/packs/physical-layout/design.ts'
import { describePhysicalLayoutScene, loadPhysicalLayoutScene } from '../src/packs/physical-layout/scene.ts'
import { physicalSourceFacts, physicalShapeFacts } from '../src/packs/physical-layout/applicability.ts'
import { physicalLayoutDependencyFailure } from '../src/packs/physical-layout/dependencies.ts'
import { explorerPhysicalCompilerFiles, explorerPhysicalCompilerRef } from '../src/packs/physical-layout/compiler-identity.ts'

const packs = [processPlantPack, electricGridPack, weatherPack, physicalLayoutPack]
const compile = (source: unknown) => compileScenarioDefinition(scenarioDefinitionSchema.parse(source), packs, { routing: createDirectRoutingAdapter() })
const hash = (value: unknown) => createHash('sha256').update(canonicalPhysicalJson(value)).digest('hex')

describe('Explicit explorer source admission', () => {
  test('the new compiler closure and every retained original catalog entry stay exact', async () => {
    const compiler = createHash('sha256')
    for (const name of explorerPhysicalCompilerFiles) compiler.update(name).update('\0').update(new Uint8Array(await Bun.file(new URL(`../src/packs/physical-layout/native/${name}`, import.meta.url)).arrayBuffer()))
    expect(compiler.digest('hex')).toBe(explorerPhysicalCompilerRef.digest)
    for (const [ref, profile] of [[currentPwrPhysicalDesignRef, 'turbine-island'], [pwrFullUnitPhysicalDesignRef, 'campus'], [pwrCampusPhysicalDesignRef, 'campus']] as const) {
      const retained = await resolvePhysicalDesign(ref)
      expect(retained.profile).toBe(profile)
      expect(retained.design).toEqual(ref)
    }
    expect((await resolvePhysicalDesign(pwrExplorerUnitPhysicalDesignRef)).profile).toBe('explorer')
    expect((await resolvePhysicalDesign(pwrExplorerCampusPhysicalDesignRef)).profile).toBe('explorer')
    await expect(resolvePhysicalDesign({ ...pwrExplorerUnitPhysicalDesignRef, digest: 'f'.repeat(64) })).rejects.toThrow('Unsupported or mismatched')
  })

  test('all bundled sites admit four shared geometry instances and one campus with explicit navigation grouping', async () => {
    for (const source of [normalOperation, powerComplex, restoration]) {
      const compiled = await compile(source), layouts = compiled.initialObjects.filter(object => object.packId === 'physical-layout')
      expect(layouts).toHaveLength(5)
      const descriptors = layouts.map(object => describePhysicalLayoutScene(object, compiled.initialObjects)!)
      expect(new Set(descriptors.map(descriptor => descriptor.geometryKey)).size).toBe(2)
      expect(descriptors.every(descriptor => descriptor.group?.id === 'halden-pwr-site')).toBe(true)
      expect(descriptors.every(descriptor => descriptor.scopes!.some(scope => scope.kind === 'building'))).toBe(true)
      expect(descriptors.every(descriptor => descriptor.scopes!.some(scope => scope.kind === 'space'))).toBe(true)
      for (const object of layouts) {
        const data = explorerLayoutDataSchema.parse(object.packData)
        expect(data.design).toEqual(object.id === 'layout:halden-campus' ? pwrExplorerCampusPhysicalDesignRef : pwrExplorerUnitPhysicalDesignRef)
        expect(data.coverage.representedSubjectIds).toHaveLength(object.id === 'layout:halden-campus' ? 11 : 108)
      }
    }
  })

  test('source, scope manifest and physical recipe pins are validated before a scene can load', async () => {
    const compiled = await compile(normalOperation), object = compiled.initialObjects.find(object => object.id === 'layout:halden-1')!
    const scene = await loadPhysicalLayoutScene(object), data = explorerLayoutDataSchema.parse(object.packData)
    expect(scene.scopes).toEqual(data.presentation.scopes)
    expect(scene.group).toEqual(data.group)
    expect(scene.objects.some(object => object.featureLines?.length)).toBe(true)
    expect(hash(physicalShapeFacts(scene.objects))).toBe(data.physicalApplicability.geometryDigest)
    const corrupt = structuredClone(object), changed = explorerLayoutDataSchema.parse(corrupt.packData)
    changed.presentation.scopes[0]!.label = 'Tampered scope'
    await expect(loadPhysicalLayoutScene({ ...corrupt, packData: changed })).rejects.toThrow('applicability or presentation mismatch')
    const wrongShape = structuredClone(object), shape = explorerLayoutDataSchema.parse(wrongShape.packData)
    shape.physicalApplicability.geometryDigest = 'a'.repeat(64)
    await expect(loadPhysicalLayoutScene({ ...wrongShape, packData: shape })).rejects.toThrow('Design digest mismatch')
  })

  test('material styling cannot hide physical edits and campus dependencies ignore only presentation identity', async () => {
    const compiled = await compile(normalOperation), layouts = compiled.initialObjects.filter(object => object.packId === 'physical-layout').map(object => ({ object, data: explorerLayoutDataSchema.parse(object.packData) }))
    const unit = layouts.find(layout => layout.object.id === 'layout:halden-1')!, campus = layouts.find(layout => layout.object.id === 'layout:halden-campus')!
    const styled = structuredClone(unit.data.source)
    styled.elements[0]!.material = 'steel'
    expect(hash(physicalSourceFacts(styled))).toBe(hash(physicalSourceFacts(unit.data.source)))
    styled.elements[0]!.pose.position[0] += 0.1
    expect(hash(physicalSourceFacts(styled))).not.toBe(hash(physicalSourceFacts(unit.data.source)))
    const visualRevision = layouts.map(layout => layout !== unit ? layout : { ...layout, data: { ...layout.data, design: { ...layout.data.design, digest: 'f'.repeat(64) } } })
    expect(physicalLayoutDependencyFailure(campus.data, visualRevision)).toBeNull()
    const physicalRevision = layouts.map(layout => layout !== unit ? layout : { ...layout, data: { ...layout.data, physicalApplicability: { ...layout.data.physicalApplicability, digest: 'f'.repeat(64) } } })
    expect(physicalLayoutDependencyFailure(campus.data, physicalRevision)).toContain('physical configuration')
    const rotated = layouts.map(layout => layout !== unit ? layout : { ...layout, data: { ...layout.data, placement: { ...layout.data.placement, bearing: 90 } } })
    expect(physicalLayoutDependencyFailure(campus.data, rotated)).toContain('physical configuration')
  })
})
