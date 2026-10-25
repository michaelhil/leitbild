import { createHash } from 'node:crypto'
import { explorerPhysicalCompilerFiles, explorerPhysicalCompilerRef } from '../../src/packs/physical-layout/compiler-identity.ts'
import { canonicalPhysicalJson, physicalCorrespondenceSchema, physicalPresentationSchema } from '../../src/packs/physical-layout/model.ts'
import { physicalCatalogContent, physicalCatalogManifestSchema, type PhysicalCatalogManifest } from '../../src/packs/physical-layout/catalog-manifest.ts'
import { physicalCoverageEvidenceSchema, physicalCoverageIssues } from '../../src/packs/physical-layout/coverage.ts'
import { physicalExplorerRequirementsSchema } from '../../src/packs/physical-layout/requirements.ts'
import { physicalSourceSchema } from '../../src/packs/physical-layout/native/explorer/source.ts'
import { compilePhysicalScene } from '../../src/packs/physical-layout/native/explorer/compile-scene.ts'
import { physicalApplicabilityContent, physicalShapeFacts, physicalSourceFacts } from '../../src/packs/physical-layout/applicability.ts'

const directory = new URL('../../src/packs/physical-layout/', import.meta.url)
const read = (name: string): Promise<unknown> => Bun.file(new URL(name, directory)).json()
const hash = (value: unknown): string => createHash('sha256').update(canonicalPhysicalJson(value)).digest('hex')
const compiler = createHash('sha256')
for (const name of explorerPhysicalCompilerFiles) compiler.update(name).update('\0').update(new Uint8Array(await Bun.file(new URL(`native/${name}`, directory)).arrayBuffer()))
if (compiler.digest('hex') !== explorerPhysicalCompilerRef.digest) throw new Error('Installed explorer compiler differs from its exact admitted identity')
const check = Bun.argv.includes('--check'), outputs: Array<{ name: string; value: unknown }> = []
let unit: Extract<PhysicalCatalogManifest, { profile: 'explorer' }> | undefined
for (const stem of ['pwr-full-unit-explorer', 'pwr-campus-explorer']) {
  const source = physicalSourceSchema.parse(await read(`${stem}.source.json`))
  const bindings = physicalCorrespondenceSchema.array().parse(await read(`${stem}.bindings.json`))
  const coverage = physicalCoverageEvidenceSchema.parse(await read(`${stem}.coverage.json`))
  const issues = physicalCoverageIssues({ evidence: coverage, physicalIds: source.elements.map(element => element.id), ownerSubjectIds: coverage.dispositions.map(entry => entry.subjectId), bindings })
  if (issues.length) throw new Error(`${stem}: ${issues.join('; ')}`)
  let requirements
  if (unit === undefined) requirements = physicalExplorerRequirementsSchema.parse(await read(`${stem}.requirements.json`))
  else {
    const { relatedMembers, ...old } = await read('pwr-campus.requirements.json') as { relatedMembers: Array<Record<string, unknown>> }
    requirements = physicalExplorerRequirementsSchema.parse({ ...old, relatedMembers: relatedMembers.map(({ physicalLayout: _old, ...member }) => ({ ...member, physicalLayout: { physical: { id: unit!.design.id, digest: unit!.physicalApplicability.digest }, bearing: 0 } })) })
    outputs.push({ name: `${stem}.requirements.json`, value: requirements })
  }
  const scene = compilePhysicalScene('admission', { source, bindings, design: { digest: 'admission' }, owner: { objectId: 'admission' }, placement: { anchor: [0, 0], bearing: 0 }, bounds: { min: [-1e9, -1e9, -1e9], max: [1e9, 1e9, 1e9] } })
  const min: [number, number, number] = [Infinity, Infinity, Infinity], max: [number, number, number] = [-Infinity, -Infinity, -Infinity]
  for (const object of scene.objects) for (let i = 0; i < object.positions.length; i++) { const axis = i % 3; min[axis] = Math.min(min[axis]!, object.positions[i]!); max[axis] = Math.max(max[axis]!, object.positions[i]!) }
  const presentation = physicalPresentationSchema.parse({ scopes: scene.scopes, layers: scene.layers })
  const physicalApplicability = { sourceDigest: hash(physicalSourceFacts(source)), geometryDigest: hash(physicalShapeFacts(scene.objects)), digest: '' }
  const content = { profile: 'explorer' as const, sourceDigest: hash(source), bindingDigest: hash(bindings), compiler: explorerPhysicalCompilerRef, modelRequirement: coverage.modelRequirement,
    coverageDigest: hash(coverage), requirements, physicalApplicability, presentation, presentationDigest: hash(presentation) }
  physicalApplicability.digest = hash(physicalApplicabilityContent(content))
  const manifest = physicalCatalogManifestSchema.parse({ ...content, bounds: { min, max }, design: { id: source.id, revision: `${source.id}-20261025-r2`, digest: hash(physicalCatalogContent(content)) } })
  if (manifest.profile !== 'explorer') throw new Error('Unexpected explorer admission profile')
  if (!unit) unit = manifest
  outputs.push({ name: `${stem}.design.json`, value: manifest })
  console.log(`${stem}: ${manifest.design.digest}; physical ${physicalApplicability.digest}; ${scene.objects.length} objects`)
}
for (const output of outputs) {
  const path = new URL(output.name, directory), text = `${JSON.stringify(output.value, null, 2)}\n`
  if (check) { if (await Bun.file(path).text() !== text) throw new Error(`Stale explorer admission: ${output.name}`) }
  else await Bun.write(path, text)
}
