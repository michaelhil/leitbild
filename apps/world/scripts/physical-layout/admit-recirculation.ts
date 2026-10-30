import { createPwrRecirculationUnitArtifacts, createPwrRecirculationCampusArtifacts } from '../../src/packs/physical-layout/authoring/pwr-recirculation.ts'
import { admitDraftingArtifacts } from './admit-drafting-artifacts.ts'
import { physicalCoverageIssues } from '../../src/packs/physical-layout/coverage.ts'
import { compileProcessPlant, createPwrReferencePlantDefinition } from '../../src/packs/process-plant/index.ts'
import requirements from '../../src/packs/physical-layout/pwr-full-unit-rhr.requirements.json'
import campusRequirements from '../../src/packs/physical-layout/pwr-campus-rhr.requirements.json'

const check = Bun.argv.includes('--check'), directory = new URL('../../src/packs/physical-layout/', import.meta.url)
const unit = createPwrRecirculationUnitArtifacts(), campus = createPwrRecirculationCampusArtifacts(unit)
const plant = compileProcessPlant(createPwrReferencePlantDefinition({ id: 'admission:recirculation' }))
const issues = physicalCoverageIssues({ evidence: unit.coverage,
  physicalIds: [...unit.source.elements.map(element => element.id), ...unit.source.routing!.connections.map(connection => connection.id)],
  ownerSubjectIds: [...plant.graph.components.map(component => String(component.id)), ...plant.graph.links.map(link => String(link.id))], bindings: unit.bindings })
if (issues.length) throw Error(issues.join('; '))
for (const [stem, data] of [['pwr-full-unit-recirculation', unit], ['pwr-campus-recirculation', campus]] as const) {
  for (const [facet, value] of [['source', data.source], ['bindings', data.bindings], ['coverage', data.coverage]] as const) {
    const file = Bun.file(new URL(`${stem}.${facet}.json`, directory)), text = `${JSON.stringify(value, null, 2)}\n`
    if (check) { if (await file.text() !== text) throw Error(`Stale recirculation installation artifact: ${stem}.${facet}.json`) }
    else await Bun.write(file, text)
  }
}
await admitDraftingArtifacts([
  { stem: 'pwr-full-unit-recirculation', requirementStem: 'pwr-full-unit-rhr', revision: 'pwr-full-unit-20261030-r9', requirements },
  { stem: 'pwr-campus-recirculation', requirementStem: 'pwr-campus-rhr', revision: 'pwr-campus-20261030-r11', requirements: { ...campusRequirements,
    relatedMembers: campusRequirements.relatedMembers.map(member => ({ ...member, modelRef: plant.modelRef, modelDigest: plant.modelDigest })) } },
], check)
