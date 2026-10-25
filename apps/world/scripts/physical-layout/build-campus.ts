import { composeCampus } from '../../src/packs/physical-layout/native/campus/author-campus.ts'
import arrangement from '../../src/packs/physical-layout/pwr-campus.arrangement.json'

const outputs = composeCampus(arrangement)
const check = process.argv.includes('--check')
for (const kind of ['source', 'bindings', 'coverage'] as const) {
  const path = new URL(`../../src/packs/physical-layout/pwr-campus.${kind}.json`, import.meta.url)
  const expected = `${JSON.stringify(outputs[kind], null, 2)}\n`
  if (check) {
    if (await Bun.file(path).text() !== expected) throw new Error(`Regenerate the accepted campus ${kind} artifact from pwr-campus.arrangement.json`)
  } else await Bun.write(path, expected)
}
console.log(`${check ? 'Checked' : 'Generated'} campus: ${outputs.source.elements.length} elements, ${outputs.bindings.length} correspondences, ${outputs.coverage.dispositions.length} graph subjects`)
