import { createPwrRhrUnitArtifacts, createPwrRhrCampusArtifacts } from '../../src/packs/physical-layout/authoring/pwr-rhr.ts'
import { admitDraftingArtifacts } from './admit-drafting-artifacts.ts'
import { physicalCoverageIssues } from '../../src/packs/physical-layout/coverage.ts'
import { compileProcessPlant, createPwrReferencePlantDefinition } from '../../src/packs/process-plant/index.ts'
import requirements from '../../src/packs/physical-layout/pwr-full-unit-operator.requirements.json'
import campusRequirements from '../../src/packs/physical-layout/pwr-campus-operator.requirements.json'

const check = Bun.argv.includes('--check'), directory = new URL('../../src/packs/physical-layout/', import.meta.url)
const unit = createPwrRhrUnitArtifacts(), campus = createPwrRhrCampusArtifacts(unit)
const plant = compileProcessPlant(createPwrReferencePlantDefinition({ id: 'admission:rhr' }))
const issues = physicalCoverageIssues({ evidence: unit.coverage,
  physicalIds: [...unit.source.elements.map(element => element.id), ...unit.source.routing!.connections.map(connection => connection.id)],
  ownerSubjectIds: [...plant.graph.components.map(component => String(component.id)), ...plant.graph.links.map(link => String(link.id))], bindings: unit.bindings })
if (issues.length) throw Error(issues.join('; '))
for (const [stem, data] of [['pwr-full-unit-rhr', unit], ['pwr-campus-rhr', campus]] as const) {
  for (const [facet, value] of [['source', data.source], ['bindings', data.bindings], ['coverage', data.coverage]] as const) {
    const file = Bun.file(new URL(`${stem}.${facet}.json`, directory)), text = `${JSON.stringify(value, null, 2)}\n`
    if (check) { if (await file.text() !== text) throw Error(`Stale RHR installation artifact: ${stem}.${facet}.json`) }
    else await Bun.write(file, text)
  }
}
await admitDraftingArtifacts([
  { stem: 'pwr-full-unit-rhr', requirementStem: 'pwr-full-unit-operator', revision: 'pwr-full-unit-20261029-r8', requirements },
  { stem: 'pwr-campus-rhr', requirementStem: 'pwr-campus-operator', revision: 'pwr-campus-20261029-r10', requirements: { ...campusRequirements,
    relatedMembers: campusRequirements.relatedMembers.map(member => ({ ...member, modelRef: plant.modelRef, modelDigest: plant.modelDigest })) } },
], check)
