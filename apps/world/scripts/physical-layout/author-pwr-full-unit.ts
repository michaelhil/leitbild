import { createPwrFullUnitPhysicalArtifacts } from '../../src/packs/physical-layout/authoring/pwr-full-unit.ts'
import { compileProcessPlant } from '../../src/packs/process-plant/plant-compiler.ts'
import { createPwrReferencePlantDefinition } from '../../src/packs/process-plant/plant-definitions.ts'

const outputs = createPwrFullUnitPhysicalArtifacts()
const plant = compileProcessPlant(createPwrReferencePlantDefinition({ id: 'plant:physical-authoring-check', loopCount: 4 }))
if (outputs.coverage.modelRequirement.modelDigest !== plant.modelDigest) throw new Error('The authored PWR model requirement is stale; re-admission is required')
const expected = plant.sourceGraph.components.map(component => String(component.id)).sort()
const actual = outputs.coverage.dispositions.map(row => row.subjectId).sort()
if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`Coverage does not partition the current owner graph. Missing: ${expected.filter(id => !actual.includes(id)).join(', ')}; extra: ${actual.filter(id => !expected.includes(id)).join(', ')}`)
const directory = new URL('../../src/packs/physical-layout/', import.meta.url)
for (const facet of ['source', 'bindings', 'coverage'] as const) {
  const path = new URL(`pwr-full-unit.${facet}.json`, directory), text = `${JSON.stringify(outputs[facet], null, 2)}\n`
  if (process.argv.includes('--check')) {
    if (await Bun.file(path).text() !== text) throw new Error(`Generated ${facet} differs; edit the arrangement and regenerate its artifacts`)
  } else await Bun.write(path, text)
}
console.log(`PWR arrangement checked: ${outputs.source.elements.length} elements, ${outputs.bindings.length} correspondences, ${actual.length} dispositions`)
