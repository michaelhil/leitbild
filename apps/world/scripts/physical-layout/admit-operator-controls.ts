import { admitDraftingArtifacts } from './admit-drafting-artifacts.ts'
import { compileProcessPlant, createPwrReferencePlantDefinition } from '../../src/packs/process-plant/index.ts'
import { physicalCoverageEvidenceSchema, physicalCoverageIssues } from '../../src/packs/physical-layout/coverage.ts'
import { physicalSourceSchema } from '../../src/packs/physical-layout/native/drafting/source.ts'
import unitSourceData from '../../src/packs/physical-layout/pwr-full-unit-manifold.source.json'
import unitBindings from '../../src/packs/physical-layout/pwr-full-unit-manifold.bindings.json'
import unitCoverageData from '../../src/packs/physical-layout/pwr-full-unit-manifold.coverage.json'
import campusRequirements from '../../src/packs/physical-layout/pwr-campus-manifold.requirements.json'

// A new model admission shares exact retained architecture. No source, route,
// drawing, material, occurrence or compiler is regenerated or reinterpreted.
const plant = compileProcessPlant(createPwrReferencePlantDefinition({ id: 'admission:operator-controls' }))
const source = physicalSourceSchema.parse(unitSourceData)
const coverage = physicalCoverageEvidenceSchema.parse({ ...unitCoverageData,
  modelRequirement: { modelRef: plant.modelRef, modelDigest: plant.modelDigest },
  evidence: { ...unitCoverageData.evidence, origin: `${unitCoverageData.evidence.origin} Re-admitted 29 October 2026 for explicit operator controller mode/target variables and resolved component-library identity. Exact R6 architectural source, correspondence and accepted routes are retained.` },
})
const issues = physicalCoverageIssues({ evidence: coverage,
  physicalIds: [...source.elements.map(element => element.id), ...source.routing!.connections.map(connection => connection.id)],
  ownerSubjectIds: [...plant.graph.components.map(component => String(component.id)), ...plant.graph.links.map(link => String(link.id))],
  bindings: unitBindings,
})
if (issues.length) throw new Error(issues.join('; '))
const terminals = new Map(source.routing!.terminals.map(terminal => [terminal.id, terminal]))
for (const route of source.routing!.connections) {
  const edge = plant.graph.links.find(link => String(link.id) === route.graphConnectionId)
  const from = terminals.get(route.from)!, to = terminals.get(route.to)!
  if (!edge || from.subjectId !== String(plant.graph.components[edge.fromComponentIndex]!.id) || from.port !== edge.fromPortName
    || to.subjectId !== String(plant.graph.components[edge.toComponentIndex]!.id) || to.port !== edge.toPortName) {
    throw new Error(`Retained physical route no longer matches exact graph endpoints: ${route.id}`)
  }
}
await admitDraftingArtifacts([
  { stem: 'pwr-full-unit-operator', retainedStem: 'pwr-full-unit-manifold', requirementStem: 'pwr-full-unit-manifold', revision: 'pwr-full-unit-20261029-r7', coverage },
  { stem: 'pwr-campus-operator', retainedStem: 'pwr-campus-manifold', requirementStem: 'pwr-campus-manifold', revision: 'pwr-campus-20261029-r9',
    requirements: { ...campusRequirements, relatedMembers: campusRequirements.relatedMembers.map(member => ({ ...member, modelRef: plant.modelRef, modelDigest: plant.modelDigest })) },
  },
], Bun.argv.includes('--check'))
