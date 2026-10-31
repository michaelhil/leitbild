import { createHash } from 'node:crypto'
import { physicalSceneObjectSchema } from '../../src/core/packs/scene.ts'
import { campusPhysicalCompilerFiles, campusPhysicalCompilerRef, physicalCompilerFiles, physicalCompilerRef } from '../../src/packs/physical-layout/compiler-identity.ts'
import { canonicalPhysicalJson, physicalCorrespondenceSchema, turbineIslandCorrespondenceSchema } from '../../src/packs/physical-layout/model.ts'
import { physicalCatalogContent, physicalCatalogManifestSchema, type PhysicalCatalogManifest } from '../../src/packs/physical-layout/catalog-manifest.ts'
import { physicalCoverageEvidenceSchema, physicalCoverageIssues } from '../../src/packs/physical-layout/coverage.ts'
import { physicalDesignRequirementsSchema } from '../../src/packs/physical-layout/requirements.ts'
import { physicalSourceSchema as originalSource } from '../../src/packs/physical-layout/native/source.ts'
import { compilePhysicalObjects as originalObjects, physicalObjectsBounds } from '../../src/packs/physical-layout/native/compile-scene.ts'
import { physicalSourceSchema as campusSource } from '../../src/packs/physical-layout/native/campus/source.ts'
import { compilePhysicalObjects as campusObjects } from '../../src/packs/physical-layout/native/campus/compile-scene.ts'

const hash = (value: unknown): string => createHash('sha256').update(canonicalPhysicalJson(value)).digest('hex')
const directory = new URL('../../src/packs/physical-layout/', import.meta.url)
const read = (name: string): Promise<unknown> => Bun.file(new URL(name, directory)).json()
const check = Bun.argv.includes('--check')
const outputs: Array<{ stem: string; manifest: PhysicalCatalogManifest; text: string; path: URL; objects: number; triangles: number }> = []
for (const artifact of [{ files: physicalCompilerFiles, reference: physicalCompilerRef }, { files: campusPhysicalCompilerFiles, reference: campusPhysicalCompilerRef }]) {
  const bytes = createHash('sha256')
  for (const name of artifact.files) bytes.update(name).update('\0').update(new Uint8Array(await Bun.file(new URL(`native/${name}`, directory)).arrayBuffer()))
  if (bytes.digest('hex') !== artifact.reference.digest) throw new Error(`Installed compiler differs from its admitted identity: ${artifact.reference.id}`)
}
for (const spec of [
  { stem: 'pwr-turbine-island', revision: 'pwr-turbine-island-20261024-r2', profile: 'turbine-island' },
  { stem: 'pwr-full-unit', revision: 'pwr-full-unit-20261025-r1', profile: 'campus' },
  { stem: 'pwr-campus', revision: 'pwr-campus-20261025-r1', profile: 'campus' },
] as const) {
  const rawSource = await read(`${spec.stem}.source.json`)
  const bindings = physicalCorrespondenceSchema.array().parse(await read(`${spec.stem}.bindings.json`))
  const source = spec.profile === 'turbine-island' ? originalSource.parse(rawSource) : campusSource.parse(rawSource)
  const objects = spec.profile === 'turbine-island'
    ? originalObjects({ source: originalSource.parse(source), bindings: turbineIslandCorrespondenceSchema.array().parse(bindings) })
    : campusObjects({ source: campusSource.parse(source), bindings })
  for (const object of objects) physicalSceneObjectSchema.parse(object)
  if (objects.reduce((count, object) => count + object.positions.length, 0) > 6_000_000) throw new Error(`${spec.stem} exceeds the bounded scene delivery budget`)
  const sourceDigest = hash(source), bindingDigest = hash(bindings), bounds = physicalObjectsBounds(objects)
  let content
  if (spec.profile === 'turbine-island') {
    content = { profile: spec.profile, sourceDigest, bindingDigest, modelRequirement: { modelRef: 'process-plant.pwr.reference', modelDigest: '47b82339adddd913ef20d24294ae9c595b104d1c10148bcfb5943bc30aeaf3ea' }, compiler: physicalCompilerRef }
  } else {
    const coverage = physicalCoverageEvidenceSchema.parse(await read(`${spec.stem}.coverage.json`))
    const issues = physicalCoverageIssues({ evidence: coverage, physicalIds: source.elements.map(element => element.id), ownerSubjectIds: coverage.dispositions.map(entry => entry.subjectId), bindings })
    if (issues.length) throw new Error(`${spec.stem}: ${issues.join('; ')}`)
    content = { profile: spec.profile, sourceDigest, bindingDigest, modelRequirement: coverage.modelRequirement, compiler: campusPhysicalCompilerRef,
      coverageDigest: hash(coverage), requirements: physicalDesignRequirementsSchema.parse(await read(`${spec.stem}.requirements.json`)) }
  }
  const digest = hash(physicalCatalogContent(content))
  if (spec.profile === 'turbine-island' && digest !== '3ddc5ce7e37e81404c85d246b2b19bfe4cc61b847fde9f5bb8f99dca0bf9f124') throw new Error('The originally admitted turbine-island artifact changed')
  const manifest = physicalCatalogManifestSchema.parse({ ...content, bounds, design: { id: source.id, revision: spec.revision, digest } })
  const text = `${JSON.stringify(manifest, null, 2)}\n`, path = new URL(`${spec.stem}.design.json`, directory)
  outputs.push({ stem: spec.stem, manifest, text, path, objects: objects.length, triangles: objects.reduce((count, object) => count + object.positions.length / 9, 0) })
}
// Validate the whole admission set before writing any output. A unit physical
// edit requires explicit shared-site review, never automatic latest rebinding.
for (const { manifest } of outputs) if (manifest.profile === 'campus') for (const member of manifest.requirements.relatedMembers) {
  const expected = member.physicalLayout
  if (expected === undefined) continue
  const matches = outputs.filter(output => canonicalPhysicalJson(output.manifest.design) === canonicalPhysicalJson(expected.design))
  if (matches.length !== 1 || matches[0]!.manifest.modelRequirement.modelRef !== member.modelRef || matches[0]!.manifest.modelRequirement.modelDigest !== member.modelDigest) throw new Error(`Physical Design dependency needs explicit readmission: ${manifest.design.id}/${member.role}`)
  const target = matches[0]!.manifest
  if (target.profile === 'campus' && target.requirements.ownerPackId !== member.packId) throw new Error(`Physical Design dependency owner mismatch: ${manifest.design.id}/${member.role}`)
}
for (const output of outputs) {
  if (check) { if (await Bun.file(output.path).text() !== output.text) throw new Error(`Stale Design admission: ${output.stem}`) }
  else await Bun.write(output.path, output.text)
  console.log(`${output.stem}: ${output.manifest.design.digest}; ${output.objects} objects, ${output.triangles} triangles${check ? ' (checked)' : ''}`)
}
