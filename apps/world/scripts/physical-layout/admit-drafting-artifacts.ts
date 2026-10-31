import { createHash } from 'node:crypto'
import { draftingPhysicalCompilerFiles, draftingPhysicalCompilerRef } from '../../src/packs/physical-layout/compiler-identity.ts'
import { canonicalPhysicalJson, physicalCorrespondenceSchema, physicalPresentationSchema } from '../../src/packs/physical-layout/model.ts'
import { physicalCatalogContent, physicalCatalogManifestSchema, type PhysicalCatalogManifest } from '../../src/packs/physical-layout/catalog-manifest.ts'
import { physicalCoverageEvidenceSchema, physicalCoverageIssues, type PhysicalCoverageEvidence } from '../../src/packs/physical-layout/coverage.ts'
import { physicalExplorerRequirementsSchema } from '../../src/packs/physical-layout/requirements.ts'
import { physicalSourceSchema, physicalSourceFacts, type V3 } from '../../src/packs/physical-layout/native/drafting/source.ts'
import { compilePhysicalScene } from '../../src/packs/physical-layout/native/drafting/compile-scene.ts'
import { physicalApplicabilityContent } from '../../src/packs/physical-layout/applicability.ts'
import { physicalSceneShapeFacts } from '../../src/packs/physical-layout/source-validation.ts'
import {physicalSourceDependencyFailure} from '../../src/packs/physical-layout/source-dependencies.ts'

const directory = new URL('../../src/packs/physical-layout/', import.meta.url)
const read = (name: string): Promise<unknown> => Bun.file(new URL(name, directory)).json()
const hash = (value: unknown): string => createHash('sha256').update(canonicalPhysicalJson(value)).digest('hex')
const compiler = createHash('sha256')
for (const name of draftingPhysicalCompilerFiles) compiler.update(name).update('\0').update(new Uint8Array(await Bun.file(new URL(`native/${name}`, directory)).arrayBuffer()))
if (compiler.digest('hex') !== draftingPhysicalCompilerRef.digest) throw new Error('Installed drafting compiler differs from its exact admitted identity')
export interface DraftingAdmissionInput {
  stem:string; requirementStem:string; revision:string
  /** An exact retained source/binding facet can be shared by a new admission. */
  retainedStem?: string
  coverage?: PhysicalCoverageEvidence
  requirements?: unknown
}
/** Offline admission only: exact retained compiler with explicit artifact and revision inputs. */
export const admitDraftingArtifacts=async(inputs:ReadonlyArray<DraftingAdmissionInput>,check:boolean):Promise<void>=>{
const outputs: Array<{ name: string; value: unknown }> = []
let unit: Extract<PhysicalCatalogManifest, { profile: 'drafting' }> | undefined
for (const {stem,requirementStem,revision,retainedStem,coverage:providedCoverage,requirements:providedRequirements} of inputs) {
  const facets = retainedStem ?? stem
  const source = physicalSourceSchema.parse(await read(`${facets}.source.json`)), bindings = physicalCorrespondenceSchema.array().parse(await read(`${facets}.bindings.json`)), coverage = physicalCoverageEvidenceSchema.parse(providedCoverage ?? await read(`${facets}.coverage.json`))
  if (providedCoverage !== undefined) outputs.push({ name: `${stem}.coverage.json`, value: coverage })
  const issues = physicalCoverageIssues({ evidence: coverage, physicalIds: [...source.elements.map(element => element.id),...(source.routing?.connections.map(connection=>connection.id)??[])], ownerSubjectIds: coverage.dispositions.map(entry => entry.subjectId), bindings })
  if (issues.length) throw new Error(`${stem}: ${issues.join('; ')}`)
  const previous = (providedRequirements ?? await read(`${requirementStem}.requirements.json`)) as { relatedMembers: Array<Record<string, unknown>> }
  const dependencyFailure=physicalSourceDependencyFailure(source.sourceDependencies??[],unit?previous.relatedMembers.map(member=>({role:String(member.role),sourceId:unit!.design.id,physicalSourceDigest:unit!.physicalApplicability.sourceDigest,physicalShapeDigest:unit!.physicalApplicability.geometryDigest})):[])
  if(dependencyFailure)throw Error(`${stem}: ${dependencyFailure}`)
  const requirements = physicalExplorerRequirementsSchema.parse(unit === undefined ? {...previous,...(source.routing?{includeGraphConnections:true}:{})} : { ...previous, relatedMembers: previous.relatedMembers.map(({ physicalLayout: _previous, ...member }) => ({ ...member, physicalLayout: { physical: { id: unit!.design.id, digest: unit!.physicalApplicability.digest }, bearing: 0 } })) })
  outputs.push({ name: `${stem}.requirements.json`, value: requirements })
  const scene = compilePhysicalScene('admission', { source, bindings, design: { digest: 'admission' }, owner: { objectId: 'admission' }, placement: { anchor: [0, 0], bearing: 0 }, bounds: { min: [-1e9, -1e9, -1e9], max: [1e9, 1e9, 1e9] } })
  const min: V3 = [Infinity, Infinity, Infinity], max: V3 = [-Infinity, -Infinity, -Infinity]
  const include = (point: ArrayLike<number>): void => { for (const axis of [0, 1, 2] as const) { min[axis] = Math.min(min[axis], point[axis]!); max[axis] = Math.max(max[axis], point[axis]!) } }
  for (const object of scene.objects) for (let index = 0; index < object.positions.length; index += 3) include(object.positions.slice(index, index + 3))
  const presentation = physicalPresentationSchema.parse({ scopes: scene.scopes, layers: scene.layers })
  const physicalApplicability = { sourceDigest: hash(physicalSourceFacts(source)), geometryDigest: hash(physicalSceneShapeFacts(scene.objects)), digest: '' }
  const content = { profile: 'drafting' as const, sourceDigest: hash(source), bindingDigest: hash(bindings), compiler: draftingPhysicalCompilerRef, modelRequirement: coverage.modelRequirement, coverageDigest: hash(coverage), requirements, physicalApplicability, presentation, presentationDigest: hash(presentation) }
  physicalApplicability.digest = hash(physicalApplicabilityContent(content))
  const manifest = physicalCatalogManifestSchema.parse({ ...content, bounds: { min, max }, design: { id: source.id, revision, digest: hash(physicalCatalogContent(content)) } })
  if (manifest.profile !== 'drafting') throw new Error('Unexpected drafting admission profile')
  if (!unit) unit = manifest
  outputs.push({ name: `${stem}.design.json`, value: manifest })
  console.log(`${stem}: ${manifest.design.digest}; physical ${physicalApplicability.digest}; ${scene.objects.length} objects; ${scene.planAnnotations?.length ?? 0} Plan annotations`)
}
for (const output of outputs) {
  const path = new URL(output.name, directory), text = `${JSON.stringify(output.value, null, 2)}\n`
  if (check) { if (await Bun.file(path).text() !== text) throw new Error(`Stale drafting admission: ${output.name}`) }
  else await Bun.write(path, text)
}

}
